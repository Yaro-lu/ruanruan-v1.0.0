import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ConversationMessage } from '../src/conversation.js';

const root = mkdtempSync(join(tmpdir(), 'fishing-memory-'));
process.env.WCB_DATA_DIR = root;
const { createConversationStore, isLongTermMemorySource } = await import('../src/conversation.js');
const { createMemoryStore } = await import('../src/memory.js');
const { pendingConsolidation, commitConsolidation, consolidationOptions } = await import('../src/consolidation.js');
const { createSemanticMemory, chatDocuments } = await import('../src/semantic-memory.js');
test.after(() => rmSync(root, { recursive: true, force: true }));

const memoryPolicy = { excludeFromLongTerm: true as const, source: 'fishing_tools' as const };
function record(account: string, id: string, direction: 'in' | 'out', text: string, excluded = false) {
  return createConversationStore(account, 'group').record(direction, {
    message_id: id, client_id: id, item_list: [{ type: 1, text_item: { text } }],
    ...(excluded ? { memoryPolicy } : {}),
  }, Date.now(), undefined, 'companion');
}
function documents(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare('SELECT value FROM documents ORDER BY id').all().map(row => JSON.parse(String(row.value))); }
  finally { db.close(); }
}

test('tool replies retain their raw receipt and short-term context without becoming indexed memories', () => {
  const account = 'raw-vs-memory', journal = createConversationStore(account, 'group');
  record(account, 'trip', 'in', '昨天在浦口钓到了两条鲫鱼');
  record(account, 'weather', 'out', '浦口明天气压1009百帕，北风三级', true);
  record(account, 'ordinary', 'out', '两条也不错啊 我今天还没吃饭呢');
  const messages = journal.recent();
  assert.deepEqual((messages[1].payload as any).memoryPolicy, memoryPolicy);
  assert.equal(isLongTermMemorySource(messages[1]), false);
  assert.match(journal.prepare(undefined, [], 0, [], 'companion').text, /1009百帕/);
  assert.match(journal.search('1009百帕', 'companion')[0].text, /1009百帕/);
  const indexed = JSON.stringify(chatDocuments(messages));
  assert.doesNotMatch(indexed, /1009百帕/);
  assert.match(indexed, /钓到了两条鲫鱼/);
  assert.match(indexed, /我今天还没吃饭呢/);
});

test('background consolidation keeps user experiences when every assistant response used tools', () => {
  const account = 'user-experience', journal = createConversationStore(account, 'group');
  for (let i = 0; i < 4; i++) {
    record(account, `user-${i}`, 'in', '我喜欢钓鲫鱼');
    record(account, `tool-${i}`, 'out', '天气资料：明天降水概率70%，饵料资料：谷物配方', true);
  }
  const batch = pendingConsolidation(account, 'group')!;
  assert.equal(batch.through, journal.latestSequence());
  assert.equal(batch.messages.length, 4);
  assert.ok(batch.messages.every(row => row.direction === 'in'));
  assert.doesNotMatch(JSON.stringify(batch), /70%|谷物配方/);
  const outcome = commitConsolidation(account, batch, { commands: [], fileChanges: [], replyText: JSON.stringify({
    upsert: [{ kind: 'fact', fact: { subject: 'user', attribute: '兴趣:钓鱼' },
      evidence: '我喜欢钓鲫鱼', messageId: batch.messages[0].id }], state: [],
  }) });
  assert.equal(outcome.saved, 1);
  assert.equal(createMemoryStore(account).continuity.meta().through, 8);
});

test('an excluded-only page advances the consolidation cursor without a model request', () => {
  const account = 'excluded-page', memory = createMemoryStore(account);
  for (let i = 0; i < 32; i++) record(account, `tool-${i}`, 'out', '知识库饵料配方', true);
  assert.equal(pendingConsolidation(account, 'group'), undefined);
  assert.equal(memory.continuity.meta().through, 32);
  for (let i = 0; i < 4; i++) {
    record(account, `user-${i}`, 'in', '今天真开心');
    record(account, `ordinary-${i}`, 'out', '发生啥好事了');
  }
  const next = pendingConsolidation(account, 'group')!;
  assert.equal(next.after, 32);
  assert.equal(next.through, 40);
  assert.equal(next.messages.length, 8);
});

test('queued consolidation cannot turn excluded sources into character life or exchange notes', () => {
  const account = 'commit-gate', journal = createConversationStore(account, 'group');
  record(account, 'tool', 'out', '我在浦口钓鱼，今天气压1009百帕', true);
  record(account, 'user', 'in', '我喜欢吃鱼');
  const messages = journal.recent(), batch = { after: 0, through: 2, messages };
  const prompt = consolidationOptions(batch, account, { cwd: root }).prompt;
  assert.doesNotMatch(prompt, /1009百帕/);
  assert.match(prompt, /我喜欢吃鱼/);
  const outcome = commitConsolidation(account, batch, { commands: [], fileChanges: [], replyText: JSON.stringify({
    upsert: [{ id: 'fishing-trip', kind: 'character', text: '阮阮在浦口钓鱼', evidence: '我在浦口钓鱼', messageId: messages[0].id },
      { id: 'forecast-chat', kind: 'exchange', text: '谈起气压', evidence: '今天气压1009百帕', messageId: messages[0].id },
      { kind: 'fact', fact: { subject: 'user', attribute: '口味:鱼' }, evidence: '我喜欢吃鱼', messageId: messages[1].id }],
    state: [{ key: 'activity', text: '在浦口钓鱼', evidence: '我在浦口钓鱼', messageId: messages[0].id, validForMinutes: 30 }],
  }) });
  assert.equal(outcome.saved, 1);
  assert.equal(outcome.states, 0);
  assert.equal(outcome.rejected.length, 3);
  const memory = createMemoryStore(account);
  assert.doesNotMatch(JSON.stringify(memory.load().notes), /1009百帕|在浦口钓鱼/);
  assert.equal(memory.continuity.snapshot().active.length, 0);
});

test('explicit memory writers reject excluded receipts and still accept actual user experience', () => {
  const memory = createMemoryStore('explicit-gate');
  const source: ConversationMessage = { id: 'out:tool', seq: 1, direction: 'out', at: Date.now(),
    profile: 'companion', text: '气压1009百帕', payload: { memoryPolicy } };
  assert.throws(() => memory.applyDelivered([{ id: 'weather', kind: 'exchange', text: source.text,
    evidence: source.text, messageId: source.id }], [source]), /真实消息依据/);
  assert.throws(() => memory.rememberFacts([{ subject: 'user', attribute: '天气', evidence: source.text }],
    [{ ...source, direction: 'in' }]), /用户原话依据/);
  const actual = { ...source, id: 'in:actual', direction: 'in' as const, text: '我昨天钓到两条鱼', payload: {} };
  assert.equal(memory.rememberFacts([{ subject: 'user', attribute: '经历:钓鱼', evidence: actual.text }], [actual]).length, 1);
});

test('policy corrections invalidate old chunks and checkpoints while excluded appends advance the cursor', () => {
  const account = 'index-policy', journal = createConversationStore(account, 'group');
  record(account, 'user', 'in', '我昨天钓到两条鱼');
  const toolId = record(account, 'tool', 'out', '未来天气气压1009百帕');
  const index = createSemanticMemory(root, account);
  const source = () => ({ after: 0, revision: String(journal.sourceRevision()), latestSequence: journal.latestSequence(),
    since: journal.since, documents: [] });
  index.syncConversation(source());
  assert.match(JSON.stringify(documents(index.path)), /1009百帕/);
  const before = journal.sourceRevision(), db = new DatabaseSync(journal.path);
  try { db.prepare("UPDATE messages SET payload=json_set(payload,'$.memoryPolicy',json(?)) WHERE id=?")
    .run(JSON.stringify(memoryPolicy), toolId); }
  finally { db.close(); }
  assert.ok(journal.sourceRevision() > before);
  assert.equal(index.syncConversation(source()).rebuilt, true);
  assert.doesNotMatch(JSON.stringify(documents(index.path)), /1009百帕/);
  assert.match(JSON.stringify(documents(index.path)), /昨天钓到两条鱼/);
  record(account, 'next-tool', 'out', '另外一份天气预报', true);
  const appended = index.syncConversation(source());
  assert.equal(appended.rebuilt, false);
  assert.equal(appended.read, 1);
  assert.equal(appended.through, 3);
  assert.equal(index.syncConversation(source()).read, 0);
  const checkpoint = new DatabaseSync(index.path, { readOnly: true });
  try { assert.doesNotMatch(String(checkpoint.prepare("SELECT value FROM meta WHERE key='conversation_cursor'").get()!.value), /1009百帕|另外一份天气预报/); }
  finally { checkpoint.close(); }
});
