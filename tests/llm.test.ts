import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodexRunOptions } from '../src/codex/bridge.js';
import type { Session } from '../src/session.js';

const root = mkdtempSync(join(tmpdir(), 'wechat-llm-switch-'));
process.env.WCB_DATA_DIR = root;
const { readLlmConfiguration, withChatLlm, llmRuntimeRegistration } = await import('../src/llm.js');
const { conversationOptions } = await import('../src/companion-profile.js');
const { runConversationTurn } = await import('../src/chat-retry.js');
const { createMemoryStore } = await import('../src/memory.js');
const { createConversationStore } = await import('../src/conversation.js');
const { lifeRuntime } = await import('../src/life-runtime.js');
const { consolidationOptions } = await import('../src/consolidation.js');
test.after(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, 'providers'));
const config = { active: 'deepseek', providers: { deepseek: { baseUrl: 'https://api.deepseek.com/',
  model: 'deepseek-flash', reasoningEffort: 'low', contextWindow: 1000000 } } };
const configPath = join(root, 'providers', 'llm.json');
const save = (active = 'deepseek') => writeFileSync(configPath, JSON.stringify({ ...config, active }));
const base: CodexRunOptions = { cwd: root, mode: 'plan', prompt: '你好', profile: 'companion',
  model: 'gpt-6.1-terra', reasoningEffort: 'medium', serviceTier: 'fast' };

test('foreground selection preserves background review settings and ignores work or consolidation', () => {
  save();
  const selected = withChatLlm(base);
  assert.equal(selected.model, 'deepseek-flash');
  assert.equal(selected.modelProvider, 'wcb_deepseek');
  assert.equal(selected.serviceTier, 'default');
  assert.deepEqual(selected.reviewTarget, { model: 'gpt-6.1-terra', reasoningEffort: 'medium', serviceTier: 'fast' });
  for (const profile of ['work', 'consolidation'] as const) {
    const original = { ...base, profile };
    assert.deepEqual(withChatLlm(original), original);
  }
  const workRoute = { kind: 'default' as const, reason: 'test', options: { model: 'gpt-6.1-sol', reasoningEffort: 'high' as const, serviceTier: 'default' as const } };
  assert.deepEqual(conversationOptions(workRoute, 'work'), workRoute.options);
  writeFileSync(join(root, 'providers', 'heartbeat.json'), JSON.stringify({ backend: 'api', apiModel: 'gpt-6.1-sol', codexModel: 'gpt-6-luna' }));
  assert.deepEqual(lifeRuntime(root), { provider: 'api', model: 'gpt-6.1-sol', reasoningEffort: 'medium', serviceTier: 'default' });
});

test('runtime registration keeps credentials out of arguments and pins an in-flight foreground target', () => {
  save();
  const secret = 'synthetic-provider-credential';
  writeFileSync(join(root, 'providers', 'deepseek.json'), JSON.stringify({ apiKey: secret }));
  const registration = llmRuntimeRegistration(root);
  assert.equal(registration.env.WCB_LLM_DEEPSEEK_API_KEY, secret);
  assert.ok(!JSON.stringify(registration.args).includes(secret));
  assert.ok(registration.args.some(arg => arg.includes('wire_api="responses"')));
  const pinned = withChatLlm(base);
  save('codex');
  assert.deepEqual(withChatLlm(pinned), pinned);
  assert.deepEqual(withChatLlm(base), base);
});

test('switching suppliers starts a fresh native thread, retains delivered history and keeps every review on the original model', async () => {
  save();
  const journal = createConversationStore('isolated', 'friend');
  journal.record('out', { client_id: 'prior', item_list: [{ type: 1, text_item: { text: '前面说到今晚想吃面' } }] }, Date.now() - 1000, undefined, 'companion');
  const input = journal.record('in', { message_id: 'current', item_list: [{ type: 1, text_item: { text: '那你准备做什么面' } }] }, Date.now(), undefined, 'companion');
  const options: CodexRunOptions = { ...base, prompt: '那你准备做什么面',
    personaContext: { version: 'ruanruan-core-v6', fingerprint: 'test-persona', files: [], bytes: 1 },
    conversation: { accountId: 'isolated', peerId: 'friend', messageIds: [input] } };
  const session: Session = { workingDirectory: root, state: 'idle', threadId: 'old-openai-thread', companionVersion: 6 };
  const memory = createMemoryStore('isolated');
  const calls: CodexRunOptions[] = [];
  const runner = async (call: CodexRunOptions) => {
    calls.push(call);
    return { replyText: call.profile === 'companion' ? '想弄个番茄鸡蛋面。' : '{"verdict":"pass","issues":[]}',
      commands: [], fileChanges: [], threadId: call.profile === 'companion' ? 'new-native-thread' : 'review-thread' };
  };
  const result = await runConversationTurn(options, session, memory, () => {}, runner);
  assert.equal(result.characterReview?.status, 'approved');
  assert.equal(calls[0].modelProvider, 'wcb_deepseek'); assert.equal(calls[0].threadId, undefined);
  assert.match(calls[0].prompt, /前面说到今晚想吃面/);
  assert.equal(calls[1].model, 'gpt-6.1-terra'); assert.equal(calls[1].reasoningEffort, 'medium');
  assert.equal(calls[1].serviceTier, 'fast'); assert.equal(calls[1].modelProvider, undefined);
  assert.equal(calls[1].llmProvider, undefined);
  const dsContext = session.contextLlm;
  save('codex'); calls.length = 0;
  await runConversationTurn(options, session, memory, () => {}, runner);
  assert.equal(calls[0].model, 'gpt-6.1-terra'); assert.equal(calls[0].modelProvider, undefined);
  assert.equal(calls[0].threadId, undefined); assert.notEqual(session.contextLlm, dsContext);
  assert.match(calls[0].prompt, /前面说到今晚想吃面/);
});

test('unknown providers and embedded credentials fail explicitly instead of silently using another billing channel', () => {
  save('missing'); assert.throws(() => readLlmConfiguration(root), /not configured/);
  const modified = JSON.parse(JSON.stringify(config)); modified.providers.deepseek.apiKey = 'do-not-inline';
  writeFileSync(configPath, JSON.stringify(modified));
  assert.throws(() => readLlmConfiguration(root), /credentials/);
  save();
  assert.ok(!readFileSync(configPath, 'utf8').includes('synthetic-provider-credential'));
});

test('character-wide API keeps each role model and pins review, repair and memory without changing server work', async () => {
  writeFileSync(configPath, JSON.stringify({ active: 'openai', scope: 'character', providers: {
    openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-sol', reasoningEffort: 'low', useRoleModels: true },
  } }));
  const options: CodexRunOptions = { ...base, model: 'gpt-6-sol', reasoningEffort: 'low',
    reviewTarget: { model: 'gpt-6-sol', reasoningEffort: 'low', serviceTier: 'fast' },
    repairTarget: { model: 'gpt-6.1-sol', reasoningEffort: 'medium', serviceTier: 'fast' },
    personaContext: { version: 'ruanruan-core-v6', fingerprint: 'test-persona', files: [], bytes: 1 },
    prompt: '36块打七五折是多少钱', turnContext: '正在算折扣',
  };
  const pinned = withChatLlm(options);
  assert.equal(pinned.model, 'gpt-6-sol'); assert.equal(pinned.reasoningEffort, 'low');
  assert.equal(pinned.serviceTier, 'fast');
  assert.equal(pinned.reviewTarget?.modelProvider, 'wcb_openai');
  assert.equal(pinned.repairTarget?.model, 'gpt-6.1-sol');
  const consolidation = consolidationOptions({ messages: [], after: 0, through: 0 }, 'api-memory', { cwd: root });
  assert.equal(consolidation.modelProvider, 'wcb_openai'); assert.equal(consolidation.model, 'gpt-6-luna');
  assert.deepEqual(withChatLlm({ ...options, profile: 'work' }), { ...options, profile: 'work' });

  // A manual switch during a running job must not move its review or repair.
  const config = JSON.parse(readFileSync(configPath, 'utf8')); config.active = 'codex';
  writeFileSync(configPath, JSON.stringify(config));
  const { reviewCharacterReply } = await import('../src/character-review.js');
  const calls: CodexRunOptions[] = [];
  const replies = ['{"verdict":"revise","issues":["价格算错"]}', '27块', '{"verdict":"pass","issues":[]}'];
  const result = await reviewCharacterReply(pinned, { replyText: '28块', commands: [], fileChanges: [] },
    createMemoryStore('api-review'), async call => {
      calls.push(call);
      return { replyText: replies[calls.length - 1], commands: [], fileChanges: [] };
    });
  assert.equal(result.characterReview?.status, 'revised');
  assert.deepEqual(calls.map(call => call.model), ['gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-sol']);
  assert.ok(calls.every(call => call.modelProvider === 'wcb_openai' && call.llmProvider === 'openai'));
  assert.ok(calls.every(call => call.profile === 'consolidation' && !call.conversation && call.ephemeral));

  let failures = 0;
  const failed = await runConversationTurn({ ...pinned, personaContext: undefined },
    { state: 'idle', workingDirectory: root }, createMemoryStore('api-failure'), () => {}, async call => {
      failures++; assert.equal(call.modelProvider, 'wcb_openai');
      return { replyText: '', commands: [], fileChanges: [], error: 'API insufficient_quota' };
    });
  assert.match(failed.error!, /insufficient_quota/); assert.equal(failures, 1);
  save();
});
