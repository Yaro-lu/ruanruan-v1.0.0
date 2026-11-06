import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PersonContext } from '../src/wechat/channel.js';

const root = mkdtempSync(join(tmpdir(), 'ruanruan-consolidation-memory-'));
process.env.WCB_DATA_DIR = root;
const { createConversationStore } = await import('../src/conversation.js');
const { createMemoryStore } = await import('../src/memory.js');
const { createIdentityStore } = await import('../src/identity.js');
const { pendingConsolidation, commitConsolidation, consolidationOptions, startConsolidationBackfill, ensureConsolidationBackfill, CONSOLIDATION_INTERVAL_MS } = await import('../src/consolidation.js');
test.after(() => rmSync(root, { recursive: true, force: true }));
const emptyReply = { commands: [], fileChanges: [], replyText: '{"upsert":[],"state":[]}' };
const t1 = Date.parse('2024-01-01T00:00:00.000Z');
const person: PersonContext = { accountId: 'desktop', actorId: 'actor-A', audience: 'room@chatroom' };
const groupMessage = (id: string, actorId: string, text: string, extra: object = {}) => ({ message_id: id,
  item_list: [{ type: 1, text_item: { text } }], chatContext: { kind: 'group', conversationId: 'room@chatroom',
    conversationName: '测试群', actorId, actorName: '同名' }, ...extra });

test('a single old incoming fact can be consolidated without an assistant reply', () => {
  const account = 'single-old', journal = createConversationStore(account, 'owner');
  journal.record('in', { message_id: 'one', item_list: [{ type: 1, text_item: { text: '我对虾过敏' } }] }, t1, undefined, 'companion');
  const batch = pendingConsolidation(account, 'owner')!;
  assert.equal(batch.messages.length, 1); assert.equal(batch.messages[0].at, t1);
  assert.equal(batch.through, 1); assert.equal(batch.after, 0);
  const memory = createMemoryStore(account);
  memory.continuity.attempted();
  assert.equal(pendingConsolidation(account, 'owner'), undefined);
  assert.equal(pendingConsolidation(account, 'owner', 0, Date.now() + CONSOLIDATION_INTERVAL_MS + 1)?.through, 1);
});

test('first scan boundary persists through new messages, failures and store recreation', () => {
  const account = 'durable-cursor', journal = createConversationStore(account, 'owner');
  for (let i = 0; i < 40; i++) journal.record('in', { message_id: `old-${i}`, item_list: [{ type: 1, text_item: { text: `旧消息${i}` } }] }, t1 + i, undefined, 'companion');
  const first = pendingConsolidation(account, 'owner')!;
  assert.equal(first.after, 8); assert.equal(first.through, 40);
  for (let i = 0; i < 40; i++) journal.record('in', { message_id: `new-${i}`, item_list: [{ type: 1, text_item: { text: `新消息${i}` } }] }, Date.now() + i, undefined, 'companion');
  const retried = pendingConsolidation(account, 'owner')!;
  assert.equal(retried.after, 8); assert.equal(retried.through, 40);
  commitConsolidation(account, retried, emptyReply);
  assert.equal(pendingConsolidation(account, 'owner')!.after, 40);
});

test('explicit historical backfill uses a durable separate cursor and preserves the live cursor', () => {
  const account = 'backfill', journal = createConversationStore(account, 'owner');
  for (let i = 0; i < 40; i++) journal.record('in', { message_id: `m${i}`, item_list: [{ type: 1, text_item: { text: `历史事实${i}` } }] }, t1 + i, undefined, 'companion');
  const live = pendingConsolidation(account, 'owner')!;
  commitConsolidation(account, live, emptyReply);
  assert.equal(createMemoryStore(account).continuity.meta().through, 40);
  startConsolidationBackfill(account, 'owner', 0);
  const old = pendingConsolidation(account, 'owner')!;
  assert.equal(old.after, 0); assert.equal(old.through, 32); assert.equal(old.backfill?.target, 40);
  commitConsolidation(account, old, emptyReply);
  assert.equal(createMemoryStore(account).continuity.meta().through, 40);
  const next = pendingConsolidation(account, 'owner')!;
  assert.equal(next.after, 32); assert.equal(next.through, 40);
  commitConsolidation(account, next, emptyReply);
  assert.equal(pendingConsolidation(account, 'owner'), undefined);
});

test('startup backfill is idempotent and new live messages take priority over archive pages', () => {
  const account = 'backfill-live-priority', journal = createConversationStore(account, 'owner');
  for (let i = 0; i < 50; i++) journal.record('in', { message_id: `old${i}`, item_list: [{ type: 1, text_item: { text: `旧事实${i}` } }] }, t1 + i, undefined, 'companion');
  assert.equal(ensureConsolidationBackfill(account, 'owner').target, 18);
  const live = pendingConsolidation(account, 'owner')!;
  assert.equal(live.after, 18); assert.equal(live.backfill, undefined);
  commitConsolidation(account, live, emptyReply);
  assert.equal(ensureConsolidationBackfill(account, 'owner').target, 18);
  assert.equal(pendingConsolidation(account, 'owner')!.backfill?.target, 18);
  journal.record('in', { message_id: 'fresh', item_list: [{ type: 1, text_item: { text: '刚发的新消息' } }] }, Date.now(), undefined, 'companion');
  const fresh = pendingConsolidation(account, 'owner')!;
  assert.equal(fresh.after, 50); assert.equal(fresh.backfill, undefined);
  commitConsolidation(account, fresh, emptyReply);
  const historical = pendingConsolidation(account, 'owner')!;
  assert.equal(historical.after, 0); assert.equal(historical.through, 18);
  commitConsolidation(account, historical, emptyReply);
  assert.equal(ensureConsolidationBackfill(account, 'owner').active, false);
  assert.equal(pendingConsolidation(account, 'owner'), undefined);
});

test('group facts retain individual speakers, while private facts and tool knowledge stay out', () => {
  const account = 'group-speakers', journal = createConversationStore(account, 'room@chatroom');
  const a = journal.record('in', groupMessage('a', 'actor-A', '我对虾过敏'), t1, undefined, 'companion');
  const b = journal.record('in', groupMessage('b', 'actor-B', '我对花生过敏'), t1 + 1, undefined, 'companion');
  journal.record('out', { client_id: 'tool', item_list: [{ type: 1, text_item: { text: '天气气压1009百帕' } }],
    memoryPolicy: { excludeFromLongTerm: true, source: 'fishing_tools' } }, t1 + 2, undefined, 'companion');
  const batch = pendingConsolidation(account, 'room@chatroom', 0, Date.now(), { person })!;
  assert.equal(batch.messages.length, 2); assert.equal(batch.roomId, 'room@chatroom');
  assert.equal((batch.messages[1].payload as any).chatContext.actorId, 'actor-B');
  const prompt = consolidationOptions(batch, account, { cwd: root }).prompt;
  assert.match(prompt, /actor-A/); assert.match(prompt, /actor-B/); assert.doesNotMatch(prompt, /1009百帕/);
  const result = commitConsolidation(account, batch, { ...emptyReply, replyText: JSON.stringify({ upsert: [
    { kind: 'fact', messageId: a, evidence: '我对虾过敏', fact: { subject: 'user', attribute: '过敏:虾', value: '虾过敏', topics: ['饮食'], stable: true } },
    { kind: 'fact', messageId: b, evidence: '我对花生过敏', fact: { subject: 'user', attribute: '过敏:花生', value: '花生过敏' } },
  ], state: [{ key: 'activity', text: '虾过敏', messageId: a, evidence: '我对虾过敏', validForMinutes: 30 }] }) });
  assert.equal(result.saved, 2); assert.equal(result.rejected.length, 1);
  const facts = createMemoryStore(account, undefined, person).recallFacts('过敏', [], 10);
  const identities = createIdentityStore(root);
  const aId = identities.get({ platform: 'wechat', channelAccountId: 'desktop', actorId: 'actor-A' })!.id;
  const bId = identities.get({ platform: 'wechat', channelAccountId: 'desktop', actorId: 'actor-B' })!.id;
  assert.equal(facts.find(fact => fact.value === '虾过敏')?.subjectId, aId);
  assert.equal(facts.find(fact => fact.value === '花生过敏')?.subjectId, bId);
  assert.equal(createMemoryStore(account).continuity.snapshot().active.length, 0);
});

test('group input missing actor identity is rejected instead of assigned to the last speaker', () => {
  const account = 'unknown-actor';
  const outcome = commitConsolidation(account, { after: 0, through: 1, person, roomId: 'room@chatroom', messages: [
    { id: 'in:no-actor', seq: 1, at: t1, direction: 'in', profile: 'companion', text: '我住上海', payload: {} },
  ] }, { ...emptyReply, replyText: JSON.stringify({ upsert: [
    { kind: 'fact', messageId: 'in:no-actor', evidence: '我住上海', fact: { subject: 'user', attribute: '常住地' } },
  ], state: [] }) });
  assert.equal(outcome.saved, 0); assert.equal(outcome.rejected.length, 1);
});
