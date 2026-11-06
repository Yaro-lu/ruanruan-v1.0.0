import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';
import type { ConversationMessage } from '../src/conversation.js';
const root = mkdtempSync(join(tmpdir(), 'semantic-incremental-'));
process.env.WCB_DATA_DIR = root;
const { createSemanticMemory, chatDocuments } = await import('../src/semantic-memory.js');
test.after(() => rmSync(root, { recursive: true, force: true }));

const row = (seq: number, text = `本轮普通聊天${seq}`): ConversationMessage => ({
  id: `in:${seq}`, seq, at: 1000 + seq * 1000, direction: 'in', profile: 'companion', text, payload: {},
});
function stored(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare('SELECT value FROM documents ORDER BY id').all().map(r => JSON.parse(String(r.value))); }
  finally { db.close(); }
}
const sorted = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
function seedVectors(path: string) {
  const db = new DatabaseSync(path, { allowExtension: true });
  try {
    sqliteVec.load(db);
    for (const r of db.prepare('SELECT rowid FROM documents').all())
      db.prepare('INSERT INTO vectors(rowid,embedding) VALUES(?,?)').run(BigInt(String(r.rowid)), new Float32Array(1536).fill(0.1));
  } finally { db.close(); }
}

test('append reads only new journal rows, extends the open chunk and preserves sealed vectors across restart', () => {
  const index = createSemanticMemory(root, 'append');
  const messages = Array.from({ length: 1007 }, (_, i) => row(i + 1));
  const reads: number[] = [];
  const source = () => ({ after: 0, revision: 'stable', latestSequence: messages.at(-1)!.seq, documents: [],
    since: (sequence: number, limit: number) => { reads.push(sequence); return messages.filter(r => r.seq > sequence).slice(0, limit); } });
  const first = index.syncConversation(source());
  assert.equal(first.read, 1007);
  assert.deepEqual(stored(index.path), sorted(chatDocuments(messages)));
  seedVectors(index.path);
  const before = index.stats().indexed;
  reads.length = 0;
  messages.push(row(1008), row(1009));
  const resumed = createSemanticMemory(root, 'append');
  const next = resumed.syncConversation(source());
  assert.deepEqual(reads, [1007]);
  assert.equal(next.read, 2);
  assert.equal(next.rebuilt, false);
  assert.equal(resumed.stats().indexed, before - 1, 'only the extended tail lost its old vector');
  assert.deepEqual(stored(index.path), sorted(chatDocuments(messages)));
  reads.length = 0;
  assert.equal(resumed.syncConversation(source()).read, 0);
  assert.deepEqual(reads, []);
  assert.equal(resumed.stats().indexed, before - 1);
});

test('chunk boundaries match full reconstruction with skipped records, long gaps and large text', () => {
  const index = createSemanticMemory(root, 'boundaries');
  const messages = [row(1, '甲'.repeat(2300)), row(2, '乙'.repeat(1300)),
    { ...row(3, '不得出现在人物记忆'), profile: 'work' as const }, row(4, '/status'),
    row(5, '新的普通话题'), { ...row(6, '半小时后的另一件事'), at: 2_000_000 }, row(7)];
  for (let i = 0; i < messages.length; i++) {
    const visible = messages.slice(0, i + 1);
    index.syncConversation({ after: 0, revision: 'v1', documents: [], latestSequence: visible.at(-1)!.seq,
      since: (sequence, limit) => visible.filter(r => r.seq > sequence).slice(0, limit) });
    assert.deepEqual(stored(index.path), sorted(chatDocuments(visible)));
  }
});

test('forgetting or source correction rebuilds old chunks and removes stale vectors and checkpoint text', () => {
  const index = createSemanticMemory(root, 'correction');
  const messages = [row(1, '喜欢拿铁'), row(2, '今天回家了')];
  const source = { after: 0, revision: 'v1', latestSequence: 2, documents: [],
    since: (sequence: number, limit: number) => messages.filter(r => r.seq > sequence).slice(0, limit) };
  index.syncConversation(source);
  seedVectors(index.path);
  const forgotten = [{ id: 'old', text: '喜欢拿铁', at: new Date(100_000).toISOString() }];
  const result = index.syncConversation({ ...source, revision: 'forgotten', forgotten });
  assert.equal(result.rebuilt, true);
  assert.equal(result.read, 2);
  assert.equal(index.stats().indexed, 0);
  assert.doesNotMatch(JSON.stringify(stored(index.path)), /喜欢拿铁/);
  const db = new DatabaseSync(index.path, { readOnly: true });
  try { assert.doesNotMatch(String(db.prepare("SELECT value FROM meta WHERE key='conversation_cursor'").get()!.value), /喜欢拿铁/); }
  finally { db.close(); }
  messages[1] = { ...messages[1], profile: 'work' };
  index.syncConversation({ ...source, revision: 'corrected-profile', forgotten });
  assert.equal(index.stats().documents, 0);
});

test('non-chat documents reconcile while cursors stay incremental, and legacy full sync invalidates checkpoints', () => {
  const index = createSemanticMemory(root, 'notes');
  const messages = [row(1)];
  const note = { id: 'note:preference', kind: 'fact', text: '咖啡选拿铁', at: 1, sourceIds: [], provenance: 'confirmed' };
  const source = { after: 0, revision: 'v1', latestSequence: 1, documents: [note],
    since: (sequence: number, limit: number) => messages.filter(r => r.seq > sequence).slice(0, limit) };
  index.syncConversation(source); seedVectors(index.path);
  const changed = { ...note, text: '现在只喝茶' };
  assert.equal(index.syncConversation({ ...source, documents: [changed] }).read, 0);
  assert.equal(index.stats().indexed, 1, 'the chat vector survives a note correction');
  assert.equal(index.syncConversation({ ...source, documents: [] }).read, 0);
  assert.deepEqual(stored(index.path), chatDocuments(messages));
  index.sync([{ ...note, id: 'legacy-contaminated', text: '运维记录不能留下' }]);
  assert.equal(index.syncConversation(source).rebuilt, true);
  assert.doesNotMatch(JSON.stringify(stored(index.path)), /运维记录不能留下/);
  index.syncConversation({ ...source, after: 1, revision: 'reset' });
  assert.deepEqual(stored(index.path), [note]);
});

test('group chunks preserve distinct people, current display names, mentions and quoted speakers across restart', () => {
  const index = createSemanticMemory(root, 'group-speakers');
  const group = (seq: number, actor: string, personId: string, text: string): ConversationMessage => ({ ...row(seq, text),
    payload: { chatContext: { kind: 'group', conversationId: 'room@chatroom', actorId: actor, actorName: '小A', person: { id: personId } },
      mentions: ['account-a'], replyTo: { actorId: 'account-a', actorName: '小A', text: '我虾过敏', sourceId: 'in:1' },
      authorization: 'not-a-memory' } });
  const messages = [group(1, 'account-a', 'person-a', '我虾过敏')];
  const source = () => ({ after: 0, revision: 'v1', latestSequence: messages.at(-1)!.seq, documents: [],
    since: (sequence: number, limit: number) => messages.filter(message => message.seq > sequence).slice(0, limit) });
  index.syncConversation(source());
  messages.push(group(2, 'account-b', 'person-b', '这边虾酱挺好吃的'));
  createSemanticMemory(root, 'group-speakers').syncConversation(source());
  const text = stored(index.path)[0].text;
  assert.match(text, /"speakerId":"account-a"/); assert.match(text, /"speakerId":"account-b"/);
  assert.match(text, /"personId":"person-a"/); assert.match(text, /"personId":"person-b"/);
  assert.match(text, /"mentions":\["account-a"\]/); assert.match(text, /"replyTo":\{"actorId":"account-a"/);
  assert.match(text, /"sourceId":"in:1"/); assert.doesNotMatch(text, /authorization|not-a-memory/);
  assert.deepEqual(stored(index.path), chatDocuments(messages));
  const forgotten = [{ id: 'allergy', text: '我虾过敏', at: new Date(100_000).toISOString() }];
  index.syncConversation({ ...source(), revision: 'forgotten', forgotten });
  assert.doesNotMatch(JSON.stringify(stored(index.path)), /我虾过敏/);
});
