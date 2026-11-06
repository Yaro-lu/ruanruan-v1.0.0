import { setTimeout } from 'node:timers/promises';
import { createLifeScheduler } from './life-scheduler.js';
import { LIFE_TICK_MS } from './character-life.js';
import { beijingTime } from './life-day-plan.js';
import { logger } from './logger.js';

const controller = new AbortController();
const scheduler = createLifeScheduler();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
console.log(`${beijingTime()} independent character heartbeat started (Asia/Shanghai)`);

while (!controller.signal.aborted) {
  let delay = LIFE_TICK_MS;
  try { delay = scheduler.poll().delayMs; }
  catch (error) { logger.warn('Independent heartbeat scheduler failed', { error: String(error) }); }
  try { await setTimeout(delay, undefined, { signal: controller.signal }); }
  catch (error) { if (!controller.signal.aborted) throw error; }
}
// Workers are durable systemd jobs. A scheduler restart must not cancel them;
// the next process collects their result through heartbeat-job.json.
console.log(`${beijingTime()} independent character heartbeat scheduler stopped`);
