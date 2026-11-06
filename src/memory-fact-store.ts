import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { MemoryDocument } from './semantic-memory.js';

export interface MemoryScope { kind: 'private' | 'group' | 'work'; id: string }
export type FactAssertion = 'fact' | 'plan' | 'reported' | 'uncertain';
export interface FactSource { messageId: string; at: string; quote: string; speakerId?: string }
export interface FactInput {
  subjectId: string; subjectName?: string; attribute: string; value: string; scope: MemoryScope;
  source: FactSource; assertion?: FactAssertion; validFrom?: string; validTo?: string;
  recordedAt?: string; stable?: boolean; topics?: string[]; supersedes?: string;
  legacyId?: string; allowReintroduce?: boolean;
}
export interface StoredMemoryFact {
  id: string; subjectId: string; subjectName?: string; attribute: string; value: string;
  scope: MemoryScope; assertion: FactAssertion; validFrom: string; validTo?: string;
  recordedAt: string; status: 'active' | 'superseded' | 'forgotten'; stable: boolean;
  topics: string[]; supersedes?: string; supersededBy?: string; revision: number;
  source: FactSource; sources: FactSource[]; evidenceCount: number;
}
export interface FactQuery {
  scope?: MemoryScope; scopes?: MemoryScope[]; subjectIds?: string[]; query?: string;
  topics?: string[]; ids?: string[]; limit?: number; includeHistory?: boolean; at?: string;
}
export interface FactForgetQuery extends FactQuery {
  ids?: string[]; legacyIds?: string[]; sourceMessageIds?: string[]; attributes?: string[];
  recordedAt?: string; allowFutureEvidence?: boolean;
  eventId?: string;
}
export interface LegacyFactNote {
  id: string; kind: string; text: string; updatedAt: string;
  fact?: { subject: string; attribute: string };
  source?: { messageId: string; at: string; quote: string; speaker?: string };
  priorSources?: { messageId: string; at: string; quote: string; speaker?: string }[];
}
export interface LegacyFactContext {
  scope: MemoryScope; subjectId: string; speakerId?: string; subjectName?: string;
  resolveSubject?: (subject: string) => string | undefined;
}
export type FactWriteResult = { action: 'created' | 'merged' | 'duplicate'; fact: StoredMemoryFact }
  | { action: 'suppressed'; fact?: undefined };

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clean = (value: string, field: string, max = 2000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error(`Invalid memory fact ${field}`);
  return value.normalize('NFKC').trim();
};
const date = (value: string, field: string) => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw Error(`Invalid memory fact ${field}`);
  return new Date(value).toISOString();
};
function scopeKey(scope: MemoryScope): string {
  if (!scope || !['private', 'group', 'work'].includes(scope.kind)) throw Error('Memory facts require an explicit visibility scope');
  return JSON.stringify([scope.kind, clean(scope.id, 'scope', 1000)]);
}
export function localFactSubjectId(scope:MemoryScope,speakerId:string,label:string) {
  return `local_${hash([scopeKey(scope),speakerId,label.normalize('NFKC').trim()]).slice(0,24)}`;
}
function queryScopes(query: FactQuery): string[] {
  const scopes = [...(query.scope ? [query.scope] : []), ...(query.scopes ?? [])];
  if (!scopes.length) throw Error('Memory fact reads require a visibility scope');
  return [...new Set(scopes.map(scopeKey))];
}
const placeholders = (items: unknown[]) => items.map(() => '?').join(',');
const words = (text: string) => {
  const tokens = [...text.toLowerCase().matchAll(/[a-z0-9_]+/g)].map(match => match[0]);
  for (const match of text.matchAll(/[\p{Script=Han}]+/gu)) {
    const block = match[0];
    if (block.length === 1) tokens.push(block);
    for (let i = 0; i + 1 < block.length; i++) tokens.push(block.slice(i, i + 2));
  }
  return [...new Set(tokens)].slice(0, 128);
};
const constraintAttribute = /过敏|忌口|禁忌|不能吃|饮食限制|健康限制|allerg|dietary|restriction/iu;

// This is the authoritative fact store, not an embedding index. Every row and
// every source keeps its original audience even when accounts share a person ID.
export function createMemoryFactStore(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'memory-facts.sqlite3');
  try { closeSync(openSync(path, 'wx', 0o600)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  function use<T>(fn: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(path);
    try {
      db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS facts(
          id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, scope_json TEXT NOT NULL,
          subject_id TEXT NOT NULL, subject_name TEXT, attribute TEXT NOT NULL, value TEXT NOT NULL,
          assertion TEXT NOT NULL, valid_from TEXT NOT NULL, valid_to TEXT, recorded_at TEXT NOT NULL,
          status TEXT NOT NULL, stable INTEGER NOT NULL, topics_json TEXT NOT NULL,
          supersedes TEXT, superseded_by TEXT, revision INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS facts_scope_subject ON facts(scope_key, subject_id, status, attribute);
        CREATE INDEX IF NOT EXISTS facts_scope_current ON facts(scope_key, status, recorded_at);
        CREATE TABLE IF NOT EXISTS fact_sources(
          fact_id TEXT NOT NULL REFERENCES facts(id), source_key TEXT NOT NULL, message_id TEXT NOT NULL,
          speaker_id TEXT, at TEXT NOT NULL, quote TEXT NOT NULL, PRIMARY KEY(fact_id, source_key));
        CREATE INDEX IF NOT EXISTS fact_source_message ON fact_sources(message_id, fact_id);
        CREATE TABLE IF NOT EXISTS fact_terms(
          scope_key TEXT NOT NULL, term TEXT NOT NULL, fact_id TEXT NOT NULL REFERENCES facts(id),
          PRIMARY KEY(scope_key, term, fact_id));
        CREATE TABLE IF NOT EXISTS fact_legacy(
          scope_key TEXT NOT NULL, legacy_id TEXT NOT NULL, fact_id TEXT NOT NULL REFERENCES facts(id),
          PRIMARY KEY(scope_key, legacy_id, fact_id));
        CREATE TABLE IF NOT EXISTS fact_tombstones(
          scope_key TEXT NOT NULL, subject_id TEXT NOT NULL, attribute TEXT NOT NULL,
          forgotten_at TEXT NOT NULL, revision INTEGER NOT NULL, require_explicit INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY(scope_key, subject_id, attribute));
        CREATE TABLE IF NOT EXISTS fact_meta(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS fact_forget_events(scope_key TEXT NOT NULL,event_id TEXT NOT NULL,
          PRIMARY KEY(scope_key,event_id));
        INSERT OR IGNORE INTO fact_meta VALUES('revision',0);`);
      if (!db.prepare('PRAGMA table_info(fact_tombstones)').all().some(column => column.name === 'require_explicit')) {
        db.exec('ALTER TABLE fact_tombstones ADD COLUMN require_explicit INTEGER NOT NULL DEFAULT 1');
      }
      return fn(db);
    } finally { db.close(); }
  }
  function transaction<T>(db: DatabaseSync, fn: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function bump(db: DatabaseSync): number {
    db.prepare("UPDATE fact_meta SET value=value+1 WHERE key='revision'").run();
    return Number(db.prepare("SELECT value FROM fact_meta WHERE key='revision'").get()!.value);
  }
  function readFact(db: DatabaseSync, row: any): StoredMemoryFact {
    const sources = db.prepare(`SELECT message_id, speaker_id, at, quote FROM fact_sources
      WHERE fact_id=? ORDER BY at DESC, source_key LIMIT 8`).all(row.id).map(source => ({
      messageId: String(source.message_id), at: String(source.at), quote: String(source.quote),
      ...(source.speaker_id ? { speakerId: String(source.speaker_id) } : {}),
    }));
    return {
      id: row.id, subjectId: row.subject_id, ...(row.subject_name ? { subjectName: row.subject_name } : {}),
      attribute: row.attribute, value: row.value, scope: JSON.parse(row.scope_json), assertion: row.assertion,
      validFrom: row.valid_from, ...(row.valid_to ? { validTo: row.valid_to } : {}), recordedAt: row.recorded_at,
      status: row.status, stable: !!row.stable, topics: JSON.parse(row.topics_json),
      ...(row.supersedes ? { supersedes: row.supersedes } : {}), ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
      revision: Number(row.revision), source: sources[0], sources,
      evidenceCount: Number(db.prepare('SELECT COUNT(*) AS count FROM fact_sources WHERE fact_id=?').get(row.id)!.count),
    };
  }
  function indexTerms(db: DatabaseSync, id: string, scope: string, text: string, topics: string[]) {
    db.prepare('DELETE FROM fact_terms WHERE fact_id=?').run(id);
    const insert = db.prepare('INSERT OR IGNORE INTO fact_terms VALUES(?,?,?)');
    for (const term of new Set([...words(text), ...topics.map(topic => `topic:${topic}`)])) insert.run(scope, term, id);
  }
  function write(db: DatabaseSync, input: FactInput): FactWriteResult {
    const key = scopeKey(input.scope), subject = clean(input.subjectId, 'subject', 256);
    const attribute = clean(input.attribute, 'attribute', 160), value = clean(input.value, 'value');
    const assertion = input.assertion ?? 'fact';
    if (!['fact', 'plan', 'reported', 'uncertain'].includes(assertion)) throw Error('Invalid fact assertion');
    const source = { ...input.source, messageId: clean(input.source.messageId, 'message ID', 500),
      quote: clean(input.source.quote, 'evidence'), at: date(input.source.at, 'source time') };
    const recordedAt = date(input.recordedAt ?? new Date().toISOString(), 'recorded time');
    const validFrom = date(input.validFrom ?? source.at, 'valid time');
    const validTo = input.validTo ? date(input.validTo, 'valid end') : undefined;
    if (validTo && validTo <= validFrom) throw Error('Fact validity end must follow its start');
    const topics = [...new Set((input.topics ?? []).map(topic => clean(topic, 'topic', 80)))].slice(0, 16);
    const sourceKey = hash([source.messageId, source.speakerId ?? '', source.quote]);
    const tombstone = db.prepare(`SELECT forgotten_at,require_explicit FROM fact_tombstones
      WHERE scope_key=? AND subject_id=? AND attribute=?`).get(key, subject, attribute);
    // Explicit relearning may use a fresh statement, but cannot revive forgotten
    // evidence simply by setting a flag on a delayed background import.
    if (tombstone && ((!input.allowReintroduce && !!tombstone.require_explicit)
      || source.at <= String(tombstone.forgotten_at))) return { action: 'suppressed' };
    const identical = db.prepare(`SELECT f.* FROM facts f JOIN fact_sources s ON s.fact_id=f.id
      WHERE f.scope_key=? AND f.subject_id=? AND f.attribute=? AND f.value=? AND f.assertion=?
        AND s.source_key=? AND f.status!='forgotten' LIMIT 1`).get(key, subject, attribute, value, assertion, sourceKey);
    if (identical) {
      if (input.legacyId) db.prepare('INSERT OR IGNORE INTO fact_legacy VALUES(?,?,?)').run(key, input.legacyId, identical.id);
      return { action: 'duplicate', fact: readFact(db, identical) };
    }
    let previous: any;
    if (input.supersedes) {
      previous = db.prepare('SELECT * FROM facts WHERE id=?').get(input.supersedes);
      if (!previous || previous.scope_key !== key || previous.subject_id !== subject || previous.attribute !== attribute
        || previous.assertion !== assertion || previous.status !== 'active') throw Error('Correction must target an active fact of the same subject, attribute, assertion and scope');
      if (validFrom < previous.valid_from) throw Error('An older statement cannot supersede a newer fact');
    }
    const matching = db.prepare(`SELECT * FROM facts WHERE scope_key=? AND subject_id=? AND attribute=?
      AND value=? AND assertion=? AND status='active' AND COALESCE(valid_to,'')=?
      ORDER BY valid_from DESC LIMIT 1`).get(key, subject, attribute, value, assertion, validTo ?? '');
    // A different value stays alongside the old one unless a caller has supplied
    // an explicit correction. Location observations never imply a house move.
    const existing = matching && (!previous || previous.id === matching.id) ? matching : undefined;
    const id = existing ? String(existing.id) : `mf_${randomUUID()}`, revision = bump(db);
    const mergedTopics = [...new Set([...(existing ? JSON.parse(String(existing.topics_json)) as string[] : []), ...topics])].slice(0, 16);
    if (existing) {
      db.prepare(`UPDATE facts SET subject_name=COALESCE(?,subject_name), stable=MAX(stable,?),
        topics_json=?, revision=? WHERE id=?`).run(input.subjectName ?? null, Number(input.stable ?? constraintAttribute.test(attribute)), JSON.stringify(mergedTopics), revision, id);
    } else {
      db.prepare('INSERT INTO facts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, key, JSON.stringify(input.scope), subject,
        input.subjectName ?? null, attribute, value, assertion, validFrom, validTo ?? null, recordedAt, 'active',
        Number(input.stable ?? constraintAttribute.test(attribute)), JSON.stringify(mergedTopics), previous?.id ?? null, null, revision);
      if (previous) db.prepare("UPDATE facts SET status='superseded',valid_to=?,superseded_by=?,revision=? WHERE id=?")
        .run(validFrom, id, revision, previous.id);
    }
    db.prepare('INSERT INTO fact_sources VALUES(?,?,?,?,?,?)').run(id, sourceKey, source.messageId, source.speakerId ?? null, source.at, source.quote);
    if (input.legacyId) db.prepare('INSERT OR IGNORE INTO fact_legacy VALUES(?,?,?)').run(key, input.legacyId, id);
    indexTerms(db, id, key, `${input.subjectName ?? ''} ${attribute} ${value} ${mergedTopics.join(' ')}`, mergedTopics);
    return { action: existing ? 'merged' : 'created', fact: readFact(db, db.prepare('SELECT * FROM facts WHERE id=?').get(id)) };
  }
  function upsert(input: FactInput): FactWriteResult { return use(db => transaction(db, () => write(db, input))); }
  function selection(query: FactQuery) {
    const scopes = queryScopes(query), clauses = [`f.scope_key IN (${placeholders(scopes)})`], params: SQLInputValue[] = [...scopes];
    if (query.subjectIds) {
      clauses.push(query.subjectIds.length ? `f.subject_id IN (${placeholders(query.subjectIds)})` : '0');
      params.push(...query.subjectIds);
    }
    if (query.ids) {
      clauses.push(query.ids.length ? `f.id IN (${placeholders(query.ids)})` : '0');
      params.push(...query.ids);
    }
    clauses.push("f.status!='forgotten'");
    if (!query.includeHistory) {
      const at = date(query.at ?? new Date().toISOString(), 'query time');
      // A plan is useful before the scheduled date. Facts still obey their
      // validity window; a recorded future plan is not a current activity.
      clauses.push("((f.assertion='plan' AND f.recorded_at<=?) OR f.valid_from<=?) AND (f.valid_to IS NULL OR f.valid_to>?)"); params.push(at, at, at);
    }
    return { clauses, params, scopes };
  }
  function select(db: DatabaseSync, query: FactQuery, stable = false, all = false): StoredMemoryFact[] {
    const { clauses, params } = selection(query);
    const terms = words(query.query ?? ''), topics = query.topics ?? [];
    if (stable) { clauses.push("f.stable=1 AND f.assertion='fact'"); }
    const lookup = [...terms, ...topics.map(topic => `topic:${topic}`)];
    if (lookup.length) {
      clauses.push(`EXISTS(SELECT 1 FROM fact_terms t WHERE t.fact_id=f.id AND t.scope_key=f.scope_key AND t.term IN (${placeholders(lookup)}))`);
      params.push(...lookup);
    }
    const limit = Math.min(1000, Math.max(1, Math.floor(query.limit ?? 20)));
    const score = lookup.length ? `(SELECT COUNT(*) FROM fact_terms t WHERE t.fact_id=f.id AND t.term IN (${placeholders(lookup)})) DESC,` : '';
    return db.prepare(`SELECT f.* FROM facts f WHERE ${clauses.join(' AND ')}
      ORDER BY ${score} f.stable DESC,f.recorded_at DESC,f.id LIMIT ?`).all(...params, ...lookup, all && query.limit === undefined ? -1 : limit).map(row => readFact(db, row));
  }
  const search = (query: FactQuery) => use(db => select(db, query));
  const get = (id: string, query: FactQuery) => search({ ...query, ids: [id], includeHistory: query.includeHistory ?? true, limit: 1 })[0];
  // Call with resolved participants and no keyword to obtain a small set of
  // stable constraints even when a new message never says "remember".
  const constraints = (query: FactQuery) => use(db => select(db, query, true));
  function importLegacy(notes: LegacyFactNote[], context: LegacyFactContext) {
    return use(db => transaction(db, () => {
      const result = { imported: 0, merged: 0, skipped: 0, suppressed: 0 };
      const key = scopeKey(context.scope);
      for (const note of notes.filter(note => note.kind === 'fact')) {
        const label = note.fact?.subject ?? 'user';
        const subjectId = label === 'user' ? context.subjectId : context.resolveSubject?.(label)
          ?? localFactSubjectId(context.scope,context.subjectId,label);
        const speakerId = context.speakerId ?? context.subjectId;
        const assertion: FactAssertion = subjectId === speakerId ? 'fact' : 'reported';
        const attribute = note.fact?.attribute ?? `legacy:${note.id}`;
        const source = note.source ?? { messageId: `legacy:${note.id}`, at: note.updatedAt, quote: note.text };
        // Legacy evidence chains describe past values, not extra endorsements
        // of the latest value. Split them into sourced temporal revisions once.
        const versions = [...(note.priorSources ?? []).filter(prior => Date.parse(prior.at) <= Date.parse(source.at))
          .map(prior => ({ source: prior, value: prior.quote })), { source, value: note.text }]
          .sort((a, b) => Date.parse(a.source.at) - Date.parse(b.source.at));
        for (const version of versions) {
          const at = date(version.source.at, 'legacy source time');
          const latest = db.prepare(`SELECT f.* FROM fact_legacy l JOIN facts f ON f.id=l.fact_id
            WHERE l.scope_key=? AND l.legacy_id=? AND f.subject_id=? AND f.attribute=? AND f.status='active'
            ORDER BY f.valid_from DESC LIMIT 1`).get(key, note.id, subjectId, attribute);
          const next = latest && String(latest.valid_from) > at ? db.prepare(`SELECT f.* FROM fact_legacy l JOIN facts f ON f.id=l.fact_id
            WHERE l.scope_key=? AND l.legacy_id=? AND f.subject_id=? AND f.attribute=? AND f.status!='forgotten'
              AND f.valid_from>? ORDER BY f.valid_from LIMIT 1`).get(key, note.id, subjectId, attribute, at) : undefined;
          const outcome = write(db, { scope: context.scope, subjectId,
            subjectName: label === 'user' ? context.subjectName : label,
            attribute, value: version.value, assertion, recordedAt: note.updatedAt,
            source: { ...version.source, speakerId }, legacyId: note.id,
            ...(next ? { validTo: String(next.valid_from) }
              : latest && latest.value !== version.value ? { supersedes: String(latest.id) } : {}),
          });
          if (outcome.action === 'created') {
            result.imported++;
            if (next) {
              db.prepare("UPDATE facts SET status='superseded',superseded_by=? WHERE id=?").run(next.id, outcome.fact.id);
              db.prepare(`UPDATE facts SET valid_to=?,superseded_by=?,revision=? WHERE scope_key=? AND subject_id=?
                AND attribute=? AND superseded_by=? AND valid_from<? AND valid_to>?`)
                .run(at, outcome.fact.id, outcome.fact.revision, key, subjectId, attribute, next.id, at, at);
            }
          } else if (outcome.action === 'merged') result.merged++;
          else if (outcome.action === 'suppressed') result.suppressed++;
          else result.skipped++;
        }
      }
      return result;
    }));
  }
  function forget(query: FactForgetQuery) {
    return use(db => transaction(db, () => {
      const scopes=queryScopes(query);
      if(query.eventId&&scopes.every(key=>db.prepare('SELECT 1 FROM fact_forget_events WHERE scope_key=? AND event_id=?').get(key,query.eventId!))) {
        return {ids:[] as string[],documentIds:[] as string[],count:0,
          revision:Number(db.prepare("SELECT value FROM fact_meta WHERE key='revision'").get()!.value)};
      }
      const { clauses, params } = selection({ ...query, ids: undefined, includeHistory: true });
      const forgottenAt = date(query.recordedAt ?? new Date().toISOString(), 'forget time');
      if(query.eventId) {
        clauses.push('NOT EXISTS(SELECT 1 FROM fact_sources fresh WHERE fresh.fact_id=f.id AND fresh.at>?)');
        params.push(forgottenAt);
      }
      const selectors: string[] = [], selectorParams: SQLInputValue[] = [];
      for (const [field, values] of [['f.id', query.ids], ['f.attribute', query.attributes]] as const) {
        if (values?.length) { selectors.push(`${field} IN (${placeholders(values)})`); selectorParams.push(...values); }
      }
      if (query.legacyIds?.length) {
        selectors.push(`EXISTS(SELECT 1 FROM fact_legacy l WHERE l.fact_id=f.id AND l.legacy_id IN (${placeholders(query.legacyIds)}))`);
        selectorParams.push(...query.legacyIds);
      }
      if (query.sourceMessageIds?.length) {
        selectors.push(`EXISTS(SELECT 1 FROM fact_sources s WHERE s.fact_id=f.id AND s.message_id IN (${placeholders(query.sourceMessageIds)}))`);
        selectorParams.push(...query.sourceMessageIds);
      }
      if (!selectors.length) throw Error('Forgetting requires fact IDs, legacy IDs, source IDs or attributes');
      clauses.push(`(${selectors.join(' OR ')})`); params.push(...selectorParams);
      const targets = db.prepare(`SELECT f.* FROM facts f WHERE ${clauses.join(' AND ')}`).all(...params);
      const requestedSlots=query.subjectIds?.length&&query.attributes?.length
        ?scopes.flatMap(key=>query.subjectIds!.flatMap(subject=>query.attributes!.map(attribute=>({key,subject,attribute})))):[];
      const ids: string[] = [], revision = targets.length||requestedSlots.length ? bump(db) : Number(db.prepare("SELECT value FROM fact_meta WHERE key='revision'").get()!.value);
      for (const target of targets) {
        // A fact's revisions are one forgettable item. Unrelated attributes and
        // the same person's privately shared information stay untouched.
        const versions = db.prepare(`SELECT f.id FROM facts f WHERE scope_key=? AND subject_id=? AND attribute=? AND status!='forgotten'
          ${query.eventId?'AND NOT EXISTS(SELECT 1 FROM fact_sources fresh WHERE fresh.fact_id=f.id AND fresh.at>?)':''}`)
          .all(target.scope_key, target.subject_id, target.attribute,...(query.eventId?[forgottenAt]:[]));
        for (const version of versions) {
          const id = String(version.id); ids.push(id);
          db.prepare("UPDATE facts SET status='forgotten',value='',subject_name=NULL,topics_json='[]',revision=? WHERE id=?").run(revision, id);
          db.prepare("UPDATE fact_sources SET quote='' WHERE fact_id=?").run(id);
          db.prepare('DELETE FROM fact_terms WHERE fact_id=?').run(id);
        }
        db.prepare(`INSERT INTO fact_tombstones VALUES(?,?,?,?,?,?) ON CONFLICT(scope_key,subject_id,attribute)
          DO UPDATE SET forgotten_at=MAX(forgotten_at,excluded.forgotten_at),revision=excluded.revision,
            require_explicit=excluded.require_explicit`)
          .run(target.scope_key, target.subject_id, target.attribute, forgottenAt, revision, Number(!query.allowFutureEvidence));
      }
      // A forgotten item may arrive later from an old consolidation job. Save
      // the specified slot even when its first fact row has not arrived yet.
      for(const slot of requestedSlots)db.prepare(`INSERT INTO fact_tombstones VALUES(?,?,?,?,?,?)
        ON CONFLICT(scope_key,subject_id,attribute) DO UPDATE SET forgotten_at=MAX(forgotten_at,excluded.forgotten_at),
          revision=excluded.revision,require_explicit=excluded.require_explicit`)
        .run(slot.key,slot.subject,slot.attribute,forgottenAt,revision,Number(!query.allowFutureEvidence));
      if(query.eventId)for(const key of scopes)db.prepare('INSERT OR IGNORE INTO fact_forget_events VALUES(?,?)').run(key,query.eventId);
      return { ids, documentIds: ids.map(id => `fact:${id}`), count: ids.length, revision };
    }));
  }
  function documents(query: FactQuery): MemoryDocument[] {
    return use(db => select(db, query, false, true)).map(fact => ({ id: `fact:${fact.id}`, kind: 'fact',
      text: `${fact.subjectName ?? fact.subjectId} ${fact.attribute}：${fact.value}`,
      at: Date.parse(fact.recordedAt), sourceIds: fact.sources.map(source => source.messageId),
      provenance: fact.assertion, ...(fact.validTo ? { expiresAt: fact.validTo } : {}),
      revision: String(fact.revision), shared: false,
    }));
  }
  function knownSubjects(query: FactQuery) {
    return use(db => {
      const { clauses, params } = selection(query);
      if(query.query) {clauses.push('f.subject_name IS NOT NULL AND instr(?,f.subject_name)>0');params.push(query.query);}
      const rows = db.prepare(`SELECT f.subject_id,MAX(f.subject_name) AS subject_name,
        json_group_array(json(f.topics_json)) AS topics FROM facts f WHERE ${clauses.join(' AND ')}
        GROUP BY f.subject_id ORDER BY f.subject_id LIMIT ?`).all(...params, Math.min(1000, query.limit ?? 100));
      return rows.map(row => ({ subjectId: String(row.subject_id), ...(row.subject_name ? { subjectName: String(row.subject_name) } : {}),
        topics: [...new Set((JSON.parse(String(row.topics)) as string[][]).flat())] }));
    });
  }
  function revision(scope?: MemoryScope) {
    return use(db => scope ? Number(db.prepare(`SELECT MAX(revision) AS revision FROM (
      SELECT revision FROM facts WHERE scope_key=? UNION ALL SELECT revision FROM fact_tombstones WHERE scope_key=?)`).get(scopeKey(scope), scopeKey(scope))?.revision ?? 0)
      : Number(db.prepare("SELECT value FROM fact_meta WHERE key='revision'").get()!.value));
  }
  return { path, upsert, importLegacy, search, get, constraints, forget, documents, revision, knownSubjects };
}
