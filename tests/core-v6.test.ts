import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversationMessage } from '../src/conversation.js';
const root = mkdtempSync(join(tmpdir(), 'ruanruan-core-v6-'));
process.env.WCB_DATA_DIR = root;
const { createMemoryStore } = await import('../src/memory.js');
const { createSemanticMemory, chatDocuments } = await import('../src/semantic-memory.js');
const { parseCharacterReply, CHARACTER_STATE_MARKER } = await import('../src/character-turn.js');
const { createLifeStore } = await import('../src/character-life.js');
const { createEmbedder } = await import('../src/embeddings.js');
const { runLife, lifeRuntime } = await import('../src/life-runtime.js');
const { createConversationStore } = await import('../src/conversation.js');
const { createWechatTools } = await import('../src/wechat-tools.js');
test.after(() => rmSync(root, { recursive: true, force: true }));
const config = { apiKey: 'synthetic-test-key', baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small' as const, dimensions: 1536, queryTimeoutMs: 250 };
const vector = (i: number) => Array.from({ length: 1536 }, (_, index) => index === i ? 1 : 0);
const originalFetch = globalThis.fetch;
const fakeFetch: typeof fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body));
  return new Response(JSON.stringify({ data: body.input.map((text: string, index: number) => ({ index, embedding: vector(text.includes('咖啡') ? 0 : 1) })), usage: { total_tokens: 10 } }));
};
test('hybrid retrieval really searches vec0 and invalidates deleted or corrected sources', async () => {
  globalThis.fetch = fakeFetch;
  try {
    const index = createSemanticMemory(join(root, 'vectors'), 'friend-a');
    const a = { id: 'a', kind: 'fact', text: '咖啡选拿铁', at: Date.now(), sourceIds: ['in:a'], provenance: 'confirmed' };
    const b = { ...a, id: 'b', text: '喜欢看天文纪录片' };
    index.sync([a, b]);
    assert.equal((await index.index(config)).indexed, 2);
    const result = await index.search('咖啡要什么', { config });
    assert.equal(result.status, 'hybrid');
    assert.equal(result.hits[0].id, 'a');
    assert.equal((await index.search('咖啡要什么', { config })).status, 'hybrid_cached');
    index.sync([b]);
    assert.equal(index.stats().indexed, 1);
    assert.ok(!(await index.search('咖啡要什么', { config })).hits.some(row => row.id === 'a'));
    index.sync([{ ...b, text: '后来不喜欢天文纪录片了' }]);
    assert.equal(index.stats().indexed, 0);
    assert.equal(createSemanticMemory(join(root, 'vectors'), 'friend-b').stats().documents, 0);
  } finally { globalThis.fetch = originalFetch; }
});
test('a late embedding response cannot restore a source deleted while indexing', async () => {
  const index = createSemanticMemory(join(root, 'race'), 'friend');
  index.sync([{ id: 'a', kind: 'fact', text: '咖啡选拿铁', at: 1, sourceIds: [], provenance: 'confirmed' }]);
  globalThis.fetch = async (...args) => { index.sync([]); return fakeFetch(...args); };
  try { assert.equal((await index.index(config)).indexed, 0); assert.equal(index.stats().documents, 0); }
  finally { globalThis.fetch = originalFetch; }
});
test('network errors preserve local recall and never expose credentials or response bodies', async () => {
  globalThis.fetch = fakeFetch;
  try {
    const index = createSemanticMemory(join(root, 'failure'), 'friend');
    index.sync([{ id: 'a', kind: 'fact', text: '咖啡选拿铁', at: 1, sourceIds: [], provenance: 'confirmed' }]);
    await index.index(config);
    globalThis.fetch = async () => { throw new Error('sensitive provider details'); };
    const result = await index.search('咖啡偏好', { config });
    assert.equal(result.status, 'lexical_fallback'); assert.equal(result.hits[0].id, 'a');
    const client = createEmbedder(config);
    await assert.rejects(client.embed(['hi']), error => String(error) === 'Error: Embedding network request failed or timed out');
    await client.close();
  } finally { globalThis.fetch = originalFetch; }
});
test('actual conversation chunks exclude work and commands and redact forgotten source quotes', () => {
  const rows: ConversationMessage[] = [
    { id: 'a', seq: 1, at: 1, direction: 'in', text: '喜欢拿铁', profile: 'companion', payload: {} },
    { id: 'b', seq: 2, at: 2, direction: 'out', text: '好，下次聊咖啡', profile: 'companion', payload: {} },
    { id: 'c', seq: 3, at: 3, direction: 'out', text: '服务器密码不能进角色记忆', profile: 'work', payload: {} },
    { id: 'd', seq: 4, at: 4, direction: 'in', text: '/Q', profile: 'companion', payload: {} },
  ];
  const docs = chatDocuments(rows, [{ id: 'old', text: '喜欢拿铁', at: new Date(100).toISOString() }]);
  assert.doesNotMatch(JSON.stringify(docs), /喜欢拿铁|服务器密码|\/Q/);
});
test('only delivered words can change stance, and stance persists across thread restarts', () => {
  const memory = createMemoryStore('stances', root), at = Date.now();
  const rows: ConversationMessage[] = [
    { id: 'in:a', seq: 1, at, direction: 'in', text: '快点给我照片', profile: 'companion', payload: {} },
    { id: 'out:a', seq: 2, at: at + 1, direction: 'out', text: '别催，不想发。', profile: 'companion', payload: {} },
  ];
  const update = { stance: { kind:'boundary' as const,topic: '个人画面', scope: 'interaction' as const, sharing: 'declined' as const,
    meaning: '被催逼后不愿分享', userQuote: '快点给我照片', replyQuote: '不想发' },
    relationship: [{ axis: 'comfort' as const, topic: '个人画面', effect: 'strained' as const,
      meaning: '催逼令人不舒服', userQuote: '快点给我照片', replyQuote: '不想发' }] };
  assert.equal(memory.character.commit(update, rows.slice(0, 1), memory).stances, 0);
  assert.equal(memory.character.commit(update, [rows[0], { ...rows[1], payload: { local_media: { caption: rows[1].text }, item_list: [{ type: 2 }] } }], memory).stances, 0);
  assert.equal(memory.character.commit(update, rows.map(row => ({ ...row, profile: 'work' as const })), memory).stances, 0);
  assert.equal(memory.character.commit(update, rows, memory).stances, 1);
  assert.equal(createMemoryStore('stances', root).character.snapshot()[0].sharing, 'declined');
  assert.equal(memory.relationship.snapshot().axes.comfort.boundaries.length, 1);
  assert.equal(memory.character.snapshot(['被催逼后不愿分享']).length, 0);
});
test('state metadata is removed even if malformed and late consolidation cannot replace newer activity', () => {
  assert.equal(parseCharacterReply(`你好\n${CHARACTER_STATE_MARKER}{broken`).reply, '你好');
  assert.deepEqual(parseCharacterReply(`你好\n${CHARACTER_STATE_MARKER}{}`).update, {});
  const memory = createMemoryStore('state-order', root);
  const entry = { key: 'activity' as const, text: '现在回家了', messageId: 'new', evidence: '回家', at: 200, until: Date.now() + 60000 };
  memory.continuity.commit([entry], 10);
  memory.continuity.commit([{ ...entry, text: '还在店里', at: 100 }], 8);
  assert.equal(memory.continuity.snapshot().active[0].text, '现在回家了');
  assert.equal(memory.continuity.meta().through, 10);
});
const evening = Date.parse('2026-11-02T20:00:00+08:00');
const lifeProposal=(action:string)=>JSON.stringify({action,reason:'先把开支列清楚',detail:{activity:'分开记录货架和收银台的待询价项目',summary:'把货架和收银台分别列成了待询价条目',feeling:'总算没混成一笔了',moodDelta:2,participants:['self'],goalId:'small_shop',step:'分别询问货架和收银台的价格',learning:'先分清开支项目，再核实具体费用'}});
test('world actions require location and time, create memories only after completion, and cannot complete twice', () => {
  const life = createLifeStore(join(root, 'causal'));
  const batch = life.claim(evening, true)!;
  assert.ok(batch);
  const result = { replyText: lifeProposal('budget'), commands: [], fileChanges: [] };
  assert.ok(life.settle(batch, result, true, evening + 1000));
  assert.equal(life.snapshot(evening + 60000).recent.length, 0);
  assert.ok(life.snapshot(evening + 60000).pending);
  assert.equal(life.snapshot(evening + 60000).goals[0].learning, undefined);
  assert.equal(life.snapshot(evening + 26 * 60000).recent.length, 1);
  assert.equal(life.snapshot(evening + 26 * 60000).goals[0].learning, '先分清开支项目，再核实具体费用');
  assert.equal(life.snapshot(evening + 27 * 60000).recent.length, 1);
  assert.equal(life.documents()[0].shared, false);
  const impossible = createLifeStore(join(root, 'impossible'));
  const other = impossible.claim(evening, true)!;
  impossible.settle(other, { ...result, replyText: lifeProposal('shop_observation') }, true, evening + 1000);
  assert.equal(impossible.snapshot(evening + 26 * 60000).pending, undefined);
  assert.equal(impossible.snapshot(evening + 26 * 60000).recent.length, 0);
});
test('spoken new activity interrupts a planned simulation without inventing completion', () => {
  const life = createLifeStore(join(root, 'interrupt'));
  const batch = life.claim(evening, true)!;
  life.settle(batch, { replyText: lifeProposal('budget'), commands: [], fileChanges: [] }, true, evening + 1000);
  life.followSpokenActivity({ text: '现在躺着休息', at: evening + 60000, until: evening + 61 * 60000, messageId: 'out:real' }, evening + 60000);
  assert.equal(life.snapshot(evening + 30 * 60000).recent.length, 0);
  assert.equal(life.snapshot(evening + 30 * 60000).activity.text, '现在躺着休息');
});
test('heartbeat API uses the selected model and medium effort, has no tools, and retains an explicit Codex route', async () => {
  mkdirSync(join(root, 'providers'), { recursive: true });
  writeFileSync(join(root, 'providers', 'openai-embeddings.json'), JSON.stringify(config), { mode: 0o600 });
  writeFileSync(join(root, 'providers', 'heartbeat.json'), '{"backend":"api","apiModel":"gpt-6.1-sol","codexModel":"gpt-6-luna"}');
  assert.equal(lifeRuntime().provider, 'api');
  let requests = 0, codexCalls = 0;
  const options = { cwd: root, prompt: '只输出JSON', mode: 'plan' as const, generationProvider: 'api' as const,
    model: 'gpt-6.1-sol', reasoningEffort: 'medium' as const, profile: 'consolidation' as const };
  const request: typeof fetch = async (_url, init) => {
    requests++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'gpt-6.1-sol'); assert.equal(body.reasoning.effort, 'medium');
    assert.equal(body.store, false); assert.equal(body.tools, undefined);
    return new Response(JSON.stringify({ status: 'completed', model: 'gpt-6.1-sol', output: [{ type: 'reasoning', summary: [] },
      { type: 'message', content: [{ type: 'output_text', text: '{"action":null,"reason":"继续休息"}' }] }],
      usage: { input_tokens: 20, output_tokens: 10, output_tokens_details: { reasoning_tokens: 5 } } }));
  };
  const codex = async () => { codexCalls++; return { replyText: '{}', commands: [], fileChanges: [] }; };
  const result = await runLife(options, request, codex);
  assert.equal(result.generationProvider, 'api'); assert.equal(result.reasoningOutputTokens, 5); assert.equal(codexCalls, 0);
  await assert.rejects(runLife(options, async () => new Response('untrusted provider error', { status: 401 }), codex), /HTTP 401/);
  assert.equal(codexCalls, 0);
  await runLife({ ...options, generationProvider: 'codex', model: 'gpt-6-luna' }, request, codex);
  assert.equal(requests, 1); assert.equal(codexCalls, 1);
  rmSync(join(root, 'providers'), { recursive: true });
});
test('an explicit follow-up can save prior received facts but cannot cite work or assistant claims', async () => {
  const account = 'follow-up-source', peer = 'friend', journal = createConversationStore(account, peer);
  const record = (id: string, text: string, direction: 'in' | 'out' = 'in', profile: 'companion' | 'work' = 'companion') =>
    journal.record(direction, { message_id: id, client_id: id, item_list: [{ type: 1, text_item: { text } }] }, Date.now(), undefined, profile);
  record('fact', '奶茶喜欢三分糖'); record('work', '我喜欢服务器密码', 'in', 'work'); record('guess', '用户喜欢榴莲', 'out');
  const messageId = record('instruction', '记住刚才的饮品偏好');
  const tools = createWechatTools(account, peer, { currentUser: '记住刚才的饮品偏好', messageIds: [messageId] });
  const saved = await tools.call('memory_update', { operation: 'remember', facts: [{ subject: 'user', attribute: '奶茶甜度', evidence: '奶茶喜欢三分糖' }] }) as any;
  assert.equal(saved.saved, true); assert.equal(saved.notes[0].source.messageId, 'in:fact');
  for (const evidence of ['我喜欢服务器密码', '用户喜欢榴莲']) await assert.rejects(tools.call('memory_update', {
    operation: 'remember', facts: [{ subject: 'user', attribute: '偏好', evidence }],
  }), /用户原话/);
});
test('forgetting a fact that exists only in raw conversation prevents vector and lexical resurrection', async () => {
  const account = 'raw-forget', peer = 'friend', journal = createConversationStore(account, peer);
  journal.record('in', { message_id: 'raw', item_list: [{ type: 1, text_item: { text: '我不吃香菜，妹妹对花生过敏。' } }] }, Date.now() - 1000, undefined, 'companion');
  const instruction = '忘掉我的香菜忌口，妹妹的事情保留';
  const id = journal.record('in', { message_id: 'forget', item_list: [{ type: 1, text_item: { text: instruction } }] }, Date.now(), undefined, 'companion');
  const memory = createMemoryStore(account);
  assert.equal(memory.load().notes.length, 0);
  const tools = createWechatTools(account, peer, { currentUser: instruction, messageIds: [id] });
  const result = await tools.call('memory_update', { operation: 'forget', facts: [{ subject: 'user', attribute: '忌口:香菜', evidence: '我不吃香菜' }] }) as any;
  assert.equal(result.removed, true); assert.equal(tools.forgotten, true);
  const sources = await memory.semantic(peer).search('香菜 妹妹');
  assert.doesNotMatch(JSON.stringify(sources), /我不吃香菜/);
  assert.match(JSON.stringify(sources), /妹妹对花生过敏/);
});
