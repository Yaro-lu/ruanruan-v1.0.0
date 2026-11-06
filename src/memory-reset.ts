import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './constants.js';
import { conversationPath, createConversationStore } from './conversation.js';
import { memoryDirectory } from './memory.js';
import { atomicWrite, type Job } from './jobs.js';
import { THREAD_FIELDS, type Session } from './session.js';
import { createSemanticMemory, type MemoryDocument } from './semantic-memory.js';
import { readPersonMemoryResets, type PersonMemoryReset } from './person-memory-reset.js';
import { createMemoryFactStore, type MemoryScope } from './memory-fact-store.js';
import { createIdentityStore } from './identity.js';
import type { PersonContext } from './wechat/channel.js';

export interface ResetAccount { accountId: string; userId: string; person?: PersonContext }
export interface ResetPersonTarget {
  personId: string; platform: 'wechat' | 'qq'; channelAccountId: string; actorId: string;
  storageAccountId: string; peerId: string; roomId: string; roomDirectory?: string;
  relatedMessageIds?: string[]; relatedRoomEventIds?: string[];
}
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8'));
const protectedFiles = ['providers/llm.json', 'providers/heartbeat.json', 'providers/openai-embeddings.json',
  'GENERATE.md', 'REVIEW.md',
  'persona.md', 'persona/BACKSTORY.md', 'persona/RELATIONSHIP.md', 'persona/STYLE.md', 'persona/CONVERSATIONS.md'];
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
function resetFactScope(person: PersonContext, directory: string): MemoryScope | undefined {
  const platform = person.platform ?? 'wechat';
  if (person.audience.endsWith('@chatroom')) return { kind: 'group', id: JSON.stringify([platform, person.accountId, person.audience]) };
  if (!existsSync(join(directory, 'identities.sqlite3'))) return;
  const identity = createIdentityStore(directory).get({ platform, channelAccountId: person.accountId, actorId: person.actorId });
  return identity ? { kind: 'private', id: JSON.stringify([platform, person.accountId, identity.id]) } : undefined;
}
function clearScopedFacts(directory: string, scopes: MemoryScope[], subjectIds?: string[], at = Date.now()) {
  const removed = new Set<string>();
  if (!existsSync(join(directory, 'memory-facts.sqlite3'))) return removed;
  const store = createMemoryFactStore(directory);
  for (;;) {
    const batch = store.search({ scopes, subjectIds, includeHistory: true, limit: 500 });
    if (!batch.length) break;
    const forgotten = store.forget({ scopes, subjectIds, ids: batch.map(row => row.id), recordedAt: new Date(at).toISOString(), allowFutureEvidence: true });
    for (const id of forgotten.documentIds) removed.add(id);
  }
  return removed;
}
export function isCompanionResetJob(job: Job) {
  if (!['codex', 'compact', 'consolidate'].includes(job.kind) || job.options?.profile === 'work') return false;
  return job.kind === 'consolidate' || job.kind === 'compact' || job.options?.profile === 'companion'
    || (!job.options?.profile && (!!job.options?.personaContext
      || /微信入口人格版本|微信专用.*阮阮/u.test(job.options?.developerInstructions ?? '')));
}
function discover(account: ResetAccount, directory: string) {
  if (!/^[a-zA-Z0-9_.@=-]+$/u.test(account.accountId) || !account.userId) throw new Error('A bound WeChat account is required');
  const sessionPath = join(directory, 'sessions', `${account.accountId}.json`);
  const session = readJson<Session>(sessionPath);
  const peers = new Set([account.userId, session.jobFromUserId].filter((x): x is string => !!x));
  const jobs: { id: string; running: boolean }[] = [];
  const jobsFolder = join(directory, 'jobs');
  for (const id of existsSync(jobsFolder) ? readdirSync(jobsFolder) : []) {
    if (!/^[a-f0-9-]{36}$/u.test(id)) continue;
    const path = join(jobsFolder, id, 'job.json');
    if (!existsSync(path)) continue;
    const job = readJson<Job>(path);
    if (job.accountId !== account.accountId) continue;
    if (job.fromUserId) peers.add(job.fromUserId);
    if (!isCompanionResetJob(job)) continue;
    const statusPath = join(jobsFolder, id, 'status.json');
    const state = existsSync(statusPath) ? readJson<{ state: string }>(statusPath).state : undefined;
    jobs.push({ id, running: state === 'pending' || state === 'running' });
  }
  const journals = [...peers].flatMap(peer => {
    const path = conversationPath(account.accountId, peer, directory);
    if (!existsSync(path)) return [];
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return [{ path, current: peer === account.userId,
        watermark: Number(db.prepare('SELECT COALESCE(MAX(seq),0) n FROM messages').get()!.n),
        messages: Number(db.prepare(`SELECT count(*) n FROM messages m LEFT JOIN contexts c ON c.message_id=m.id
          WHERE c.profile IS NULL OR c.profile<>'work'`).get()!.n) }];
    } finally { db.close(); }
  });
  const queuePath = join(directory, 'message-queue.json');
  const queue = existsSync(queuePath) ? readJson<[string, { profileHint?: string }[]][]>(queuePath) : [];
  return { sessionPath, session, journals, jobs, queuePath, queue };
}
export function previewCompanionReset(account: ResetAccount, directory = DATA_DIR) {
  const plan = discover(account, directory);
  return { accountId: account.accountId, messages: plan.journals.reduce((n, j) => n + j.messages, 0),
    conversationDatabases: plan.journals.length, jobSnapshots: plan.jobs.length,
    runningJobs: plan.jobs.filter(job => job.running).map(job => job.id),
    queuedMessages: plan.queue.filter(([id]) => id === account.accountId)
      .reduce((n, [, rows]) => n + rows.filter(row => row.profileHint !== 'work').length, 0),
    memoryDirectory: memoryDirectory(account.accountId, join(directory, 'memory')),
    preserved: ['persona', 'character-life', 'providers', 'work-memory', 'media-state'] };
}

// The caller pauses the bridge before this operation. Only classified persona
// workers are stopped; life workers and actual work retain their state.
export function resetCompanionData(account: ResetAccount, directory = DATA_DIR, stopJob?: (id: string) => void) {
  const plan = discover(account, directory);
  if (plan.jobs.some(job => job.running) && !stopJob) throw new Error('Stop active companion workers before clearing memory');
  for (const job of plan.jobs) if (job.running) stopJob!(job.id);
  const protectedBefore = protectedFiles.map(p => join(directory, p)).filter(existsSync).map(p => [p, digest(p)] as const);
  const workContext = JSON.stringify(plan.session.workContext);
  const factScopes: MemoryScope[] = [{ kind: 'private', id: account.accountId }];
  const person = account.person ?? { accountId: account.accountId,
    actorId: plan.session.chatContext?.actorId ?? account.userId,
    audience: plan.session.chatContext?.kind === 'group' ? plan.session.chatContext.conversationId : 'private' };
  const personScope = resetFactScope(person, directory);
  if (personScope) factScopes.push(personScope);
  const factsForgotten = clearScopedFacts(directory, factScopes).size;
  let messagesRemoved = 0;
  let watermark = plan.session.conversationAfter ?? 0;
  for (const journal of plan.journals) {
    const db = new DatabaseSync(journal.path);
    try {
      db.exec('PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON; BEGIN IMMEDIATE');
      const latest = Number(db.prepare('SELECT COALESCE(MAX(seq),0) n FROM messages').get()!.n);
      if (journal.current) watermark = Math.max(watermark, latest);
      db.exec(`CREATE TEMP TABLE erased AS SELECT m.id FROM messages m LEFT JOIN contexts c ON c.message_id=m.id
        WHERE c.profile IS NULL OR c.profile<>'work'`);
      messagesRemoved += Number(db.prepare('SELECT count(*) n FROM erased').get()!.n);
      db.exec(`DELETE FROM seen WHERE id IN (SELECT id FROM erased);
        DELETE FROM contexts WHERE message_id IN (SELECT id FROM erased);
        DELETE FROM messages WHERE id IN (SELECT id FROM erased); COMMIT`);
      db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM');
    } finally { db.close(); }
  }
  const memory = memoryDirectory(account.accountId, join(directory, 'memory'));
  rmSync(memory, { recursive: true, force: true });
  mkdirSync(memory, { recursive: true, mode: 0o700 });
  atomicWrite(join(memory, 'memory.json'), { version: 1, notes: [], handoff: '', recent: [] });
  for (const job of plan.jobs) rmSync(join(directory, 'jobs', job.id), { recursive: true, force: true });
  const queue = plan.queue.flatMap(([id, rows]) => {
    if (id !== account.accountId) return [[id, rows] as const];
    const work = rows.filter(row => row.profileHint === 'work');
    return work.length ? [[id, work] as const] : [];
  });
  if (existsSync(plan.queuePath)) atomicWrite(plan.queuePath, queue);
  // Forget the relationship, not the character's independent life or wallet.
  const metricsPath=join(directory,'character-life','metrics.sqlite3');
  if(existsSync(metricsPath)){
    const db=new DatabaseSync(metricsPath);
    try{db.exec('PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON; BEGIN IMMEDIATE');
      db.prepare("DELETE FROM social_events WHERE json_extract(peer,'$[0]')=?").run(account.accountId);
      db.prepare("DELETE FROM peers WHERE json_extract(id,'$[0]')=?").run(account.accountId);
      db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');
    }finally{db.close();}
  }
  const imagePath=join(directory,'generated-images','queue.sqlite3');
  if(existsSync(imagePath)){
    const db=new DatabaseSync(imagePath);
    try{db.exec('PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON');
      db.prepare("DELETE FROM jobs WHERE json_extract(value,'$.accountId')=?").run(account.accountId);
    }finally{db.close();}
  }
  const session = plan.session;
  for (const field of THREAD_FIELDS) delete session[field];
  for (const field of ['activeJobId', 'lastJobId', 'backgroundJobId', 'pendingRequest', 'lastInputAt', 'lastBurstAt'] as const) delete session[field];
  Object.assign(session, { state: 'idle', queuePaused: false, memoryVersion: 1, memoryTurns: 0,
    contextTokens: 0, contextChars: 0, rotateBeforeNext: false, conversationAfter: watermark });
  atomicWrite(plan.sessionPath, session);
  assert.equal(JSON.stringify(session.workContext), workContext);
  for (const [path, hash] of protectedBefore) assert.equal(digest(path), hash, 'Protected configuration changed');
  const remaining = previewCompanionReset(account, directory);
  assert.equal(remaining.messages, 0);
  assert.equal(remaining.jobSnapshots, 0);
  return { cleared: true, messagesRemoved, factsForgotten, personalJobSnapshotsRemoved: plan.jobs.length,
    relationship: 'stranger_start', semanticIndexesCleared: true, chatThreadReset: true,
    preserved: ['persona', 'character-life', 'providers', 'work-memory', 'media-state'] };
}

function discoverPersonReset(target: ResetPersonTarget, directory: string) {
  if (!/^[a-zA-Z0-9_.@=-]+$/u.test(target.storageAccountId) || !target.roomId.endsWith('@chatroom')) throw Error('Expected an exact group and storage account');
  const identities = new DatabaseSync(join(directory, 'identities.sqlite3'), { readOnly: true });
  let identity: any;
  try { identity = identities.prepare(`SELECT p.* FROM people p JOIN identity_accounts a ON a.person=p.id
    WHERE a.platform=? AND a.channel_account=? AND a.actor=? AND p.id=?`)
    .get(target.platform, target.channelAccountId, target.actorId, target.personId); }
  finally { identities.close(); }
  if (!identity) throw Error('Person ID does not match the verified platform account');
  const before = Date.now(), path = conversationPath(target.storageAccountId, target.peerId, directory);
  const db = new DatabaseSync(path, { readOnly: true });
  let messages: any[];
  try { messages = db.prepare('SELECT id,seq,at,direction,text,payload FROM messages ORDER BY seq').all()
    .map(row => ({ ...row, payload: JSON.parse(String(row.payload)) })); }
  finally { db.close(); }
  const events: any[] = [];
  const roomPath = target.roomDirectory && join(target.roomDirectory, 'rooms.sqlite3');
  if (roomPath && existsSync(roomPath)) {
    const rooms = new DatabaseSync(roomPath, { readOnly: true });
    try { events.push(...rooms.prepare('SELECT value FROM events WHERE room=? AND at<=?').all(target.roomId, before)
      .map(row => JSON.parse(String(row.value)))); }
    finally { rooms.close(); }
  }
  const relatedRoomIds = new Set(target.relatedRoomEventIds ?? []);
  const related = events.filter(event => event.actorId === target.actorId || event.mentions?.includes(target.actorId)
    || event.replyTo?.actorId === target.actorId || relatedRoomIds.has(event.id));
  for (const event of related) relatedRoomIds.add(event.id);
  const extra = new Set(target.relatedMessageIds ?? []);
  const selected = messages.filter(row => row.at <= before && (extra.has(row.id)
    || row.payload.chatContext?.actorId === target.actorId
    || relatedRoomIds.has(row.payload.roomEventId ?? row.payload.desktopSourceId)
    || row.direction === 'out' && related.some(event => event.self
      && Math.abs(event.at - Number(row.payload.desktop_receipt?.database?.createdAt ?? row.at)) < 2000
      && String(event.text).endsWith(row.text))));
  const memory = memoryDirectory(target.storageAccountId, join(directory, 'memory'));
  const person = memoryDirectory(String(identity.storage_key), join(directory, 'people'));
  const actor = join(memory, 'actors', createHash('sha256').update(target.actorId).digest('hex').slice(0, 16));
  const sessionPath = join(directory, 'sessions', `${target.storageAccountId}.json`);
  const session = existsSync(sessionPath) ? readJson<Session>(sessionPath) : undefined;
  if (session?.activeJobId || session?.backgroundJobId) throw Error('Finish or cancel this group worker before resetting one person');
  return { identity, path, messages, selected, before, relatedRoomIds, memory, person, actor, sessionPath, session };
}

export function previewPersonReset(target: ResetPersonTarget, directory = DATA_DIR) {
  const plan = discoverPersonReset(target, directory);
  return { personId: target.personId, actorId: target.actorId, storageKey: String(plan.identity.storage_key),
    messagesExcluded: plan.selected.length, roomEventsExcluded: plan.relatedRoomIds.size,
    memoryDirectory: plan.memory, personDirectory: plan.person, actorDirectory: plan.actor,
    preserved: ['raw_chat_history', 'other_people', 'identity_and_aliases', 'character_life', 'wallet'] };
}

// The bridge is paused by the caller. Unlike an account reset, this operation
// keeps every original message and only removes one verified person's derivatives.
export function resetPersonData(target: ResetPersonTarget, directory = DATA_DIR) {
  const plan = discoverPersonReset(target, directory), ids = new Set(plan.selected.map(row => String(row.id)));
  const counts = { messagesExcluded: 0, notesRemoved: 0, socialEventsRemoved: 0, peerRowsRemoved: 0,
    relationshipsRemoved: 0, stancesRemoved: 0, continuityRemoved: 0, indexesReconciled: 0, factsForgotten: 0 };
  const factScope: MemoryScope = { kind: 'group', id: JSON.stringify([target.platform, target.channelAccountId, target.roomId]) };
  const forgottenDocuments = clearScopedFacts(directory, [factScope], [target.personId], plan.before);
  counts.factsForgotten = forgottenDocuments.size;
  const previous = readPersonMemoryResets(directory);
  const old = previous.find(row => row.personId === target.personId && row.roomId === target.roomId);
  const reset: PersonMemoryReset = { personId: target.personId, channelAccountId: target.channelAccountId,
    actorId: target.actorId, roomId: target.roomId, storageAccountId: target.storageAccountId, peerId: target.peerId,
    before: plan.before, through: Number(plan.messages.at(-1)?.seq ?? 0),
    messageIds: [...new Set([...(old?.messageIds ?? []), ...ids])],
    roomEventIds: [...new Set([...(old?.roomEventIds ?? []), ...plan.relatedRoomIds])] };
  atomicWrite(join(directory, 'person-memory-resets.json'), { version: 1,
    resets: [...previous.filter(row => row !== old), reset] });
  const journal = createConversationStore(target.storageAccountId, target.peerId, directory);
  journal.sourceRevision(); // Install the metadata invalidation trigger before updates.
  const db = new DatabaseSync(plan.path);
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    for (const row of plan.selected) {
      if (row.payload.memoryPolicy?.source === 'person_reset' && row.payload.memoryPolicy.personId === target.personId) continue;
      row.payload.memoryPolicy = { excludeFromLongTerm: true, source: 'person_reset', personId: target.personId };
      counts.messagesExcluded += Number(db.prepare('UPDATE messages SET payload=? WHERE id=?').run(JSON.stringify(row.payload), row.id).changes);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; } finally { db.close(); }
  const memoryPath = join(plan.memory, 'memory.json');
  const state: any = existsSync(memoryPath) ? readJson(memoryPath) : undefined;
  if (state) {
    const owned = (note: any) => note.fact?.subject === target.personId || note.fact?.subject?.startsWith(`participant:${target.actorId}:`)
      || ids.has(note.source?.messageId) || note.priorSources?.some((source: any) => ids.has(source.messageId));
    counts.notesRemoved = state.notes.filter(owned).length;
    state.notes = state.notes.filter((note: any) => !owned(note));
    atomicWrite(memoryPath, state);
  }
  function update(path: string, action: (db: DatabaseSync) => void) {
    if (!existsSync(path)) return;
    const db = new DatabaseSync(path);
    try { db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE'); action(db); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; } finally { db.close(); }
  }
  update(join(directory, 'character-life', 'metrics.sqlite3'), db => {
    counts.socialEventsRemoved = Number(db.prepare('DELETE FROM social_events WHERE peer=?').run(plan.identity.storage_key).changes);
    counts.peerRowsRemoved = Number(db.prepare('DELETE FROM peers WHERE id=?').run(plan.identity.storage_key).changes);
  });
  update(join(plan.person, 'relationship.sqlite3'), db => {
    counts.relationshipsRemoved = Number(db.prepare('DELETE FROM evidence').run().changes);
  });
  update(join(plan.actor, 'character-turn.sqlite3'), db => {
    counts.stancesRemoved = Number(db.prepare('DELETE FROM stances').run().changes);
  });
  update(join(plan.memory, 'continuity.sqlite3'), db => {
    for (const row of db.prepare('SELECT key,value FROM state').all()) {
      if (ids.has(JSON.parse(String(row.value)).messageId)) counts.continuityRemoved += Number(db.prepare('DELETE FROM state WHERE key=?').run(row.key).changes);
    }
  });
  const index = createSemanticMemory(plan.memory, target.peerId);
  const indexDb = existsSync(index.path) ? new DatabaseSync(index.path, { readOnly: true }) : undefined;
  if (indexDb) {
    let documents: MemoryDocument[];
    try { documents = indexDb.prepare('SELECT value FROM documents').all().map(row => JSON.parse(String(row.value)))
      .filter((doc: MemoryDocument) => !doc.id.startsWith('chat:') && !forgottenDocuments.has(doc.id) && !doc.sourceIds.some(id => ids.has(id))
        && (!doc.id.startsWith('note:') || state?.notes.some((note: any) => `note:${note.id}` === doc.id))); }
    finally { indexDb.close(); }
    index.syncConversation({ after: plan.session?.conversationAfter ?? 0, revision: `person-reset:${journal.sourceRevision()}`,
      latestSequence: journal.latestSequence(), since: journal.since, documents });
    counts.indexesReconciled++;
  }
  if (plan.session) {
    for (const field of THREAD_FIELDS) delete plan.session[field];
    Object.assign(plan.session, { memoryVersion: 1, memoryTurns: 0, contextTokens: 0, contextChars: 0, rotateBeforeNext: false });
    atomicWrite(plan.sessionPath, plan.session);
  }
  return { personId: target.personId, ...counts, roomEventsExcluded: reset.roomEventIds.length,
    cutoff: reset.before, preserved: ['raw_chat_history', 'other_people', 'identity_and_aliases', 'character_life', 'wallet'] };
}
