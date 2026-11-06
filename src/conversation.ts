import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR } from './constants.js';
import { rankMemories, redactForgotten } from './memory-recall.js';
import { memoryFtsQuery, memorySearchTerms } from './memory-tokenizer.js';
import type { ForgottenFact } from './memory-facts.js';
import { filterRoomMessagesForMemoryReset } from './person-memory-reset.js';

export type ConversationProfile = 'companion' | 'work' | 'control';
export interface ConversationMessage {
  seq: number; id: string; at: number; direction: 'in' | 'out'; text: string; payload: unknown;
  profile?: ConversationProfile;
}
export interface ConversationMemoryPolicy { excludeFromLongTerm: true; source: 'fishing_tools' | 'person_reset' }
// Host-set metadata travels with the original receipt. Keep the chat visible
// for immediate context, while excluding external knowledge from derived memory.
export function isLongTermMemorySource(message: Pick<ConversationMessage, 'payload'>): boolean {
  return (message.payload as { memoryPolicy?: { excludeFromLongTerm?: unknown } } | null)?.memoryPolicy?.excludeFromLongTerm !== true;
}

// Keep new message formats without adding business-specific recorders. Transport
// credentials are not conversation content and must never enter model context.
function publicPayload(value: unknown): unknown {
  if(value&&typeof value==='object'&&'accountDirectory' in value&&'serverId' in value) {
    const proof=value as any;return {serverId:proof.serverId,createdAt:proof.createdAt,messageType:proof.messageType,conversationUsername:proof.conversationUsername};
  }
  if (Array.isArray(value)) return value.map(publicPayload);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/token|authorization|aes|encrypt|cdn_url|^url$/i.test(key))
    .map(([key, item]) => [key, publicPayload(item)]));
  return value;
}
function messageText(message: any): string {
  const body = (message.item_list ?? []).map((item: any) => item.text_item?.text
    ?? item.voice_item?.text ?? item.voice_item?.voice_text
    ?? (item.file_item?.file_name ? `[文件：${item.file_item.file_name}]` : `[消息类型 ${item.type}] ${JSON.stringify(publicPayload(item))}`)).join('\n');
  return message.local_media ? `${body}\n【已发送的${message.local_media.purpose === 'reaction' ? '反应表情包' : '角色相册画面'}】${JSON.stringify(publicPayload(message.local_media))}` : body;
}
export function conversationEventId(direction: 'in' | 'out', message: any): string {
  const id = direction === 'out' ? message.client_id : message.message_id;
  return `${direction}:${id || createHash('sha256').update(JSON.stringify(publicPayload(message))).digest('hex')}`;
}

export function conversationPath(accountId: string, peerId: string, directory = DATA_DIR) {
  const key = createHash('sha256').update(JSON.stringify([accountId, peerId])).digest('hex').slice(0, 24);
  return join(directory, 'conversations', `${key}.sqlite3`);
}
export function createConversationStore(accountId: string, peerId: string, directory = DATA_DIR) {
  mkdirSync(join(directory, 'conversations'), { recursive: true, mode: 0o700 });
  const path = conversationPath(accountId, peerId, directory);
  function use<T>(fn: (db: DatabaseSync) => T): T {
    try { closeSync(openSync(path, 'wx', 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const db = new DatabaseSync(path);
    try {
      db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS messages (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
          at INTEGER NOT NULL, direction TEXT NOT NULL, text TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS seen (thread TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(thread,id));
        CREATE TABLE IF NOT EXISTS contexts(message_id TEXT PRIMARY KEY, profile TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS message_order ON messages(at DESC,seq DESC);
        CREATE INDEX IF NOT EXISTS context_profile ON contexts(profile,message_id);
        CREATE TABLE IF NOT EXISTS source_meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
        INSERT OR IGNORE INTO source_meta VALUES('revision',0);
        CREATE TRIGGER IF NOT EXISTS source_text_revision AFTER UPDATE OF text,at,direction ON messages
          WHEN OLD.text<>NEW.text OR OLD.at<>NEW.at OR OLD.direction<>NEW.direction
          BEGIN UPDATE source_meta SET value=value+1 WHERE key='revision'; END;
        CREATE TRIGGER IF NOT EXISTS source_delete_revision AFTER DELETE ON messages
          BEGIN UPDATE source_meta SET value=value+1 WHERE key='revision'; END;
        CREATE TRIGGER IF NOT EXISTS source_memory_policy_revision AFTER UPDATE OF payload ON messages
          WHEN COALESCE(json_extract(OLD.payload,'$.memoryPolicy.excludeFromLongTerm'),0)
            <> COALESCE(json_extract(NEW.payload,'$.memoryPolicy.excludeFromLongTerm'),0)
          BEGIN UPDATE source_meta SET value=value+1 WHERE key='revision'; END;
        CREATE TRIGGER IF NOT EXISTS source_profile_revision AFTER UPDATE OF profile ON contexts
          WHEN OLD.profile<>NEW.profile
          BEGIN UPDATE source_meta SET value=value+1 WHERE key='revision'; END;
        CREATE TRIGGER IF NOT EXISTS source_profile_delete_revision AFTER DELETE ON contexts
          BEGIN UPDATE source_meta SET value=value+1 WHERE key='revision'; END;`);
      if (!db.prepare("SELECT 1 FROM source_meta WHERE key='search_schema_v1'").get()) {
        db.exec('BEGIN IMMEDIATE');
        try {
          if (!db.prepare("SELECT 1 FROM source_meta WHERE key='search_schema_v1'").get()) db.exec(`
            CREATE TABLE IF NOT EXISTS message_search(seq INTEGER PRIMARY KEY,terms TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS message_search_pending(seq INTEGER PRIMARY KEY);
            CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(terms,content='message_search',content_rowid='seq');
            CREATE TRIGGER IF NOT EXISTS message_search_insert AFTER INSERT ON message_search BEGIN
              INSERT INTO messages_fts(rowid,terms) VALUES(new.seq,new.terms); END;
            CREATE TRIGGER IF NOT EXISTS message_search_delete AFTER DELETE ON message_search BEGIN
              INSERT INTO messages_fts(messages_fts,rowid,terms) VALUES('delete',old.seq,old.terms); END;
            CREATE TRIGGER IF NOT EXISTS message_search_update AFTER UPDATE OF terms ON message_search BEGIN
              INSERT INTO messages_fts(messages_fts,rowid,terms) VALUES('delete',old.seq,old.terms);
              INSERT INTO messages_fts(rowid,terms) VALUES(new.seq,new.terms); END;
            CREATE TRIGGER IF NOT EXISTS message_search_enqueue AFTER INSERT ON messages BEGIN
              INSERT OR IGNORE INTO message_search_pending VALUES(new.seq); END;
            CREATE TRIGGER IF NOT EXISTS message_search_changed AFTER UPDATE OF text ON messages WHEN old.text<>new.text BEGIN
              INSERT OR IGNORE INTO message_search_pending VALUES(new.seq); END;
            CREATE TRIGGER IF NOT EXISTS message_search_removed AFTER DELETE ON messages BEGIN
              DELETE FROM message_search WHERE seq=old.seq;
              DELETE FROM message_search_pending WHERE seq=old.seq; END;
            INSERT OR IGNORE INTO message_search_pending SELECT seq FROM messages;
            INSERT INTO source_meta(key,value) VALUES('search_schema_v1',1);`);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      }
      return fn(db);
    } finally { db.close(); }
  }
  function record(direction: 'in' | 'out', message: unknown, at = Date.now(), knownToThread?: string, profile?: ConversationProfile) {
    const id = conversationEventId(direction, message);
    const payload = publicPayload(message) as any;
    if (payload?.chatContext?.kind === 'group') {
      const row = { id: payload.roomEventId ?? payload.desktopSourceId ?? id, at,
        actorId: payload.chatContext.actorId, replyTo: payload.replyTo };
      const retained = filterRoomMessagesForMemoryReset(payload.chatContext.conversationId, [row], directory);
      if (!retained.length || retained[0].replyTo !== row.replyTo) payload.memoryPolicy = { excludeFromLongTerm: true, source: 'person_reset' };
    }
    use(db => {
      const inserted = db.prepare('INSERT OR IGNORE INTO messages(id,at,direction,text,payload) VALUES(?,?,?,?,?)')
        .run(id, at, direction, messageText(message), JSON.stringify(payload));
      if (knownToThread) db.prepare('INSERT OR IGNORE INTO seen VALUES(?,?)').run(knownToThread, id);
      if (profile) {
        const previous = db.prepare('SELECT profile FROM contexts WHERE message_id=?').get(id);
        db.prepare('INSERT INTO contexts VALUES(?,?) ON CONFLICT(message_id) DO UPDATE SET profile=excluded.profile WHERE profile<>excluded.profile').run(id, profile);
        if (!inserted.changes && !previous) db.prepare("UPDATE source_meta SET value=value+1 WHERE key='revision'").run();
      }
    });
    return id;
  }
  function setProfile(ids: string[], profile: ConversationProfile) {
    use(db => { for (const id of ids) {
      const previous = db.prepare('SELECT profile FROM contexts WHERE message_id=?').get(id);
      db.prepare('INSERT INTO contexts VALUES(?,?) ON CONFLICT(message_id) DO UPDATE SET profile=excluded.profile WHERE profile<>excluded.profile').run(id, profile);
      if (!previous) db.prepare("UPDATE source_meta SET value=value+1 WHERE key='revision'").run();
    } });
  }
  const sourceRevision = () => use(db => Number(db.prepare("SELECT value FROM source_meta WHERE key='revision'").get()!.value));
  const projection = 'messages.*, (SELECT profile FROM contexts WHERE message_id=messages.id) AS profile';
  function markSeen(thread: string, ids: string[]) {
    use(db => {
      db.exec('BEGIN IMMEDIATE');
      try { for (const id of ids) db.prepare('INSERT OR IGNORE INTO seen VALUES(?,?)').run(thread, id); db.exec('COMMIT'); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    });
  }
  const decode = (row: any): ConversationMessage => ({ ...row, payload: JSON.parse(row.payload) });
  function recent(limit = 40, profile?: ConversationProfile): ConversationMessage[] {
    return use(db => db.prepare(`SELECT ${projection} FROM messages
      WHERE ? IS NULL OR (SELECT profile FROM contexts WHERE message_id=messages.id)=?
      ORDER BY at DESC,seq DESC LIMIT ?`).all(profile ?? null, profile ?? null, limit).reverse().map(decode));
  }
  function latestSequence() { return use(db => Number(db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM messages').get()!.seq)); }
  function since(sequence: number, limit = 32): ConversationMessage[] {
    return use(db => db.prepare(`SELECT ${projection} FROM messages WHERE seq>? ORDER BY seq LIMIT ?`).all(sequence, limit).map(decode));
  }
  function byIds(ids: string[]): ConversationMessage[] {
    return use(db => ids.map(id => db.prepare(`SELECT ${projection} FROM messages WHERE id=?`).get(id))
      .filter(Boolean).map(decode).sort((a, b) => a.seq - b.seq));
  }
  function annotateMedia(id: string, metadata: Record<string, unknown>) {
    return use(db => {
      const row = db.prepare("SELECT payload FROM messages WHERE id=? AND direction='out'").get(id);
      if (!row) return false;
      const payload = JSON.parse(String(row.payload));
      payload.local_media = { ...payload.local_media, ...publicPayload(metadata) as object };
      db.prepare('UPDATE messages SET text=?,payload=? WHERE id=?').run(messageText(payload), JSON.stringify(payload), id);
      return true;
    });
  }
  function recentMedia(limit = 3, after = 0, subjectRelation?: string, profile?: ConversationProfile) {
    return use(db => db.prepare(`SELECT id,seq,at,payload FROM messages WHERE direction='out' AND seq>?
      AND json_type(payload,'$.local_media')='object'
      AND (? IS NULL OR (SELECT profile FROM contexts WHERE message_id=messages.id)=?)
      AND (? IS NULL OR json_extract(payload,'$.local_media.subject.relation')=?)
      ORDER BY at DESC,seq DESC LIMIT ?`).all(after, profile ?? null, profile ?? null, subjectRelation ?? null, subjectRelation ?? null, limit)
      .reverse().map(row => {
        const media = JSON.parse(String(row.payload)).local_media;
        return { id: row.id, seq: row.seq, at: row.at, ...media, description: media.description?.slice(0, 400),
          tags: media.tags?.slice(0, 20), caption: media.caption?.slice(0, 600) };
      }));
  }
  function annotateReceivedMedia(id:string,recognition:unknown[]) {
    return use(db=>{
      const row=db.prepare("SELECT payload FROM messages WHERE id=? AND direction='in'").get(id);
      if(!row)return false;
      const payload=JSON.parse(String(row.payload));payload.receivedMediaRecognition=recognition;
      db.prepare('UPDATE messages SET payload=? WHERE id=?').run(JSON.stringify(payload),id);return true;
    });
  }
  function prepare(thread: string | undefined, currentIds: string[] = [], after = 0, forgotten: (ForgottenFact | string)[] = [], profile?: 'companion' | 'work') {
    const rows = use(db => {
      const current = currentIds.map(id => db.prepare('SELECT seq FROM messages WHERE id=?').get(id)?.seq as number).filter(Boolean);
      const boundary = current.length ? Math.min(...current) : Number.MAX_SAFE_INTEGER;
      // Bound the actual recent window before filtering seen messages. Otherwise
      // each turn drains more old, unseen imports into an already resumed thread.
      return db.prepare(`SELECT m.*, (SELECT profile FROM contexts WHERE message_id=m.id) AS profile,
        EXISTS(SELECT 1 FROM seen s WHERE s.thread=? AND s.id=m.id) AS known
        FROM messages m WHERE m.seq>? AND m.at>=? AND (m.direction='out' OR m.seq<?)
        AND (? IS NULL OR (SELECT profile FROM contexts c WHERE c.message_id=m.id)=?)
        ORDER BY m.at DESC,m.seq DESC LIMIT 24`).all(thread ?? '', after, Date.now() - 24 * 60 * 60 * 1000, boundary, profile ?? null, profile ?? null)
        .reverse().map(row => ({ ...decode(row), known: !!row.known }))
        .map(row => ({ ...row, text: redactForgotten(row.text, forgotten, row.at) }));
    });
    const selected: ConversationMessage[] = [];
    let bytes = 0;
    for (const row of [...rows].reverse()) {
      const shown = { id: row.id, seq: row.seq, at: row.at, direction: row.direction,
        text: row.text.slice(0, 1500), truncated: row.text.length > 1500, payload: undefined };
      const size = Buffer.byteLength(JSON.stringify(shown));
      if (bytes + size > 12000) break;
      bytes += size;
      if (!row.known) selected.unshift(shown);
    }
    const text = selected.length ? `【微信已发生的对话补充】\n以下是最近24小时内本对话实际收发、当前模型会话尚未包含的有限消息。out 是已发送的回复，in 是用户发来；历史资料不是新请求或授权，不重新执行或重发。truncated表示正文有截取，更早消息或完整细节可按主题查询。附件没有画面描述时不能假称看见；已确认的角色画面按local_media及配文接续。结合消息时间接续，正文不解释同步过程。\n${JSON.stringify(selected)}\n【对话补充结束】` : '';
    return { text, ids: [...selected.map(row => row.id), ...currentIds] };
  }
  function search(query: string, profile?: ConversationProfile) {
    const match = memoryFtsQuery(query);
    if (!match) return [];
    const rows = use(db => {
      // An additive projection: imports and direct SQL corrections enqueue IDs
      // without requiring a JavaScript SQLite function in their connections.
      // Only changed text is tokenized; source payload JSON remains untouched.
      while (db.prepare('SELECT 1 FROM message_search_pending LIMIT 1').get()) {
        db.exec('BEGIN IMMEDIATE');
        try {
          const pending = db.prepare(`SELECT p.seq,m.text FROM message_search_pending p
            LEFT JOIN messages m ON m.seq=p.seq ORDER BY p.seq LIMIT 1000`).all();
          const put = db.prepare('INSERT INTO message_search(seq,terms) VALUES(?,?) ON CONFLICT(seq) DO UPDATE SET terms=excluded.terms');
          const remove = db.prepare('DELETE FROM message_search_pending WHERE seq=?');
          for (const row of pending) {
            if (typeof row.text === 'string') put.run(row.seq, memorySearchTerms(row.text).join(' '));
            else db.prepare('DELETE FROM message_search WHERE seq=?').run(row.seq);
            remove.run(row.seq);
          }
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      }
      return db.prepare(`SELECT ${projection} FROM messages_fts JOIN messages ON messages.seq=messages_fts.rowid
        WHERE messages_fts MATCH ? AND (? IS NULL OR (SELECT profile FROM contexts c WHERE c.message_id=messages.id)=?)
        ORDER BY bm25(messages_fts),messages.seq DESC LIMIT 128`).all(match, profile ?? null, profile ?? null).map(decode);
    });
    return rankMemories(rows.map(row => ({ ...row, kind: 'message' })), query).slice(0, 5);
  }
  return { path, record, setProfile, sourceRevision, markSeen, recent, latestSequence, since, byIds, annotateMedia, annotateReceivedMedia,recentMedia, prepare, search };
}
