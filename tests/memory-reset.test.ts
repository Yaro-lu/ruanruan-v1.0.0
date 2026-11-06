import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { Job } from '../src/jobs.js';
import { createCharacterMetrics } from '../src/character-metrics.js';
import { createGeneratedImageQueue } from '../src/generated-images.js';

const root = mkdtempSync(join(tmpdir(), 'companion-reset-'));
process.env.WCB_DATA_DIR = root;
const { createConversationStore } = await import('../src/conversation.js');
const { memoryDirectory } = await import('../src/memory.js');
const { previewCompanionReset, resetCompanionData } = await import('../src/memory-reset.js');
const { createMemoryFactStore } = await import('../src/memory-fact-store.js');
test.after(() => rmSync(root, { recursive: true, force: true }));
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
function fixture() {
  const directory = mkdtempSync(join(root, 'data-'));
  const account = { accountId: 'test-bot', userId: 'owner' };
  const other = { accountId: 'other-bot', userId: 'other-owner' };
  const put = (path: string, value: unknown) => {
    const target = join(directory, path); mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const journal = createConversationStore(account.accountId, account.userId, directory);
  for (const [i, profile] of ['companion', 'companion', undefined, 'work'].entries()) {
    journal.record(i % 2 ? 'out' : 'in', { message_id: `in-${i}`, client_id: `out-${i}`,
      item_list: [{ type: 1, text_item: { text: profile === 'work' ? '服务器工作记录' : '旧的个人聊天' } }] }, Date.now(), 'old-native-thread', profile as 'companion' | 'work' | undefined);
  }
  const otherJournal = createConversationStore(other.accountId, other.userId, directory);
  otherJournal.record('in', { message_id: 'other', item_list: [{ type: 1, text_item: { text: '另一账号的聊天' } }] }, Date.now(), undefined, 'companion');
  const memory = memoryDirectory(account.accountId, join(directory, 'memory'));
  mkdirSync(join(memory, 'history'), { recursive: true }); mkdirSync(join(memory, 'handoffs'));
  for (const [name, value] of Object.entries({ 'memory.json': '{"version":1,"notes":[{"text":"旧事实"}],"handoff":"旧交接","recent":[]}',
    'relationship.sqlite3': 'old relationship', 'character-turn.sqlite3': 'old attitude', 'persona.sqlite3': 'old transient state',
    'continuity.sqlite3': 'old scene', 'semantic-old.sqlite3': 'old vectors',
    'history/2026-10-30.jsonl': 'old conversation', 'handoffs/old.json': 'old native snapshot' })) writeFileSync(join(memory, name), value);
  const protectedPaths = ['GENERATE.md', 'REVIEW.md', 'persona.md', 'persona/BACKSTORY.md', 'persona/RELATIONSHIP.md', 'persona/STYLE.md', 'persona/CONVERSATIONS.md',
    'providers/llm.json', 'providers/heartbeat.json', 'providers/openai-embeddings.json',
    'character-life/life.sqlite3', 'work-memory/notes.json', 'media-state/delivery.sqlite3'];
  for (const path of protectedPaths) put(path, `PRESERVE ${path}`);
  const addJob = (kind: Job['kind'], profile?: 'companion' | 'work' | 'consolidation',
    legacy = false, state = 'completed', accountId = account.accountId) => {
    const id = randomUUID();
    put(`jobs/${id}/job.json`, { id, accountId, kind, fromUserId: account.userId,
      options: { profile, ...(legacy ? { developerInstructions: '微信入口人格版本：ruanruan-core-v6' } : {}) } });
    put(`jobs/${id}/status.json`, { state }); put(`jobs/${id}/events.jsonl`, 'old model output');
    return id;
  };
  const personaJob = addJob('codex', 'companion');
  const legacyJob = addJob('codex', undefined, true);
  const compactJob = addJob('compact');
  const consolidationJob = addJob('consolidate', 'consolidation');
  const workJob = addJob('codex', 'work', true, 'running');
  const lifeJob = addJob('life', 'consolidation', false, 'running');
  const unknownJob = addJob('codex');
  const otherJob = addJob('codex', 'companion', false, 'completed', other.accountId);
  const sessionPath = `sessions/${account.accountId}.json`;
  put(sessionPath, { workingDirectory: directory, state: 'processing', chatMode: 'companion', model: 'gpt-6.1-terra',
    threadId: 'old-native-thread', contextLlm: 'old-provider', contextWindow: 100000, contextTokens: 30000,
    lastHandoffAt: 'old', conversationAfter: 0, activeJobId: personaJob, lastJobId: personaJob, backgroundJobId: consolidationJob,
    pendingRequest: { userText: 'old queued request' }, workJobId: workJob, lastWorkJobId: workJob,
    workContext: { threadId: 'work-native-thread', contextModel: 'gpt-6.1-sol' }, jobContextToken: 'transport-token', jobFromUserId: account.userId });
  put(`sessions/${other.accountId}.json`, { state: 'idle', threadId: 'other-thread' });
  put('message-queue.json', [[account.accountId, [{ userText: 'old chat' }, { profileHint: 'companion', userText: 'old chat two' },
    { profileHint: 'work', userText: 'keep work' }]], [other.accountId, [{ userText: 'keep other' }]]]);
  const protectedHashes = Object.fromEntries(protectedPaths.map(p => [p, hash(join(directory, p))]));
  return { directory, account, other, journal, otherJournal, memory, personaJob, legacyJob, compactJob, consolidationJob,
    workJob, lifeJob, unknownJob, otherJob, protectedHashes, sessionPath: join(directory, sessionPath), put };
}

test('preview reports all chat stores without clearing messages, memory, queue or sessions', () => {
  const f = fixture();
  const before = readFileSync(f.sessionPath, 'utf8');
  const plan = previewCompanionReset(f.account, f.directory);
  assert.equal(plan.messages, 3); assert.equal(plan.jobSnapshots, 4); assert.equal(plan.queuedMessages, 2);
  assert.equal(plan.runningJobs.length, 0);
  assert.equal(f.journal.recent().length, 4); assert.ok(existsSync(join(f.memory, 'semantic-old.sqlite3')));
  assert.equal(readFileSync(f.sessionPath, 'utf8'), before);
});

test('full reset tombstones central personal facts while keeping work and other accounts', () => {
  const f = fixture(), store = createMemoryFactStore(f.directory);
  const scope = { kind: 'private' as const, id: f.account.accountId };
  const fact = { scope, subjectId: 'owner', attribute: '过敏:虾', value: '虾过敏',
    source: { messageId: 'old-fact-source', at: new Date(Date.now() - 10000).toISOString(), quote: '我对虾过敏' } };
  store.upsert(fact);
  store.upsert({ ...fact, scope: { kind: 'work', id: f.account.accountId } });
  store.upsert({ ...fact, scope: { kind: 'private', id: f.other.accountId } });
  const result = resetCompanionData(f.account, f.directory);
  assert.equal(result.factsForgotten, 1);
  assert.equal(store.search({ scope }).length, 0);
  assert.equal(store.search({ scope: { kind: 'work', id: f.account.accountId } }).length, 1);
  assert.equal(store.search({ scope: { kind: 'private', id: f.other.accountId } }).length, 1);
  assert.equal(store.upsert(fact).action, 'suppressed');
});

test('full reset erases chat, derived memories and snapshots while preserving life, work and other accounts', () => {
  const f = fixture();
  const result = resetCompanionData(f.account, f.directory);
  assert.equal(result.messagesRemoved, 3); assert.equal(result.personalJobSnapshotsRemoved, 4);
  assert.deepEqual(f.journal.recent().map(row => row.profile), ['work']);
  assert.equal(f.journal.search('旧的个人聊天', 'companion').length, 0);
  assert.equal(f.otherJournal.recent().length, 1);
  for (const id of [f.personaJob, f.legacyJob, f.compactJob, f.consolidationJob]) assert.ok(!existsSync(join(f.directory, 'jobs', id)));
  for (const id of [f.workJob, f.lifeJob, f.unknownJob, f.otherJob]) assert.ok(existsSync(join(f.directory, 'jobs', id)));
  assert.deepEqual(json(join(f.memory, 'memory.json')), { version: 1, notes: [], handoff: '', recent: [] });
  for (const name of ['semantic-old.sqlite3', 'relationship.sqlite3', 'character-turn.sqlite3', 'continuity.sqlite3', 'persona.sqlite3', 'history', 'handoffs']) assert.ok(!existsSync(join(f.memory, name)));
  const session = json(f.sessionPath);
  assert.equal(session.threadId, undefined); assert.equal(session.contextLlm, undefined); assert.equal(session.pendingRequest, undefined);
  assert.equal(session.backgroundJobId, undefined); assert.equal(session.lastJobId, undefined); assert.equal(session.state, 'idle');
  assert.equal(session.workJobId, f.workJob); assert.equal(session.workContext.threadId, 'work-native-thread');
  assert.equal(session.jobContextToken, 'transport-token'); assert.equal(session.model, 'gpt-6.1-terra');
  assert.equal(json(join(f.directory, 'sessions', `${f.other.accountId}.json`)).threadId, 'other-thread');
  assert.deepEqual(json(join(f.directory, 'message-queue.json')), [[f.account.accountId, [{ profileHint: 'work', userText: 'keep work' }]],
    [f.other.accountId, [{ userText: 'keep other' }]]]);
  for (const [p, expected] of Object.entries(f.protectedHashes)) assert.equal(hash(join(f.directory, p)), expected);
  f.journal.record('in', { message_id: 'new', item_list: [{ type: 1, text_item: { text: '重新认识' } }] }, Date.now(), undefined, 'companion');
  assert.ok(f.journal.latestSequence() > session.conversationAfter);
});

test('reset is repeatable and keeps the old cutoff after old messages have been physically removed', () => {
  const f = fixture();
  resetCompanionData(f.account, f.directory);
  const cutoff = json(f.sessionPath).conversationAfter;
  const second = resetCompanionData(f.account, f.directory);
  assert.equal(second.messagesRemoved, 0); assert.equal(second.personalJobSnapshotsRemoved, 0);
  assert.equal(json(f.sessionPath).conversationAfter, cutoff);
  assert.equal(previewCompanionReset(f.account, f.directory).queuedMessages, 0);
});

test('active chat workers must be stopped before erasure; active life/work jobs are not stopped', () => {
  const f = fixture();
  f.put(`jobs/${f.personaJob}/status.json`, { state: 'running' });
  assert.throws(() => resetCompanionData(f.account, f.directory), /Stop active companion/);
  assert.equal(f.journal.recent().length, 4); assert.ok(existsSync(join(f.memory, 'semantic-old.sqlite3')));
  const stopped: string[] = [];
  resetCompanionData(f.account, f.directory, id => stopped.push(id));
  assert.deepEqual(stopped, [f.personaJob]);
  assert.ok(existsSync(join(f.directory, 'jobs', f.workJob)));
  assert.ok(existsSync(join(f.directory, 'jobs', f.lifeJob)));
});
test('reset forgets per-person scores and pending pictures while preserving world and other accounts',()=>{
 const f=fixture(),metrics=createCharacterMetrics(join(f.directory,'character-life')),at=Date.now();
 const key=JSON.stringify([f.account.accountId,f.account.userId]),other=JSON.stringify([f.other.accountId,f.other.userId]);
 const decision={intent:'conflict' as const,effect:'harassment' as const,mode:'pause' as const,userQuote:'测试原句',minutes:15};
 metrics.observe(key,'1',decision.userQuote,decision,at);metrics.observe(other,'2',decision.userQuote,decision,at);
 const before=metrics.snapshot(undefined,at),otherBefore=metrics.snapshot(other,at).relationship,ledger=metrics.ledger();
 const q=createGeneratedImageQueue(f.directory),config={enabled:true,model:'gpt-image-2.5-flare',size:'768x1024',quality:'low' as const,dailyLimit:6};
 for(const account of [f.account,f.other])q.enqueue({id:account.accountId,accountId:account.accountId,peerId:account.userId,at,modeRevision:0,inputSeq:1,
   proposal:{id:'proposal',query:'测试',scene:'坐着',caption:'测试'}},config);
 resetCompanionData(f.account,f.directory);
 assert.equal(metrics.snapshot(key,at).relationship?.affection,0);assert.equal(metrics.snapshot(key,at).relationship?.pausedUntil,0);
 assert.deepEqual(metrics.snapshot(other,at).relationship,otherBefore);assert.deepEqual(metrics.snapshot(undefined,at),before);assert.deepEqual(metrics.ledger(),ledger);
 assert.deepEqual(q.list().map(j=>j.accountId),[f.other.accountId]);
});
