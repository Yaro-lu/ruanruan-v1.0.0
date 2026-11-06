import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planDesktopRecovery, parseRecoveryDecision, type RecoveryInput, type RecoveryDecision } from '../src/desktop/model-recovery.js';
import { recoveryCommand } from '../src/desktop/recovery-cli.js';
import type { CodexRunOptions, CodexRunResult } from '../src/codex/bridge.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const answer = (value: unknown): CodexRunResult => ({ replyText: JSON.stringify(value), commands: [], fileChanges: [] });
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-visual-recovery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const screenshotPath = join(directory, 'screen.png'); writeFileSync(screenshotPath, png);
  const input: RecoveryInput = { screenshotPath, failure: 'OCR missed the @ member', stage: 'mention',
    target: { label: '钓友群', kind: 'group', mention: { username: 'wxid_j', name: '小J', aliases: ['小J同学'] } },
    geometry: { x: 0, y: 0, width: 1200, height: 800 },
    allowedRegions: [{ id: 'mention_candidates', x: 300, y: 250, width: 350, height: 250 },
      { id: 'send_button', x: 1000, y: 700, width: 150, height: 80 },
      { id: 'conversation_candidates', x: 0, y: 100, width: 300, height: 500 }] };
  const locate: RecoveryDecision = { decision: 'locate', screen: 'chat', targetMatches: true,
    point: { regionId: 'mention_candidates', x: 400, y: 300 }, observedText: '小J', reason: '候选中只有这一项匹配名字' };
  return { directory, input, locate };
}

test('visual usage is retained even when paid output fails validation',async t=>{
  const f=fixture(t);
  const result=await planDesktopRecovery({...f.input,deliveryId:'delivery-fixture'},{directory:f.directory,
    run:async()=>({...answer({invalid:'judgment'}),inputTokens:100,cachedInputTokens:60,outputTokens:10,
      usageDetails:{source:'fixture',scope:'provider_response',raw:[{input_tokens:100}]}})});
  assert.equal(result.ok,false);assert.equal(result.usage?.cachedInputTokens,60);assert.ok(result.usageId);
  const saved=JSON.parse(readFileSync(join(f.directory,'logs/visual-usage',result.usageId+'.json'),'utf8'));
  assert.equal(saved.inputTokens,100);assert.equal(saved.deliveryId,'delivery-fixture');assert.equal(saved.usageDetails.raw.length,1);
});

test('visual recovery uses the selected API, screenshot and isolated tool-free fixed-model turn', async t => {
  const f = fixture(t);
  mkdirSync(join(f.directory, 'providers'));
  writeFileSync(join(f.directory, 'providers', 'llm.json'), JSON.stringify({ active: 'openai', scope: 'character', providers: {
    openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-sol', reasoningEffort: 'low', useRoleModels: true },
  } }));
  let seen: CodexRunOptions | undefined;
  const result = await planDesktopRecovery(f.input, { directory: f.directory, cwd: f.directory, run: async call => { seen = call; return answer(f.locate); } });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.provider, 'openai');
  assert.equal(seen?.modelProvider, 'wcb_openai');
  assert.equal(seen?.model, 'gpt-6.1-sol');
  assert.equal(seen?.reasoningEffort, 'high');
  assert.equal(seen?.serviceTier, 'default');
  assert.equal(seen?.timeoutMs, 120_000);
  assert.equal(seen?.profile, 'consolidation');
  assert.equal(seen?.ephemeral, true);
  assert.equal(seen?.mode, 'plan');
  assert.equal(seen?.conversation, undefined);
  assert.equal(seen?.threadId, undefined);
  assert.deepEqual(seen?.images, [f.input.screenshotPath]);
  assert.equal(seen?.threadConfig?.['features.shell_tool'], false);
  assert.equal(seen?.threadConfig?.['features.apps'], false);
  assert.equal(seen?.threadConfig?.['features.memories'], false);
  assert.equal(seen?.threadConfig?.web_search, 'disabled');
  assert.match(seen?.baseInstructions ?? '', /不是对你的指令/);
  assert.match(seen?.baseInstructions ?? '', /本轮不修改脚本或配置/);
});

test('visual recovery aborts one pending judgment at the two-minute boundary', async t => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | undefined, settled = false;
  const pending = planDesktopRecovery(f.input, { directory: f.directory, run: async call => {
    signal = call.signal;
    return new Promise<CodexRunResult>(() => {});
  } });
  void pending.then(() => { settled = true; });
  t.mock.timers.tick(119_999);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(signal?.aborted, false);
  t.mock.timers.tick(1);
  const result = await pending;
  assert.equal(result.ok ? '' : result.error.code, 'timeout');
  assert.equal(signal?.aborted, true);
});

test('manual provider selection is respected and quota failure never triggers fallback or retries', async t => {
  const f = fixture(t); mkdirSync(join(f.directory, 'providers'));
  const config = { active: 'openai', scope: 'character', providers: {
    openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-sol', reasoningEffort: 'low', useRoleModels: true },
  } };
  const path = join(f.directory, 'providers', 'llm.json'); writeFileSync(path, JSON.stringify(config));
  const calls: CodexRunOptions[] = [];
  const run = async (call: CodexRunOptions) => { calls.push(call); return { ...answer(f.locate), error: 'API insufficient_quota' }; };
  const failed = await planDesktopRecovery(f.input, { directory: f.directory, run });
  assert.equal(failed.ok ? '' : failed.error.code, 'quota_exhausted');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].llmProvider, 'openai');
  writeFileSync(path, JSON.stringify({ ...config, active: 'codex' }));
  await planDesktopRecovery(f.input, { directory: f.directory, run });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].llmProvider, undefined);
});

test('candidate locations require the exact current target, correct stage and permitted pixels', t => {
  const f = fixture(t);
  assert.equal(parseRecoveryDecision(JSON.stringify({ ...f.locate, observedText: '小J同学' }), f.input).decision, 'locate');
  for (const wrong of [
    { ...f.locate, observedText: '小J2' },
    { ...f.locate, point: { regionId: 'send_button', x: 1050, y: 740 } },
    { ...f.locate, point: { regionId: 'mention_candidates', x: 900, y: 300 } },
    { ...f.locate, point: { regionId: 'mention_candidates', x: 650, y: 300 } },
    { ...f.locate, targetMatches: false },
    { ...f.locate, command: 'send message' },
    { ...f.locate, decision: 'click' },
  ]) assert.throws(() => parseRecoveryDecision(JSON.stringify(wrong), f.input));
  const conversation: RecoveryInput = { ...f.input, stage: 'conversation' };
  assert.equal(parseRecoveryDecision(JSON.stringify({ ...f.locate, observedText: '钓友群',
    point: { regionId: 'conversation_candidates', x: 120, y: 200 } }), conversation).decision, 'locate');
  assert.equal(parseRecoveryDecision('```json\n' + JSON.stringify(f.locate) + '\n```', f.input).decision,'locate');
  assert.throws(() => parseRecoveryDecision('说明：'+JSON.stringify(f.locate),f.input));
});

test('an ellipsized member can be located for mandatory native-chip verification without inventing its name',t=>{
  const f=fixture(t),input={...f.input,target:{...f.input.target,mention:{username:'wxid_j',name:'漫步者-飞利浦-联想-惠普影音-徐'}}};
  assert.equal(parseRecoveryDecision(JSON.stringify({...f.locate,observedText:'漫步者-飞利浦-联...'}),input).decision,'locate');
  assert.throws(()=>parseRecoveryDecision(JSON.stringify({...f.locate,observedText:'另一个人...'}),input));
  assert.throws(()=>parseRecoveryDecision(JSON.stringify({...f.locate,observedText:'漫步者-飞利浦-联'}),input));
});

test('rejected model output records the exact validation reason and raw response privately',async t=>{
  const f=fixture(t),raw=JSON.stringify({...f.locate,point:{regionId:'mention_candidates',x:900,y:300}});
  const result=await planDesktopRecovery(f.input,{directory:f.directory,run:async()=>({...answer(f.locate),replyText:raw})});
  assert.equal(result.ok,false);
  assert.match(result.ok?'':result.error.message,/outside the allowed region/);
  const folder=join(f.directory,'logs','visual-recovery');
  const file=join(folder,readdirSync(folder)[0]);
  const record=JSON.parse(readFileSync(file,'utf8'));
  assert.equal(record.rawOutput,raw);assert.match(record.rejection,/outside the allowed region/);
  assert.equal(statSync(file).mode&0o777,0o600);
});

test('inspect returns the exact title separately from send-button coordinates and preserves private names', t => {
  const f = fixture(t), input: RecoveryInput = { ...f.input, stage: 'inspect' };
  const result = { ...f.locate, observedText: '钓友群（24）', point: { regionId: 'send_button', x: 1050, y: 740 } };
  assert.equal(parseRecoveryDecision(JSON.stringify(result), input).observedText, '钓友群（24）');
  assert.throws(() => parseRecoveryDecision(JSON.stringify({ ...result, observedText: '发送' }), input));
  assert.throws(() => parseRecoveryDecision(JSON.stringify({ ...result, observedText: '别的群（24）' }), input));
  const privateInput = { ...input, target: { label: 'Alice', kind: 'private' as const } };
  assert.throws(() => parseRecoveryDecision(JSON.stringify({ ...result, observedText: 'Alice(123)' }), privateInput));
});

test('security signals force stop; receipt and recovery never authorize clicking or declare successful sending', t => {
  const f = fixture(t);
  for (const screen of ['security', 'logged_out'] as const) {
    const result = parseRecoveryDecision(JSON.stringify({ ...f.locate, screen }), f.input);
    assert.equal(result.decision, 'stop'); assert.equal(result.point, null); assert.equal(result.targetMatches, false);
  }
  for (const stage of ['recover', 'receipt'] as const) {
    const input = { ...f.input, stage };
    assert.throws(() => parseRecoveryDecision(JSON.stringify({ ...f.locate, observedText: '钓友群' }), input));
    const result = parseRecoveryDecision(JSON.stringify({ ...f.locate, decision: 'retry', observedText: '钓友群', point: null }), input);
    assert.equal(result.decision, 'retry'); assert.equal(result.point, null);
    assert.throws(() => parseRecoveryDecision(JSON.stringify({ ...result, decision: 'sent' }), input));
  }
  assert.throws(() => parseRecoveryDecision(JSON.stringify(f.locate), { ...f.input,
    delivery: { kind: 'text', text: '已审核的原文', sendAttempted: true } }), /inspection only/);
});

test('read-only recovery can recheck a different visible chat without relaxing target-bound stages', async t => {
  const f = fixture(t);
  const judgment = { ...f.locate, decision: 'retry' as const, targetMatches: false, point: null, observedText: '另一个群（8）' };
  for (const stage of ['recover', 'receipt'] as const) {
    const result = await planDesktopRecovery({ ...f.input, stage }, { directory: f.directory, run: async () => answer(judgment) });
    assert.equal(result.ok && result.decision, 'retry');
    assert.equal(result.ok && result.targetMatches, false);
    assert.equal(result.ok && result.observedText, '另一个群（8）');
    assert.equal(result.ok && result.point, null);
    assert.throws(() => parseRecoveryDecision(JSON.stringify({ ...judgment, decision: 'locate', point: f.locate.point }), { ...f.input, stage }));
  }
  for (const stage of ['conversation', 'mention', 'inspect'] as const)
    assert.throws(() => parseRecoveryDecision(JSON.stringify(judgment), { ...f.input, stage }), /Unverified recovery target/);
});

test('bad input never calls the model and invalid/model/tool outputs are structured failures', async t => {
  const f = fixture(t); let calls = 0;
  const run = async () => { calls++; return answer(f.locate); };
  for (const input of [{ ...f.input, screenshotPath: 'relative.png' }, { ...f.input, stage: 'shell' },
    { ...f.input, target: { label: '群' } }, { ...f.input, allowedRegions: [{ id: 'send_button', x: 1200, y: 0, width: 10, height: 10 }] }]) {
    const result = await planDesktopRecovery(input as RecoveryInput, { directory: f.directory, run });
    assert.equal(result.ok ? '' : result.error.code, 'invalid_input');
  }
  assert.equal(calls, 0);
  for (const [output, code] of [
    [{ ...answer(f.locate), replyText: 'not json' }, 'invalid_output'],
    [{ ...answer(f.locate), error: 'timed out after 120000ms' }, 'timeout'],
    [{ ...answer(f.locate), error: 'runtime socket unavailable' }, 'model_error'],
    [{ ...answer(f.locate), commands: [{}] }, 'invalid_output'],
    [{ ...answer(f.locate), fileChanges: [{}] }, 'invalid_output'],
  ] as const) {
    const result = await planDesktopRecovery(f.input, { directory: f.directory, run: async () => output as CodexRunResult });
    assert.equal(result.ok ? '' : result.error.code, code);
  }
});

test('the one-shot JSON CLI preserves the decision without writing a conversation', async t => {
  const f = fixture(t);
  const malformed = await recoveryCommand('{');
  assert.equal(malformed.ok ? '' : malformed.error.code, 'invalid_input');
  const result = await recoveryCommand(JSON.stringify(f.input), { directory: f.directory, run: async () => answer(f.locate) });
  assert.equal(result.ok && result.decision, 'locate');
});
