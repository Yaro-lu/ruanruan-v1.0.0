import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR } from './constants.js';

export interface MediaIdentity { assetId: string; contentHash: string; sourceGroup: string }

// A delivery ledger, independent from persona memory and conversation resets.
export function createMediaState(owner: string, directory = DATA_DIR) {
  const key = createHash('sha256').update(owner).digest('hex').slice(0, 20);
  const folder = join(directory, 'media-state');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, key + '.sqlite3');
  function use<T>(action: (db: DatabaseSync) => T): T {
    try { closeSync(openSync(path, 'wx', 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const db = new DatabaseSync(path);
    try {
      db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS sends(job_id TEXT PRIMARY KEY,asset_id TEXT NOT NULL,
          content_hash TEXT NOT NULL,source_group TEXT NOT NULL,sent_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS sent_asset ON sends(asset_id);
        CREATE TABLE IF NOT EXISTS reservations(job_id TEXT PRIMARY KEY,asset_id TEXT UNIQUE NOT NULL,content_hash TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        BEGIN IMMEDIATE;`);
      try {
        if (!db.prepare("SELECT 1 FROM meta WHERE key='legacy-imported'").get()) {
          let old: { sent: { jobId: string; assetId: string; at: number }[] } = { sent: [] };
          try { old = JSON.parse(readFileSync(join(directory, `media-history-${key}.json`), 'utf8')); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          for (const row of old.sent) db.prepare('INSERT OR IGNORE INTO sends VALUES(?,?,?,?,?)')
            .run(row.jobId, row.assetId, '', row.assetId, row.at);
          db.prepare("INSERT INTO meta VALUES('legacy-imported','1')").run();
        }
        const result = action(db); db.exec('COMMIT'); return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } finally { db.close(); }
  }
  function snapshot() {
    return use(db => ({
      sent: db.prepare('SELECT asset_id AS assetId,content_hash AS contentHash,MAX(sent_at) AS at FROM sends GROUP BY asset_id,content_hash').all() as unknown as { assetId: string; contentHash: string; at: number }[],
      recentGroups: db.prepare('SELECT source_group AS sourceGroup FROM sends ORDER BY sent_at DESC,rowid DESC LIMIT 3').all().map(row => String(row.sourceGroup)),
      reserved: db.prepare('SELECT asset_id AS assetId,content_hash AS contentHash FROM reservations').all() as unknown as { assetId: string; contentHash: string }[],
    }));
  }
  function reserve(jobId: string, asset: MediaIdentity, allowRepeat = false) {
    return use(db => {
      const previous = db.prepare('SELECT asset_id FROM sends WHERE job_id=?').get(jobId)
        ?? db.prepare('SELECT asset_id FROM reservations WHERE job_id=?').get(jobId);
      if (previous) return previous.asset_id === asset.assetId;
      if (db.prepare("SELECT 1 FROM reservations WHERE asset_id=? OR (?<>'' AND content_hash=?)")
        .get(asset.assetId, asset.contentHash, asset.contentHash)) return false;
      if (!allowRepeat && db.prepare("SELECT 1 FROM sends WHERE asset_id=? OR (?<>'' AND content_hash=?)")
        .get(asset.assetId, asset.contentHash, asset.contentHash)) return false;
      db.prepare('INSERT INTO reservations VALUES(?,?,?)').run(jobId, asset.assetId, asset.contentHash);
      return true;
    });
  }
  function confirm(jobId: string, asset: MediaIdentity, sentAt = Date.now()) {
    use(db => {
      db.prepare(`INSERT INTO sends VALUES(?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET
        content_hash=excluded.content_hash,source_group=excluded.source_group
        WHERE sends.asset_id=excluded.asset_id`)
        .run(jobId, asset.assetId, asset.contentHash, asset.sourceGroup, sentAt);
      db.prepare('DELETE FROM reservations WHERE job_id=?').run(jobId);
    });
  }
  function release(jobId: string) { use(db => db.prepare('DELETE FROM reservations WHERE job_id=?').run(jobId)); }
  return { path, snapshot, reserve, confirm, release };
}
