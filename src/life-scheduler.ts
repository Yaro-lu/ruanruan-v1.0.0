import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './constants.js';
import { createLifeStore, lifeOptions, LIFE_TICK_MS } from './character-life.js';
import { atomicWrite, createJob, inspectJob, isTerminal, launchJob, readJob, stopRequested } from './jobs.js';
import { loadPersonaSnapshot } from './persona.js';
import { logger } from './logger.js';
import { createHeartbeatLog } from './life-heartbeat-log.js';
import { beijingTime } from './life-day-plan.js';

const defaultJobs = { create: createJob, inspect: inspectJob, launch: launchJob, read: readJob, stopped: stopRequested };
export const LIFE_ACCOUNT_ID = 'character:ruanruan';

// Owned by the character, not a WeChat account/session. The service holds a
// process lock; SQLite claim/settle also arbitrate concurrent world updates.
export function createLifeScheduler(directory = DATA_DIR, jobs = defaultJobs, clock = Date.now) {
  const folder = join(directory, 'character-life');
  const cwd = join(folder, 'workspace');
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const checkpoint = join(folder, 'heartbeat-job.json');
  const life = createLifeStore(folder);
  const heartbeatLog = createHeartbeatLog(folder, life.metrics);
  let preparedPeriod: string | undefined;
  // Log failures must not retry a model call or change the world's decisions.
  function audit<T>(action: () => T): T | undefined {
    try { return action(); }
    catch (error) { logger.warn('Heartbeat parameter log failed', { error: String(error) }); }
  }
  function activeJob(): string | undefined {
    try { return JSON.parse(readFileSync(checkpoint, 'utf8')).activeJobId; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  function save(activeJobId?: string) { atomicWrite(checkpoint, { activeJobId, updatedAt: clock() }); }

  function poll() {
    const version = loadPersonaSnapshot(true, directory)?.version;
    const enabled = version === 'ruanruan-core-v5' || version === 'ruanruan-core-v6';
    const local = beijingTime(clock());
    const period = local.slice(0, 10) + (local.slice(11, 16) < '08:00' ? ':night' : ':day');
    if (enabled && preparedPeriod !== period) { life.ensureDayPlan(clock()); preparedPeriod = period; }
    const id = activeJob();
    if (id) {
      const job = jobs.read(id);
      if (job.kind !== 'life' || !job.life) throw new Error('Heartbeat checkpoint does not reference a life job');
      const status = jobs.inspect(id);
      if (!isTerminal(status)) {
        const record = enabled && audit(() => heartbeatLog.due(clock(), LIFE_TICK_MS));
        const before = record ? audit(() => heartbeatLog.capture()) : null;
        if (enabled) life.tick(clock());
        if (record) audit(() => heartbeatLog.record(clock(), before ?? null));
        return { delayMs: 1000, activeJobId: id };
      }
      const before = audit(() => heartbeatLog.capture());
      const result = status.result ?? { replyText: '', commands: [], fileChanges: [] };
      const canCommit = enabled && status.state === 'completed' && !!status.result && !jobs.stopped(id);
      let committed = false;
      try { committed = life.settle(job.life, result, canCommit, clock()); }
      catch (error) {
        // A malformed proposal remains a failed attempt, never a world update.
        life.settle(job.life, { ...result, error: String(error) }, false, clock());
        logger.warn('Independent heartbeat proposal rejected', { id, error: String(error) });
      }
      save();
      audit(() => heartbeatLog.finish(job.life!.id, clock(), before ?? null, committed, result.error));
      logger.info('Independent character heartbeat finished', { id, committed, model: job.options?.model,
        inputTokens: result.inputTokens, outputTokens: result.outputTokens });
      return { delayMs: LIFE_TICK_MS, finishedJobId: id, committed };
    }
    if (!enabled) return { delayMs: LIFE_TICK_MS };
    const before = audit(() => heartbeatLog.capture());
    // The weekly roster is established locally even while another heartbeat
    // is active; after 08:00 its shift guides today's optional activities.
    const batch = life.claim(clock(), version === 'ruanruan-core-v6');
    if (!batch) {
      audit(() => heartbeatLog.record(clock(), before ?? null));
      return { delayMs: LIFE_TICK_MS };
    }
    try {
      const options = lifeOptions(batch, cwd, directory);
      const job = jobs.create({ accountId: LIFE_ACCOUNT_ID, kind: 'life', life: batch, options,
        userText: '', fromUserId: '', contextToken: '', tempFiles: [],
        session: { workingDirectory: cwd, state: 'idle' } });
      // Persist before launch: restarting the scheduler attaches to the existing
      // worker instead of spending quota on another generation.
      save(job.id);
      audit(() => heartbeatLog.record(clock(), before ?? null, batch.id));
      jobs.launch(job);
      logger.info('Independent character heartbeat started', { id: job.id, model: options.model,
        provider: options.generationProvider });
      return { delayMs: 1000, activeJobId: job.id };
    } catch (error) {
      life.settle(batch, { replyText: '', commands: [], fileChanges: [], error: String(error) }, false, clock());
      save();
      audit(() => heartbeatLog.finish(batch.id, clock(), before ?? null, false, String(error)));
      throw error;
    }
  }
  return { poll, activeJob };
}
