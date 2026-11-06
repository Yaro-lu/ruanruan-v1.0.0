import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as sqliteVec from 'sqlite-vec';
import { createEmbedder, embeddingConfig, embeddingProfile, LEGACY_EMBEDDING_PROFILE, type EmbeddingConfig } from './embeddings.js';
import { rankMemories, redactForgotten } from './memory-recall.js';
import { memorySearchTerms as lexicalTerms, memoryFtsQuery } from './memory-tokenizer.js';
import type { ForgottenFact } from './memory-facts.js';
import { isLongTermMemorySource, type ConversationMessage } from './conversation.js';

export interface MemoryDocument { id: string; kind: string; text: string; at: number; sourceIds: string[];
  expiresAt?: string; provenance: string; shared?: boolean; revision?: string }
const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex');
const CONVERSATION_INDEX_VERSION = 3;
function expiration(doc: MemoryDocument): number | null {
  if (!doc.expiresAt) return null;
  const value = Date.parse(doc.expiresAt);
  return Number.isFinite(value) ? value : 0;
}
function active(doc: MemoryDocument, now = Date.now()) { const until = expiration(doc); return until === null || until > now; }
type DocumentRow = { rowid: number | bigint; id: string; hash: string };
type Profile = ReturnType<typeof embeddingProfile>;
function vectorTable(profile: Profile) { return profile.id === LEGACY_EMBEDDING_PROFILE.id ? 'vectors' : `vectors_${profile.id}`; }
interface IndexedChatMessage extends ConversationMessage {
  speakerId?: string; speakerName?: string; personId?: string; conversationId?: string;
  mentions?: string[]; replyTo?: Record<string, string>;
}
function groupAttribution(row: ConversationMessage, forgotten: ForgottenFact[]): Partial<IndexedChatMessage> {
  const payload = row.payload as { chatContext?: { kind?: string; actorId?: string; actorName?: string;
    conversationId?: string; person?: { id?: string }; personId?: string }; mentions?: unknown; replyTo?: Record<string, unknown> } | undefined;
  const context = payload?.chatContext;
  if (context?.kind !== 'group') return {};
  const result: Partial<IndexedChatMessage> = {};
  for (const [field, value] of Object.entries({ speakerId: context.actorId, speakerName: context.actorName,
    personId: context.person?.id ?? context.personId, conversationId: context.conversationId }))
    if (typeof value === 'string' && value) (result as Record<string, unknown>)[field] = value;
  if (Array.isArray(payload?.mentions)) result.mentions = payload.mentions.filter((value): value is string => typeof value === 'string').slice(0, 32);
  if (payload?.replyTo) {
    const quote: Record<string, string> = {};
    for (const key of ['actorId', 'actorName', 'personId', 'serverId', 'sourceId', 'kind'])
      if (typeof payload.replyTo[key] === 'string') quote[key] = payload.replyTo[key];
    if (typeof payload.replyTo.text === 'string') quote.text = redactForgotten(payload.replyTo.text, forgotten, row.at).slice(0, 800);
    if (Object.keys(quote).length) result.replyTo = quote;
  }
  return result;
}
function chatChunks(messages: ConversationMessage[], forgotten: ForgottenFact[], tail: IndexedChatMessage[] = []) {
  const chunks: IndexedChatMessage[][] = tail.length ? [[...tail]] : [];
  for (const row of messages) {
    if (row.profile !== 'companion' || !isLongTermMemorySource(row) || row.text.trim().startsWith('/')) continue;
    const text = redactForgotten(row.text, forgotten, row.at);
    if (!text.replace(/\[已按要求遗忘\]/gu, '').trim()) continue;
    let chunk = chunks.at(-1);
    if (!chunk || chunk.length >= 6 || row.at - chunk.at(-1)!.at > 30 * 60000
      || chunk.reduce((n, x) => n + x.text.length, 0) + text.length > 3500) { chunk = []; chunks.push(chunk); }
    // The continuation checkpoint needs only the already-redacted chat text,
    // not transport payloads or an unredacted copy of a forgotten fact.
    chunk.push({ id: row.id, seq: row.seq, at: row.at, direction: row.direction,
      text: text.slice(0, 2200), profile: row.profile, payload: undefined, ...groupAttribution(row, forgotten) });
  }
  return chunks;
}
function chunkDocument(chunk: IndexedChatMessage[]): MemoryDocument {
  return { id: `chat:${chunk[0].id}`, kind: 'exchange', at: chunk.at(-1)!.at,
    text: chunk.map(row => {
      const { speakerId, speakerName, personId, conversationId, mentions, replyTo } = row;
      const speaker = row.direction === 'out' ? '阮阮' : conversationId ? '群成员' : '用户';
      const identity = conversationId ? ` ${JSON.stringify({ speakerId, speakerName, personId, conversationId, mentions, replyTo })}` : '';
      return `${new Date(row.at).toISOString()} ${speaker}${identity}：${row.text}`;
    }).join('\n'),
    sourceIds: chunk.map(row => row.id), provenance: 'actual_wechat_exchange', shared: true };
}
export function chatDocuments(messages: ConversationMessage[], forgotten: ForgottenFact[] = []): MemoryDocument[] {
  return chatChunks(messages, forgotten).map(chunkDocument);
}
export interface ConversationIndexSource {
  after: number;
  // Changes when source corrections, forgetting or a reset invalidate old
  // chunks. Ordinary new messages do not change this revision.
  revision: string;
  latestSequence: number;
  since(sequence: number, limit: number): ConversationMessage[];
  // Non-chat memories remain a small authoritative set; omissions delete them.
  documents: MemoryDocument[];
  forgotten?: ForgottenFact[];
}
// Derived index only: source records remain authoritative. Reconciliation removes
// deleted/corrected/forgotten documents before either lexical or vector lookup.
export function createSemanticMemory(directory: string, scope: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `semantic-${fingerprint(scope).slice(0, 16)}.sqlite3`);

  function ensureProfile(db: DatabaseSync, profile: Profile) {
    const table = vectorTable(profile);
    if (db.prepare('SELECT 1 FROM embedding_profiles WHERE id=?').get(profile.id)) return table;
    // Names are generated solely from a SHA-256 profile ID, not configuration SQL.
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(embedding float[${profile.dimensions}] distance_metric=cosine)`);
    db.prepare('INSERT OR IGNORE INTO embedding_profiles(id,table_name,recipe,created_at) VALUES(?,?,?,?)')
      .run(profile.id, table, JSON.stringify(profile), Date.now());
    return table;
  }
  function vectorTables(db: DatabaseSync): string[] {
    return db.prepare('SELECT table_name FROM embedding_profiles').all().map(row => String(row.table_name))
      .filter(name => name === 'vectors' || /^vectors_[a-f0-9]{64}$/u.test(name));
  }
  function removeDocuments(db: DatabaseSync, rows: Pick<DocumentRow, 'rowid'>[]) {
    if (!rows.length) return;
    const deletes = vectorTables(db).map(table => db.prepare(`DELETE FROM ${table} WHERE rowid=?`));
    const remove = db.prepare('DELETE FROM documents WHERE rowid=?');
    for (const row of rows) {
      for (const statement of deletes) statement.run(BigInt(row.rowid));
      remove.run(row.rowid);
    }
  }
  function pruneExpired(db: DatabaseSync) {
    if (!db.prepare('SELECT 1 FROM documents WHERE expires_at<=? LIMIT 1').get(Date.now())) return;
    db.exec('BEGIN IMMEDIATE');
    try {
      const rows = db.prepare('SELECT rowid FROM documents WHERE expires_at<=?').all(Date.now()) as Pick<DocumentRow, 'rowid'>[];
      removeDocuments(db, rows); db.exec('COMMIT');
    }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function use<T>(fn: (db: DatabaseSync) => T): T {
    try { closeSync(openSync(path, 'wx', 0o600)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    const db = new DatabaseSync(path, { allowExtension: true });
    try {
      sqliteVec.load(db);
      db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS documents(rowid INTEGER PRIMARY KEY,id TEXT UNIQUE,hash TEXT,value TEXT);
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
        CREATE TABLE IF NOT EXISTS query_cache(hash TEXT PRIMARY KEY,at INTEGER,vector BLOB);
        CREATE TABLE IF NOT EXISTS usage(at INTEGER,tokens INTEGER,kind TEXT);
        CREATE TABLE IF NOT EXISTS usage_details(usage_rowid INTEGER PRIMARY KEY,provider TEXT,model TEXT,raw TEXT);
        CREATE TABLE IF NOT EXISTS embedding_profiles(id TEXT PRIMARY KEY,table_name TEXT UNIQUE NOT NULL,recipe TEXT NOT NULL,created_at INTEGER NOT NULL);`);
      ensureProfile(db, LEGACY_EMBEDDING_PROFILE);
      if (!db.prepare("SELECT 1 FROM meta WHERE key='lexical_schema_v1'").get()) {
        db.exec('BEGIN IMMEDIATE');
        try {
          // Recheck after acquiring the write lock: another process may have
          // completed this additive migration while this connection was waiting.
          if (!db.prepare("SELECT 1 FROM meta WHERE key='lexical_schema_v1'").get()) {
            const columns = new Set(db.prepare('PRAGMA table_info(documents)').all().map(row => String(row.name)));
            for (const [name, type] of [['text', 'TEXT'], ['kind', 'TEXT'], ['expires_at', 'INTEGER'],
              ['is_chat', 'INTEGER NOT NULL DEFAULT 0'], ['lexical_tokens', 'TEXT']])
              if (!columns.has(name)) db.exec(`ALTER TABLE documents ADD COLUMN ${name} ${type}`);
            db.exec(`CREATE INDEX IF NOT EXISTS document_expiration ON documents(expires_at);
              CREATE INDEX IF NOT EXISTS document_chat_kind ON documents(is_chat);
              CREATE INDEX IF NOT EXISTS document_kind ON documents(kind);
              CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(lexical_tokens,content='documents',content_rowid='rowid');`);
            const update = db.prepare('UPDATE documents SET text=?,kind=?,expires_at=?,is_chat=?,lexical_tokens=? WHERE rowid=?');
            // Existing source documents and legacy vectors stay in place. Only
            // the derived lexical projection needs a one-time backfill.
            for (const row of db.prepare('SELECT rowid,value FROM documents').all()) {
              const doc = JSON.parse(String(row.value)) as MemoryDocument;
              update.run(doc.text, doc.kind, expiration(doc), Number(doc.id.startsWith('chat:')), lexicalTerms(doc.text).join(' '), row.rowid);
            }
            db.exec(`INSERT INTO documents_fts(documents_fts) VALUES('rebuild');
              CREATE TRIGGER IF NOT EXISTS documents_fts_insert AFTER INSERT ON documents BEGIN
                INSERT INTO documents_fts(rowid,lexical_tokens) VALUES(new.rowid,new.lexical_tokens); END;
              CREATE TRIGGER IF NOT EXISTS documents_fts_delete AFTER DELETE ON documents BEGIN
                INSERT INTO documents_fts(documents_fts,rowid,lexical_tokens) VALUES('delete',old.rowid,old.lexical_tokens); END;
              CREATE TRIGGER IF NOT EXISTS documents_fts_update AFTER UPDATE OF lexical_tokens ON documents BEGIN
                INSERT INTO documents_fts(documents_fts,rowid,lexical_tokens) VALUES('delete',old.rowid,old.lexical_tokens);
                INSERT INTO documents_fts(rowid,lexical_tokens) VALUES(new.rowid,new.lexical_tokens); END;
              INSERT INTO meta(key,value) VALUES('lexical_schema_v1','1');`);
          }
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      }
      pruneExpired(db);
      return fn(db);
    } finally { db.close(); }
  }
  function insertDocuments(db: DatabaseSync, documents: Iterable<MemoryDocument>) {
    const insert = db.prepare(`INSERT OR IGNORE INTO documents(id,hash,value,text,kind,expires_at,is_chat,lexical_tokens)
      VALUES(?,?,?,?,?,?,?,?)`);
    for (const doc of documents) if (active(doc)) insert.run(doc.id, fingerprint(JSON.stringify(doc)), JSON.stringify(doc),
      doc.text, doc.kind, expiration(doc), Number(doc.id.startsWith('chat:')), lexicalTerms(doc.text).join(' '));
  }
  function reconcile(db: DatabaseSync, old: DocumentRow[], expected: Map<string, MemoryDocument>) {
    const hashes = new Map([...expected].map(([id, doc]) => [id, fingerprint(JSON.stringify(doc))]));
    removeDocuments(db, old.filter(row => {
      return row.hash !== hashes.get(row.id);
    }));
    const unchanged = new Set(old.filter(row => row.hash === hashes.get(row.id)).map(row => row.id));
    insertDocuments(db, [...expected.values()].filter(doc => !unchanged.has(doc.id)));
  }
  function sync(documents: MemoryDocument[]) {
    return use(db => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const expected = new Map(documents.filter(doc => active(doc)).map(doc => [doc.id, doc]));
        reconcile(db, db.prepare('SELECT rowid,id,hash FROM documents').all() as DocumentRow[], expected);
        // A caller replacing the complete index invalidates the journal cursor.
        db.prepare("DELETE FROM meta WHERE key='conversation_cursor'").run();
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    });
  }
  function syncConversation(source: ConversationIndexSource) {
    return use(db => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const raw = db.prepare("SELECT value FROM meta WHERE key='conversation_cursor'").get();
        const previous = raw ? JSON.parse(String(raw.value)) as {
          version: number; after: number; revision: string; cursor: number; tail: IndexedChatMessage[];
        } : undefined;
        const rebuild = !previous || previous.version !== CONVERSATION_INDEX_VERSION || previous.after !== source.after
          || previous.revision !== source.revision || previous.cursor > source.latestSequence;
        let cursor = rebuild ? source.after : previous.cursor;
        let chunks: IndexedChatMessage[][] = rebuild || !previous.tail.length ? [] : [[...previous.tail]];
        let read = 0;
        while (cursor < source.latestSequence) {
          const rows = source.since(cursor, 1000).filter(row => row.seq > cursor && row.seq <= source.latestSequence);
          if (!rows.length) break;
          read += rows.length;
          const next = chatChunks(rows, source.forgotten ?? [], chunks.pop() ?? []);
          chunks.push(...next);
          cursor = rows.at(-1)!.seq;
        }
        const expected = new Map([...source.documents, ...chunks.map(chunkDocument)].filter(doc => active(doc)).map(doc => [doc.id, doc]));
        // The indexed is_chat projection prevents a scan of sealed history on
        // an ordinary append or a correction to the small authoritative note set.
        const old = rebuild ? db.prepare('SELECT rowid,id,hash FROM documents').all()
          : db.prepare('SELECT rowid,id,hash FROM documents WHERE is_chat=0 OR id=?')
            .all(previous.tail.length ? `chat:${previous.tail[0].id}` : '');
        reconcile(db, old as DocumentRow[], expected);
        db.prepare("INSERT OR REPLACE INTO meta VALUES('conversation_cursor',?)").run(JSON.stringify({
          version: CONVERSATION_INDEX_VERSION, after: source.after, revision: source.revision, cursor,
          tail: chunks.at(-1) ?? [],
        }));
        db.exec('COMMIT');
        return { read, rebuilt: rebuild, through: cursor };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
  }
  function recordUsage(result:{tokens?:number;provider:string;model:string;usage?:Record<string,unknown>},kind:string){
    use(db=>{
      db.exec('BEGIN IMMEDIATE');
      try{
        const saved=db.prepare('INSERT INTO usage(at,tokens,kind) VALUES(?,?,?)').run(Date.now(),result.tokens??null,kind);
        db.prepare('INSERT INTO usage_details VALUES(?,?,?,?)').run(saved.lastInsertRowid,result.provider,result.model,
          result.usage?JSON.stringify(result.usage):null);
        db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
    });
  }
  async function index(config: EmbeddingConfig, signal?: AbortSignal, limit = 32) {
    const profile = embeddingProfile(config);
    const pending = use(db => {
      const table = ensureProfile(db, profile);
      return db.prepare(`SELECT rowid,id,hash,text FROM documents
        WHERE rowid NOT IN (SELECT rowid FROM ${table}) ORDER BY rowid LIMIT ?`).all(Math.min(64, Math.max(1, Math.trunc(limit))));
    });
    if (!pending.length) return { indexed: 0, tokens: 0 };
    const client = createEmbedder(config);
    try {
      const result = await client.embed(pending.map(row => String(row.text).slice(0, 6000)), 20000, signal);
      recordUsage(result,'index');
      if (signal?.aborted) return { indexed: 0, tokens: result.tokens };
      const indexed = use(db => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const table = ensureProfile(db, profile);
          let count = 0;
          pending.forEach((row, i) => {
            // Compare both identity and content version. A late request cannot
            // resurrect a deleted/corrected source, including during migration.
            const current = db.prepare('SELECT rowid,hash FROM documents WHERE id=?').get(row.id);
            if (current?.hash !== row.hash || current.rowid !== row.rowid) return;
            db.prepare(`DELETE FROM ${table} WHERE rowid=?`).run(BigInt(String(current.rowid)));
            db.prepare(`INSERT INTO ${table}(rowid,embedding) VALUES(?,?)`).run(BigInt(String(current.rowid)), new Float32Array(result.vectors[i])); count++;
          });
          db.exec('COMMIT'); return count;
        } catch (e) { db.exec('ROLLBACK'); throw e; }
      });
      return { indexed, tokens: result.tokens };
    } finally { await client.close(); }
  }
  function lexicalCandidates(db: DatabaseSync, query: string) {
    const match = memoryFtsQuery(query);
    const rows = match ? db.prepare(`SELECT d.id,d.value FROM documents_fts JOIN documents d ON d.rowid=documents_fts.rowid
      WHERE documents_fts MATCH ? ORDER BY bm25(documents_fts) LIMIT 128`)
      .all(match) : [];
    if (/怎么看我|对我的|了解我|我的习惯|我的性格|你觉得我/u.test(query))
      rows.push(...db.prepare("SELECT id,value FROM documents WHERE kind='observation' ORDER BY rowid DESC LIMIT 32").all());
    return [...new Map(rows.map(row => [String(row.id), JSON.parse(String(row.value)) as MemoryDocument])).values()];
  }
  async function search(query: string, options: { config?: EmbeddingConfig; signal?: AbortSignal; force?: boolean } = {}) {
    const started = Date.now();
    const documents = use(db => lexicalCandidates(db, query));
    const lexical = rankMemories(documents, query).slice(0, 16);
    const config = options.config ?? embeddingConfig();
    const profile = config ? embeddingProfile(config) : LEGACY_EMBEDDING_PROFILE;
    let semantic: { id: string; distance: number }[] = [], status = 'lexical';
    const count = use(db => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${ensureProfile(db, profile)}`).get()!.n));
    // Keep trivial acknowledgements off the network. References are embedded
    // with a bounded recent-topic supplement by the caller, without another LLM.
    if (config && count && (options.force || !/^(?:你好[呀啊]?|嗨|早[安啊]?|晚安|嗯[嗯啊]?|好[的呀啊]?|哈哈[哈]*|谢谢[你]?|行[吧啊]?)[。！!~～\s]*$/u.test(query.trim()))) {
      const client = createEmbedder(config);
      try {
        const queryText = query.slice(0, 2000);
        const key = fingerprint(`${profile.id}:${queryText}`);
        const cached = use(db => db.prepare('SELECT vector FROM query_cache WHERE hash=? AND at>?').get(key, Date.now() - 86400000));
        let vector: Float32Array;
        if (cached) { const blob = cached.vector as Uint8Array; vector = new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength)); }
        else {
          const result = await client.embed([queryText], config.queryTimeoutMs, options.signal, 'query');
          recordUsage(result,'query');
          vector = new Float32Array(result.vectors[0]);
          use(db => { db.prepare('INSERT OR REPLACE INTO query_cache VALUES(?,?,?)').run(key, Date.now(), vector);
            db.prepare('DELETE FROM query_cache WHERE at<?').run(Date.now() - 86400000); });
        }
        // The legacy cutoff is calibrated only for the original model. A new
        // profile supplies its own cutoff, or returns the nearest candidates.
        const maximum = config.maxDistance ?? (profile.id === LEGACY_EMBEDDING_PROFILE.id ? 0.72 : 2);
        semantic = use(db => db.prepare(`SELECT d.id,v.distance FROM ${vectorTable(profile)} v JOIN documents d ON d.rowid=v.rowid
          WHERE v.embedding MATCH ? AND k=16 ORDER BY v.distance`).all(vector)
          .map(row => ({ id: String(row.id), distance: Number(row.distance) })).filter(row => row.distance <= maximum));
        status = cached ? 'hybrid_cached' : 'hybrid';
      } catch { status = options.signal?.aborted ? 'cancelled' : 'lexical_fallback'; }
      finally { await client.close(); }
    }
    const scores = new Map<string, number>();
    for (const group of [lexical, semantic]) group.forEach((doc, i) => scores.set(doc.id, (scores.get(doc.id) ?? 0) + 1 / (30 + i)));
    const ids = [...scores].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    // Load only final candidate documents, after the API request: source
    // corrections/deletions during the request must be reflected in the result.
    const byId = use(db => new Map(ids.length ? db.prepare(`SELECT id,value FROM documents WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids).map(row => [String(row.id), JSON.parse(String(row.value)) as MemoryDocument]) : []));
    const hits = ids.map(id => byId.get(id)).filter((doc): doc is MemoryDocument => !!doc && active(doc)).slice(0, 5);
    return { hits, status, elapsedMs: Date.now() - started, indexed: count, profileId: profile.id, lexicalCandidates: documents.length };
  }
  function stats(config?: EmbeddingConfig) {
    const configured = config ?? embeddingConfig();
    const profile = configured ? embeddingProfile(configured) : LEGACY_EMBEDDING_PROFILE;
    return use(db => ({ documents: Number(db.prepare('SELECT COUNT(*) AS n FROM documents').get()!.n),
      indexed: Number(db.prepare(`SELECT COUNT(*) AS n FROM ${ensureProfile(db, profile)}`).get()!.n), profileId: profile.id,
      profiles: db.prepare('SELECT id,table_name FROM embedding_profiles').all()
        .filter(row => vectorTables(db).includes(String(row.table_name))).map(row => ({ id: String(row.id),
          indexed: Number(db.prepare(`SELECT COUNT(*) AS n FROM ${String(row.table_name)}`).get()!.n) })),
      usage: db.prepare('SELECT kind,SUM(tokens) AS tokens,COUNT(*) AS calls FROM usage GROUP BY kind').all() }));
  }
  return { path, sync, syncConversation, index, search, stats };
}
