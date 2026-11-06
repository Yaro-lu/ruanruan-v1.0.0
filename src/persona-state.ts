import { DatabaseSync } from 'node:sqlite';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';

export const MOOD_TTL_MS = 4 * 60 * 60 * 1000;
const TOPIC_TTL_MS = 24 * 60 * 60 * 1000;
const OPEN_THREAD_TTL_MS = 3 * TOPIC_TTL_MS;
const moods = ['neutral', 'excited', 'annoyed', 'serious', 'pleased', 'curious', 'embarrassed', 'disappointed', 'relaxed', 'mixed'] as const;
type Mood = typeof moods[number];
interface Detail { text: string; evidence: string }
export interface InteractionUpdate {
  topic?: Detail | null;
  openThread?: Detail | null;
  recentEvent?: Detail | null;
  afterglow?: Detail | null;
  mood?: { value: Mood; reason: string; evidence: string } | null;
}

export function validInteraction(value: unknown): value is InteractionUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as InteractionUpdate;
  const detail = (d: Detail | null | undefined) => d == null || (typeof d.text === 'string'
    && !!d.text.trim() && d.text.length <= 300 && typeof d.evidence === 'string'
    && !!d.evidence.trim() && d.evidence.length <= 500);
  return detail(v.topic) && detail(v.openThread) && detail(v.recentEvent) && detail(v.afterglow) && (v.mood == null
    || (moods.includes(v.mood.value) && typeof v.mood.reason === 'string'
      && !!v.mood.reason.trim() && v.mood.reason.length <= 300
      && typeof v.mood.evidence === 'string' && !!v.mood.evidence.trim() && v.mood.evidence.length <= 500));
}

// One database per existing account memory directory; no external service or model.
export function createInteractionStore(directory: string) {
  const path = join(directory, 'persona.sqlite3');
  function use<T>(fn: (db: DatabaseSync) => T): T {
    try { closeSync(openSync(path, 'wx', 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const db = new DatabaseSync(path);
    try {
      db.exec(`PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS interaction (
          key TEXT PRIMARY KEY, value TEXT NOT NULL, source TEXT NOT NULL,
          updated_at INTEGER NOT NULL, expires_at INTEGER
        );`);
      return fn(db);
    } finally { db.close(); }
  }

  function observe(user: string, now = Date.now()) {
    // Mode is a transport command (/Q), never inferred from conversation text.
  }

  function snapshot(now = Date.now()) {
    return use(db => {
      const rows = db.prepare("SELECT * FROM interaction WHERE key<>'mode' AND (expires_at IS NULL OR expires_at > ?)").all(now);
      const state: Record<string, unknown> = { mode: 'character', relationship: '从陌生开始，依实际相处逐渐了解' };
      for (const row of rows) state[String(row.key)] = { value: JSON.parse(String(row.value)),
        source: row.source, updatedAt: new Date(Number(row.updated_at)).toISOString(),
        expiresAt: row.expires_at == null ? null : new Date(Number(row.expires_at)).toISOString() };
      // Legacy interaction state never controls the transport-level /Q mode.
      const mode = state.mode as { value?: string } | string;
      state.mode = typeof mode === 'string' ? mode : mode.value;
      return state;
    });
  }

  function update(user: string, reply: string, delta: InteractionUpdate, now = Date.now()) {
    const changes: { key: string; value: unknown; evidence: string; ttl: number }[] = [];
    let rejected = false;
    for (const key of ['topic', 'openThread', 'recentEvent', 'afterglow', 'mood'] as const) {
      const detail = delta[key];
      if (detail === undefined) continue;
      if (detail === null) {
        changes.push({ key, value: null, evidence: '', ttl: 0 });
        continue;
      }
      if (!user.includes(detail.evidence) && !reply.includes(detail.evidence)) { rejected = true; continue; }
      changes.push({ key, value: detail, evidence: detail.evidence,
        ttl: key === 'mood' || key === 'afterglow' ? MOOD_TTL_MS
          : key === 'topic' ? TOPIC_TTL_MS : OPEN_THREAD_TTL_MS });
    }
    use(db => {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const change of changes) {
          if (change.value === null || (change.key === 'mood' && (change.value as { value: Mood }).value === 'neutral')) {
            db.prepare('DELETE FROM interaction WHERE key=?').run(change.key);
          } else {
            db.prepare(`INSERT INTO interaction VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value, source=excluded.source,
              updated_at=excluded.updated_at, expires_at=excluded.expires_at`)
              .run(change.key, JSON.stringify(change.value), change.evidence, now, now + change.ttl);
          }
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
    return !rejected;
  }

  function clearTransient() { use(db => db.exec("DELETE FROM interaction WHERE key <> 'mode'")); }
  return { path, observe, snapshot, update, clearTransient };
}
