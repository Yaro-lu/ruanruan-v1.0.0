import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ConversationMessage } from './conversation.js';

const HOUR = 3600000;
export type StateKey = 'activity' | 'plan' | 'attention' | 'feeling' | 'openThread';
export interface ContinuityEntry {
  key: StateKey; text: string; messageId: string; evidence: string; until?: number; validForMinutes?: number;
}
export interface StoredEntry extends ContinuityEntry { at: number; until: number }
const limits: Record<StateKey, number> = { activity: 2 * HOUR, plan: 24 * HOUR,
  attention: 3 * 24 * HOUR, feeling: 4 * HOUR, openThread: 7 * 24 * HOUR };

export function createContinuityStore(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  function use<T>(fn: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(join(directory, 'continuity.sqlite3'));
    try {
      db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value INTEGER NOT NULL);`);
      return fn(db);
    } finally { db.close(); }
  }
  function meta() {
    return use(db => Object.fromEntries(db.prepare('SELECT * FROM meta').all()
      .map(row => [String(row.key), Number(row.value)]))) as Record<string, number>;
  }
  function attempted(at = Date.now()) {
    use(db => db.prepare("INSERT OR REPLACE INTO meta VALUES('attempted',?)").run(at));
  }
  function snapshot(now = Date.now()) {
    const entries = use(db => db.prepare('SELECT value FROM state').all()
      .map(row => JSON.parse(String(row.value)) as StoredEntry));
    return { active: entries.filter(row => row.until > now),
      previousActivity: entries.find(row => row.key === 'activity' && row.until <= now && row.at > now - 24 * HOUR) };
  }
  function validate(updates: ContinuityEntry[], messages: ConversationMessage[]) {
    if (!Array.isArray(updates) || updates.length > 5) throw new Error('状态更新格式错误');
    const keys = new Set<string>();
    return updates.map(entry => {
      const source = messages.find(row => row.id === entry?.messageId);
      const until = entry?.until ?? ((source?.at ?? NaN) + (entry?.validForMinutes ?? NaN) * 60000);
      if (!entry || !Object.hasOwn(limits, entry.key) || keys.has(entry.key)
        || typeof entry.text !== 'string' || !entry.text.trim() || entry.text.length > 400
        || typeof entry.evidence !== 'string' || !entry.evidence.trim() || entry.evidence.length > 500
        || !source?.text.includes(entry.evidence) || !Number.isFinite(until)
        || until < source.at || until > source.at + limits[entry.key]) throw new Error('状态缺少有效消息来源或时间边界');
      keys.add(entry.key);
      return { ...entry, at: source.at, until };
    });
  }
  function commit(updates: StoredEntry[], through: number) {
    use(db => {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const entry of updates) {
          const previous = db.prepare('SELECT value FROM state WHERE key=?').get(entry.key);
          if (!previous || JSON.parse(String(previous.value)).at <= entry.at)
            db.prepare('INSERT OR REPLACE INTO state VALUES(?,?)').run(entry.key, JSON.stringify(entry));
        }
        db.prepare("INSERT INTO meta VALUES('through',?) ON CONFLICT(key) DO UPDATE SET value=MAX(value,excluded.value)").run(through);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
  }
  function clear() { use(db => db.exec('DELETE FROM state')); }
  return { meta, attempted, snapshot, validate, commit, clear };
}

export function continuityContext(store: ReturnType<typeof createContinuityStore>, messages: ConversationMessage[], currentIds: string[] = [], now = Date.now()) {
  const lastInput = [...messages].reverse().find(row => row.direction === 'in' && row.profile === 'companion' && !currentIds.includes(row.id));
  return { now: new Date(now).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }), timezone: 'Asia/Shanghai',
    minutesSincePreviousInput: lastInput ? Math.max(0, Math.floor((now - lastInput.at) / 60000)) : null,
    ...store.snapshot(now), consolidatedThrough: store.meta().through ?? 0 };
}
