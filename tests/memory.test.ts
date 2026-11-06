import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore, MEMORY_MARKER, parseMemoryReply, rotationReason, runWithMemory } from '../src/memory.js';
import { parseCodexOutput } from '../src/codex/events.js';
import type { Session } from '../src/session.js';
import type { CodexRunOptions } from '../src/codex/bridge.js';
import { buildCodexArgs } from '../src/codex/bridge.js';
const envelope = (upsert: any[] = [], remove: string[] = [], handoff = '待完成：提交报告') =>
  '已记录。\n' + MEMORY_MARKER + '\n' + JSON.stringify({ handoff, upsert: upsert.map(n => n.kind === 'task' ? n : { evidence: n.text, ...n }), remove });
const result = (replyText: string, error?: string) => ({ replyText, error, commands: [], fileChanges: [] });
function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'wcb-memory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, memory: createMemoryStore('owner', root) };
}
test('durable notes survive reload and rotation, corrections replace only matching notes', t => {
  const { root, memory } = fixture(t);
  memory.record('记住：NAS=/a', result(envelope([{ id: 'path', kind: 'fact', text: 'NAS=/a' }, { id: 'report', kind: 'task', text: '报告待办' }])));
  memory.record('改到NAS=/b', result(envelope([{ id: 'path', kind: 'fact', text: 'NAS=/b' }])));
  const restored = createMemoryStore('owner', root);
  assert.equal(restored.load().notes.length, 2);
  assert.equal(restored.load().notes.find(n => n.id === 'path')?.text, 'NAS=/b');
  restored.archive({ threadId: 'old', workingDirectory: '/tmp', state: 'idle' }, 'test');
  assert.equal(readdirSync(join(memory.dir, 'handoffs')).length, 1);
  restored.record('忘记路径', result(envelope([], ['path'])));
  assert.equal(restored.load().notes.length, 1);
  restored.clearRecent();
  assert.equal(restored.load().notes[0].id, 'report');
  assert.equal(restored.load().recent.length, 0);
  assert.equal(statSync(join(memory.dir, 'memory.json')).mode & 0o777, 0o600);
});
test('malformed and failed replies never erase prior memory or expose protocol', t => {
  const { memory } = fixture(t);
  memory.record('记住保留', result(envelope([{ id: 'keep', kind: 'fact', text: '保留' }])));
  const bad = memory.record('坏格式', result('正文\n' + MEMORY_MARKER + '{broken'));
  assert.equal(bad.reply, '正文'); assert.equal(bad.memorySaved, false);
  memory.record('失败', result(envelope([], ['keep']), 'timeout'));
  assert.equal(memory.load().notes[0].id, 'keep');
  assert.equal(parseMemoryReply(envelope([{ id: '../oops', kind: 'fact', text: 'x' }])).update, undefined);
  memory.record('x'.repeat(2000), result(envelope(Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, kind: 'fact', text: 'x'.repeat(2000) })))));
  assert.equal(memory.load().notes.length, 21);
  assert.ok(memory.prepareTurn('保留').metadata.contextBytes < 10000);
});

test('forgotten facts stay excluded after archive suggestions and may be explicitly remembered again', t => {
  const { memory } = fixture(t);
  memory.record('记住喜欢蓝色', result(envelope([{ id: 'color', kind: 'fact', text: '喜欢蓝色' }])));
  memory.forget('color');
  memory.record('喜欢蓝色', result(envelope([{ id: 'color', kind: 'fact', text: '喜欢蓝色' }])));
  assert.equal(memory.load().notes.length, 0);
  memory.record('重新记住喜欢蓝色', result(envelope([{ id: 'color', kind: 'fact', text: '喜欢蓝色' }])));
  assert.equal(memory.load().notes.length, 1);
});

test('temporal and short references recall the recent subject without injecting all history', t => {
  const { memory } = fixture(t);
  memory.record('周六去钓翘嘴，用玉米作饵', result(envelope([{ id: 'fishing', kind: 'fact', text: '周六去钓翘嘴，用玉米作饵' }])));
  assert.ok(memory.prepareTurn('昨天又空军了').metadata.recalledMemoryIds.includes('fishing'));
  assert.ok(memory.prepareTurn('还用上次那个吗').metadata.recalledMemoryIds.includes('fishing'));
  assert.ok(!memory.prepareTurn('推荐首歌').metadata.recalledMemoryIds.includes('fishing'));
});

test('compact updates preserve existing handoff and notes while still archiving chat', t => {
  const { memory } = fixture(t);
  memory.record('记住保留', result(envelope([{ id: 'keep', kind: 'fact', text: '保留' }], [], '报告还没做完')));
  const saved = memory.record('哈哈', result('哈哈😂\n' + MEMORY_MARKER + '\n{"upsert":[],"remove":[]}'));
  assert.equal(saved.reply, '哈哈😂');
  assert.equal(saved.memorySaved, true);
  assert.equal(memory.load().handoff, '报告还没做完');
  assert.equal(memory.load().notes[0].text, '保留');
  assert.equal(memory.load().recent.length, 2);
  memory.record('改正为已纠正', result('好的\n' + MEMORY_MARKER + '\n{"upsert":[{"id":"keep","kind":"fact","text":"已纠正","evidence":"已纠正"}],"remove":[]}'));
  assert.equal(memory.load().notes[0].text, '已纠正');
  assert.equal(memory.load().handoff, '报告还没做完');
  assert.equal(parseMemoryReply('正文\n' + MEMORY_MARKER + '\n{"handoff":null,"upsert":[],"remove":[]}').update, undefined);
});

test('resumed turns inject fixed instructions only on change while always refreshing current context', async t => {
  const { memory } = fixture(t);
  const session: Session = { threadId: 'current', memoryVersion: 1, workingDirectory: '/tmp', state: 'processing' };
  let calls = 0;
  for (const persona of ['阮阮v1', '阮阮v1', '阮阮v2']) {
    await runWithMemory({ prompt: '你好', cwd: '/tmp', mode: 'plan', developerInstructions: persona }, session, memory, () => {}, async options => {
      calls++;
      assert.equal(options.threadId, 'current');
      assert.equal(options.injectDeveloperInstructionsOnResume, calls !== 2);
      const args = buildCodexArgs(options);
      assert.equal(args.at(-1)!.includes(persona), calls !== 2);
      assert.ok(args.at(-1)!.includes('本轮微信资料'));
      assert.ok(args.at(-1)!.endsWith('当前用户消息：\n你好'));
      return { ...result('你好\n' + MEMORY_MARKER + '\n{"upsert":[],"remove":[]}'), threadId: 'current' };
    });
  }
  assert.equal(calls, 3);
  assert.match(session.developerInstructionsHash!, /^[a-f0-9]{64}$/);
});
test('failure recovery persists archive before calling a fresh thread and preserves settings', async t => {
  const { memory } = fixture(t);
  memory.record('记住：喜欢蓝色', result(envelope([{ id: 'color', kind: 'fact', text: '喜欢蓝色' }])));
  const session: Session = { threadId: 'old', memoryVersion: 1, memoryTurns: 20, rotateBeforeNext: true, model: 'chosen', reasoningEffort: 'high', mode: 'plan', workingDirectory: '/tmp', state: 'processing' };
  let calls = 0;
  const answer = await runWithMemory({ prompt: '继续', cwd: '/tmp', mode: 'plan', model: 'chosen', reasoningEffort: 'high' }, session, memory, () => {}, async options => {
    calls++;
    assert.equal(readdirSync(join(memory.dir, 'handoffs')).length, 1);
    assert.equal(options.threadId, undefined);
    assert.ok(options.prompt.includes('喜欢蓝色'));
    assert.ok(!options.prompt.includes('待完成：提交报告'));
    assert.equal(memory.load().handoff, '待完成：提交报告');
    assert.match(options.prompt, /memory_recall/);
    assert.equal(options.model, 'chosen'); assert.equal(options.reasoningEffort, 'high');
    return { ...result(envelope()), threadId: 'new', inputTokens: 12000 };
  });
  assert.equal(calls, 1); assert.equal(session.threadId, 'new'); assert.equal(session.memoryTurns, 1);
  assert.equal(session.contextTokens, 12000); assert.equal(answer.replyText, '已记录。');
  assert.equal(session.reasoningEffort, 'high');
});
test('normal calls resume; failures are never automatically replayed', async t => {
  const { memory } = fixture(t);
  const session: Session = { threadId: 'current', memoryVersion: 1, memoryTurns: 1, workingDirectory: '/tmp', state: 'processing' };
  let calls = 0;
  await runWithMemory({ prompt: '任务', cwd: '/tmp', mode: 'plan' }, session, memory, () => {}, async (options: CodexRunOptions) => {
    calls++; assert.equal(options.threadId, 'current');
    return result('部分工作', 'connection lost');
  });
  assert.equal(calls, 1); assert.equal(session.rotateBeforeNext, true);
  assert.equal(memory.load().recent[0].error, 'connection lost');
});
test('only migration and failed turns trigger handoff, never conversation length', () => {
  const base: Session = { threadId: 't', workingDirectory: '/tmp', state: 'idle', memoryVersion: 1 };
  assert.equal(rotationReason(base), undefined);
  assert.equal(rotationReason({ ...base, memoryTurns: 1000 }), undefined);
  assert.equal(rotationReason({ ...base, contextTokens: 1_000_000 }), undefined);
  assert.equal(rotationReason({ ...base, contextChars: 10_000_000 }), undefined);
  assert.equal(rotationReason({ ...base, memoryVersion: undefined }), 'legacy-session');
  assert.equal(rotationReason({ ...base, rotateBeforeNext: true }), 'previous-failure');
});
test('recent context is bounded, full conversational history remains on disk', t => {
  const { memory } = fixture(t);
  for (let i = 0; i < 30; i++) memory.record('u'.repeat(4000), result(envelope()));
  assert.ok(JSON.stringify(memory.load().recent).length <= 16000);
  assert.equal(readdirSync(join(memory.dir, 'history')).length, 1);
});
test('corrupted memory fails closed and does not start or discard the old thread', async t => {
  const { memory } = fixture(t);
  writeFileSync(join(memory.dir, 'memory.json'), '{broken');
  const session: Session = { threadId: 'old', workingDirectory: '/tmp', state: 'idle' };
  await assert.rejects(runWithMemory({ prompt: 'hi', cwd: '/tmp', mode: 'plan' }, session, memory, () => {}, async () => {
    assert.fail('must not run');
  }));
  assert.equal(session.threadId, 'old');
});
test('Codex usage and turn failures are captured even with intermediate messages', () => {
  const stdout = [
    { type: 'item.completed', item: { type: 'agent_message', text: 'working' } },
    { type: 'turn.completed', usage: { input_tokens: 61000, cached_input_tokens: 60000 } },
    { type: 'turn.failed', error: { message: 'compact failed' } },
  ].map(x => JSON.stringify(x)).join('\n');
  const parsed = parseCodexOutput(stdout, '', 0);
  assert.equal(parsed.inputTokens, 61000); assert.equal(parsed.error, 'compact failed');
});

test('long successful conversations keep the same thread while history and memory persist', async t => {
  const { memory } = fixture(t);
  const session: Session = { threadId: 'continuous-thread', memoryVersion: 1, memoryTurns: 18,
    contextTokens: 235175, contextChars: 100000, workingDirectory: '/tmp', state: 'processing' };
  let calls = 0;
  for (let i = 0; i < 25; i++) {
    const answer = await runWithMemory({ prompt: `第${i}条新消息：持续保存`, cwd: '/tmp', mode: 'plan' }, session, memory, () => {}, async options => {
      calls++;
      assert.equal(options.threadId, 'continuous-thread');
      assert.ok(options.prompt.endsWith(`当前用户消息：\n第${i}条新消息：持续保存`));
      return { ...result(envelope([{id:'keep',kind:'fact',text:'持续保存'}])), threadId: 'continuous-thread', inputTokens: 235175 };
    });
    assert.equal(answer.replyText, '已记录。');
  }
  assert.equal(calls, 25);
  assert.equal(session.memoryTurns, 43);
  assert.equal(session.threadId, 'continuous-thread');
  assert.equal(readdirSync(join(memory.dir, 'handoffs')).length, 0);
  assert.equal(memory.load().notes[0].text, '持续保存');
  assert.equal(readdirSync(join(memory.dir, 'history')).length, 1);
});
