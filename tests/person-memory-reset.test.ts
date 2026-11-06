import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const root = mkdtempSync(join(tmpdir(), 'person-reset-'));
process.env.WCB_DATA_DIR = root;
const { createIdentityStore } = await import('../src/identity.js');
const { createConversationStore, isLongTermMemorySource } = await import('../src/conversation.js');
const { memoryDirectory } = await import('../src/memory.js');
const { createSemanticMemory, chatDocuments } = await import('../src/semantic-memory.js');
const { previewPersonReset, resetPersonData } = await import('../src/memory-reset.js');
const { filterRoomMessagesForMemoryReset, readPersonMemoryResets } = await import('../src/person-memory-reset.js');
const { createMemoryFactStore } = await import('../src/memory-fact-store.js');
test.after(() => rmSync(root, { recursive: true, force: true }));
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const put = (path: string, value: unknown) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
function sqlite(path: string, action: (db: DatabaseSync) => void) {
  mkdirSync(join(path, '..'), { recursive: true }); const db = new DatabaseSync(path);
  try { action(db); } finally { db.close(); }
}
function fixture(name: string) {
  const directory = join(root, name), now = Date.now() - 10_000;
  const identity = createIdentityStore(directory).observe({ platform: 'wechat', channelAccountId: 'bot', actorId: 'target' }, [{ name: '小J', kind: 'nickname' }]);
  const target = { personId: identity.id, platform: 'wechat' as const, channelAccountId: 'bot', actorId: 'target',
    storageAccountId: 'group-account', peerId: 'room-peer', roomId: 'room@chatroom', roomDirectory: join(directory, 'rooms'), relatedRoomEventIds: ['related-out'] };
  const journal = createConversationStore(target.storageAccountId, target.peerId, directory);
  const incoming = (id: string, actorId: string, text: string, at = now) => journal.record('in', {
    message_id: id, roomEventId: id, item_list: [{ type: 1, text_item: { text } }],
    chatContext: { kind: 'group', conversationId: target.roomId, actorId },
  }, at, undefined, 'companion');
  incoming('target-old', 'target', '你为什么不理我'); incoming('other-old', 'other', '我不吃香菜');
  journal.record('out', { client_id: 'out-old', item_list: [{ type: 1, text_item: { text: '我还烦着他呢' } }] }, now, undefined, 'companion');
  const events = [{ id: 'target-old', at: now, actorId: 'target', text: '你为什么不理我' },
    { id: 'other-old', at: now, actorId: 'other', text: '我不吃香菜' },
    { id: 'related-out', at: now, actorId: 'bot', self: true, text: '我还烦着他呢' },
    { id: 'mention-old', at: now, actorId: 'other', mentions: ['target'], text: '@小J 她不理你' }];
  sqlite(join(target.roomDirectory, 'rooms.sqlite3'), db => {
    db.exec('CREATE TABLE events(id TEXT PRIMARY KEY,room TEXT,at INTEGER,value TEXT)');
    for (const event of events) db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(event.id, target.roomId, event.at, JSON.stringify(event));
  });
  const memory = memoryDirectory(target.storageAccountId, join(directory, 'memory'));
  put(join(memory, 'memory.json'), { version: 1, handoff: '', recent: [], notes: [
    { id: 'target-fact', fact: { subject: 'participant:target:user', attribute: '习惯' }, source: { messageId: 'in:target-old' }, text: '旧印象' },
    { id: 'other-fact', fact: { subject: 'participant:other:user', attribute: '忌口' }, source: { messageId: 'in:other-old' }, text: '我不吃香菜' }] });
  const metrics = join(directory, 'character-life', 'metrics.sqlite3');
  sqlite(metrics, db => {
    db.exec('CREATE TABLE peers(id TEXT PRIMARY KEY,value TEXT); CREATE TABLE social_events(id TEXT PRIMARY KEY,peer TEXT,at INTEGER,value TEXT); CREATE TABLE world(value TEXT); INSERT INTO world VALUES(\'wallet-and-energy-preserved\')');
    for (const key of [identity.storageKey, 'other-person']) {
      db.prepare('INSERT INTO peers VALUES(?,?)').run(key, '{"affection":-8,"conflict":{"intensity":20}}');
      db.prepare('INSERT INTO social_events VALUES(?,?,?,?)').run(key, key, now, '{}');
    }
  });
  const relation = join(memoryDirectory(identity.storageKey, join(directory, 'people')), 'relationship.sqlite3');
  sqlite(relation, db => db.exec("CREATE TABLE evidence(id TEXT PRIMARY KEY,value TEXT,at INTEGER); INSERT INTO evidence VALUES('old','{}',1)"));
  const actor = join(memory, 'actors', createHash('sha256').update('target').digest('hex').slice(0, 16), 'character-turn.sqlite3');
  sqlite(actor, db => db.exec("CREATE TABLE stances(id TEXT PRIMARY KEY,value TEXT); INSERT INTO stances VALUES('old','{}')"));
  const session = join(directory, 'sessions', `${target.storageAccountId}.json`);
  put(session, { state: 'idle', workingDirectory: '/tmp', threadId: 'old-group-thread', model: 'unchanged', workContext: { threadId: 'work-thread' } });
  const index = createSemanticMemory(memory, target.peerId);
  index.sync(chatDocuments(journal.recent()));
  return { directory, target, incoming, journal, events, metrics, relation, actor, memory, session, index };
}

test('reset targets one verified person and preserves original records, other members, identity and wallet', () => {
  const f = fixture('selective'), before = f.journal.recent().map(row => row.text);
  assert.equal(previewPersonReset(f.target, f.directory).messagesExcluded, 2);
  const result = resetPersonData(f.target, f.directory);
  assert.equal(result.messagesExcluded, 2); assert.equal(result.notesRemoved, 1);
  assert.equal(result.socialEventsRemoved, 1); assert.equal(result.peerRowsRemoved, 1);
  assert.equal(result.relationshipsRemoved, 1); assert.equal(result.stancesRemoved, 1);
  assert.equal(result.indexesReconciled, 1);
  assert.deepEqual(f.journal.recent().map(row => row.text), before);
  assert.deepEqual(f.journal.recent().map(isLongTermMemorySource), [false, true, false]);
  assert.deepEqual(json(join(f.memory, 'memory.json')).notes.map((note: any) => note.id), ['other-fact']);
  sqlite(f.metrics, db => {
    assert.deepEqual(db.prepare('SELECT id FROM peers').all().map(row => row.id), ['other-person']);
    assert.equal(db.prepare('SELECT value FROM world').get()!.value, 'wallet-and-energy-preserved');
  });
  assert.equal(createIdentityStore(f.directory).get({ platform: 'wechat', channelAccountId: 'bot', actorId: 'target' })!.id, f.target.personId);
  assert.deepEqual(filterRoomMessagesForMemoryReset(f.target.roomId, f.events, f.directory).map(row => row.id), ['other-old']);
  assert.equal(json(f.session).threadId, undefined); assert.equal(json(f.session).model, 'unchanged');
  assert.equal(json(f.session).workContext.threadId, 'work-thread');
  sqlite(f.index.path, db => assert.doesNotMatch(JSON.stringify(db.prepare('SELECT value FROM documents').all()), /旧印象|为什么不理我|烦着他/));
});

test('late imported pre-reset messages stay excluded while genuinely new messages remain usable', () => {
  const f = fixture('late'); resetPersonData(f.target, f.directory);
  const cutoff = readPersonMemoryResets(f.directory)[0].before;
  f.incoming('late-old', 'target', '重置前发出但刚导入', cutoff - 1);
  f.incoming('fresh', 'target', '重新聊个话题', cutoff + 1);
  const rows = f.journal.recent();
  assert.equal(isLongTermMemorySource(rows.find(row => row.id === 'in:late-old')!), false);
  assert.equal(isLongTermMemorySource(rows.find(row => row.id === 'in:fresh')!), true);
  const projected = filterRoomMessagesForMemoryReset(f.target.roomId, [{ id: 'new-quote', at: cutoff + 1, actorId: 'other',
    text: '新的主句', replyTo: { actorId: 'target', sourceId: 'target-old', text: '你为什么不理我', media: { path: 'old-image' } } }], f.directory);
  assert.equal(projected[0].text, '新的主句');
  assert.deepEqual(projected[0].replyTo, { actorId: 'target', actorName: undefined, text: '[旧引用已重置]' });
});

test('a mismatched same-name identity is rejected before any mutation', () => {
  const f = fixture('wrong-person');
  assert.throws(() => resetPersonData({ ...f.target, personId: 'different-person' }, f.directory), /does not match/);
  assert.equal(existsSync(join(f.directory, 'person-memory-resets.json')), false);
  assert.ok(f.journal.recent().every(isLongTermMemorySource));
});

test('person reset clears central fact revisions and documents only in the selected group', () => {
  const f = fixture('central-facts'), store = createMemoryFactStore(f.directory);
  const scope = { kind: 'group' as const, id: JSON.stringify(['wechat', 'bot', f.target.roomId]) };
  const privateScope = { kind: 'private' as const, id: JSON.stringify(['wechat', 'bot', f.target.personId]) };
  const source = { messageId: 'external-source', at: new Date(Date.now() - 20000).toISOString(), quote: '我对虾过敏' };
  const fact = { scope, subjectId: f.target.personId, attribute: '过敏:虾', value: '虾过敏', source };
  const old = store.upsert(fact).fact!;
  store.upsert({ ...fact, value: '虾不过敏', supersedes: old.id,
    source: { ...source, messageId: 'external-correction', at: new Date(Date.now() - 10000).toISOString(), quote: '我对虾不过敏' } });
  store.upsert({ ...fact, scope: privateScope });
  store.upsert({ ...fact, subjectId: 'person:other', value: '只吃淡水虾' });
  f.index.sync([...chatDocuments(f.journal.recent()), ...store.documents({ scope })]);
  const result = resetPersonData(f.target, f.directory);
  assert.equal(result.factsForgotten, 2);
  assert.equal(store.search({ scope, subjectIds: [f.target.personId], includeHistory: true }).length, 0);
  assert.equal(store.search({ scope: privateScope }).length, 1);
  assert.equal(store.search({ scope })[0].subjectId, 'person:other');
  assert.equal(store.upsert(fact).action, 'suppressed');
  assert.equal(store.upsert({ ...fact, source: { ...source, messageId: 'after-reset', at: new Date(result.cutoff + 1).toISOString() } }).action, 'created');
  sqlite(f.index.path, db => assert.doesNotMatch(JSON.stringify(db.prepare('SELECT value FROM documents').all()), new RegExp(old.id)));
});
