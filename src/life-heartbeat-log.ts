import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { createCharacterMetrics } from './character-metrics.js';

type Metrics = ReturnType<typeof createCharacterMetrics>;
export function createHeartbeatLog(directory: string, metrics: Metrics) {
  function use<T>(fn: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(join(directory, 'heartbeat-log.sqlite3'));
    try {
      db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS heartbeats(id TEXT PRIMARY KEY,at INTEGER NOT NULL,value TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS heartbeats_at ON heartbeats(at);
        BEGIN IMMEDIATE;`);
      const result = fn(db); db.exec('COMMIT'); return result;
    } finally { db.close(); }
  }
  function capture() {
    let adminMetricKey: string | undefined;
    try {
      const config = JSON.parse(readFileSync(join(directory, 'heartbeat-log.json'), 'utf8'));
      if (typeof config.adminMetricKey === 'string') adminMetricKey = config.adminMetricKey;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const value = metrics.inspect(adminMetricKey);
    if (!value) return null;
    return { at: value.at, energy: value.energy, energyState: value.energyState,
      mood: value.mood, finance: value.finance,
      administratorAffection: value.relationship?.affection ?? null };
  }
  type Sample = ReturnType<typeof capture>;
  function due(at: number, interval: number) {
    return use(db => {
      const row = db.prepare('SELECT at FROM heartbeats ORDER BY at DESC LIMIT 1').get();
      return !row || at - Number(row.at) >= interval;
    });
  }
  function record(at: number, before: Sample, attemptId?: string) {
    const after = capture();
    return use(db => {
      const prior = db.prepare('SELECT value FROM heartbeats ORDER BY at DESC,rowid DESC LIMIT 1').get();
      const last = prior ? JSON.parse(String(prior.value)) : undefined;
      const id = attemptId ?? randomUUID();
      const entry = { id, at, kind: attemptId ? 'started' : 'check', attemptId, before, after,
        previous: last ? { at: last.finishedAt ?? last.at, after: last.after } : undefined };
      db.prepare('INSERT INTO heartbeats VALUES(?,?,?)').run(id, at, JSON.stringify(entry));
      return entry;
    });
  }
  function finish(attemptId: string, at: number, before: Sample, committed: boolean, error?: string) {
    const after = capture();
    use(db => {
      const row = db.prepare('SELECT value FROM heartbeats WHERE id=?').get(attemptId);
      const entry = row ? JSON.parse(String(row.value)) : { id: attemptId, at, attemptId, before };
      Object.assign(entry, { kind: committed ? 'committed' : 'discarded', after, finishedAt: at, error });
      db.prepare('INSERT OR REPLACE INTO heartbeats VALUES(?,?,?)').run(attemptId, entry.at, JSON.stringify(entry));
    });
  }
  return { capture, due, record, finish };
}
