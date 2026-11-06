import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Job, JobStatus } from '../src/jobs.js';

const root = mkdtempSync(join(tmpdir(), 'independent-heartbeat-'));
process.env.WCB_DATA_DIR = root;
const { createLifeScheduler, LIFE_ACCOUNT_ID } = await import('../src/life-scheduler.js');
const { createLifeStore } = await import('../src/character-life.js');
const { dailyLifePlan } = await import('../src/life-day-plan.js');
test.after(() => rmSync(root, { recursive: true, force: true }));
const evening = Date.parse('2026-11-02T20:00:00+08:00');
const reply = (action: string | null = null) => ({
  replyText: JSON.stringify({ action, reason: '根据当前安排选择', ...(action ? { detail: {
    activity: '留意眼前杯子的一个具体细节', summary: '把浅绿色杯子挪到窗边，看了一会儿杯沿的反光', feeling: '这个颜色看着挺舒服',
    moodDelta: 2, participants: ['self'],
  } } : {}) }), commands: [], fileChanges: [],
});

function fixture() {
  const directory = mkdtempSync(join(root, 'world-'));
  mkdirSync(join(directory, 'persona'));
  writeFileSync(join(directory, 'persona.md'), '核心人格 v6\n测试人格');
  for (const name of ['BACKSTORY', 'RELATIONSHIP', 'STYLE']) writeFileSync(join(directory, 'persona', `${name}.md`), '隔离测试');
  const records = new Map<string, Job>();
  const statuses = new Map<string, JobStatus>();
  let now = evening, launches = 0;
  const jobs = {
    create(input: Omit<Job, 'id' | 'createdAt'>) {
      const job: Job = { ...input, id: randomUUID(), createdAt: now };
      records.set(job.id, job);
      statuses.set(job.id, { state: 'pending', phase: 'pending', updatedAt: now });
      return job;
    },
    read(id: string) { return records.get(id)!; },
    inspect(id: string) { return statuses.get(id)!; },
    launch(job: Job) { launches++; statuses.set(job.id, { state: 'running', phase: 'running', updatedAt: now }); },
    stopped() { return false; },
  };
  const life = createLifeStore(join(directory, 'character-life'));
  life.saveDayPlan(JSON.stringify(dailyLifePlan(evening - 11 * 3600000, { place: 'shop' })), {}, evening);
  return { directory, jobs, records, statuses, life,
    scheduler: () => createLifeScheduler(directory, jobs, () => now),
    advance(ms: number) { now += ms; }, setTime(at: number) { now = at; }, launches: () => launches,
    complete(id: string, result = reply(), state: JobStatus['state'] = 'completed') {
      statuses.set(id, { state, phase: state, updatedAt: now, result });
    } };
}

test('one character heartbeat runs without a WeChat account and ignores busy or switched chat sessions', () => {
  const f = fixture();
  mkdirSync(join(f.directory, 'sessions'));
  const sessionPath = join(f.directory, 'sessions', 'owner.json');
  writeFileSync(sessionPath, JSON.stringify({ state: 'processing', chatMode: 'assistant', activeJobId: 'chat',
    workJobId: 'work', backgroundJobId: 'consolidation', queuePaused: true, lastInputAt: evening }));
  const original = readFileSync(sessionPath, 'utf8');
  const scheduler = f.scheduler();
  const id = scheduler.poll().activeJobId!;
  assert.ok(id);
  const job = f.records.get(id)!;
  assert.equal(job.accountId, LIFE_ACCOUNT_ID);
  assert.equal(job.fromUserId, ''); assert.equal(job.contextToken, '');
  assert.equal(job.session.activeJobId, undefined); assert.equal(job.options?.conversation, undefined);
  f.advance(1000); f.complete(id);
  assert.equal(scheduler.poll().committed, true);
  assert.equal(readFileSync(sessionPath, 'utf8'), original);
  assert.equal(f.life.usage(evening).attempts[0].status, 'committed');
});

test('restarting or reattaching the scheduler collects one existing worker without another model generation', () => {
  const f = fixture();
  const first = f.scheduler();
  const id = first.poll().activeJobId!;
  const restarted = f.scheduler();
  assert.equal(restarted.poll().activeJobId, id);
  assert.equal(f.launches(), 1);
  f.advance(1000); f.complete(id, reply('budget'));
  assert.equal(restarted.poll().committed, true);
  assert.equal(f.scheduler().activeJob(), undefined);
  assert.equal(f.scheduler().poll().activeJobId, undefined);
  assert.equal(f.launches(), 1);
  assert.equal(f.life.snapshot(evening + 2000).recent.length, 0);
  const later = f.life.snapshot(evening + 26 * 60000);
  assert.equal(later.recent.length, 1);
  assert.equal(f.life.snapshot(evening + 27 * 60000).recent.length, 1);
});

test('a delivered change of activity invalidates an in-flight proposal without cancelling the independent worker', () => {
  const f = fixture(), scheduler = f.scheduler();
  const id = scheduler.poll().activeJobId!;
  f.advance(1000);
  f.life.followSpokenActivity({ text: '准备睡了', at: evening + 1000, until: evening + 3600000,
    messageId: 'actual-delivery' }, evening + 1000);
  assert.equal(scheduler.poll().activeJobId, id);
  f.complete(id, reply('budget'));
  assert.equal(scheduler.poll().committed, false);
  assert.equal(f.life.snapshot(evening + 2000).activity.text, '准备睡了');
  assert.equal(f.life.snapshot(evening + 2000).pending, undefined);
  assert.equal(f.life.usage(evening).attempts[0].status, 'discarded');
});

test('malformed, failed or stale results never change the world or trap the scheduler on the same checkpoint', () => {
  for (const kind of ['malformed', 'failed', 'stale'] as const) {
    const f = fixture(), scheduler = f.scheduler();
    const id = scheduler.poll().activeJobId!;
    f.advance(kind === 'stale' ? 6 * 60000 : 1000);
    f.complete(id, kind === 'malformed' ? { ...reply(), replyText: '{invalid' } : reply('budget'),
      kind === 'failed' ? 'failed' : 'completed');
    assert.equal(scheduler.poll().committed, false);
    assert.equal(scheduler.activeJob(), undefined);
    assert.equal(f.life.usage(evening).attempts[0].status, 'discarded');
    assert.equal(f.life.snapshot(evening + 7 * 60000).pending, undefined);
    assert.equal(f.life.documents().length, 0);
  }
});

test('sleep and launch failure retain spending limits and do not depend on a chat daemon', () => {
  const sleeping = fixture();
  sleeping.setTime(Date.parse('2026-11-02T03:00:00+08:00'));
  assert.equal(sleeping.scheduler().poll().activeJobId, undefined);
  assert.equal(sleeping.launches(), 0);
  const f = fixture();
  f.jobs.launch = () => { throw new Error('synthetic launch failure'); };
  const scheduler = f.scheduler();
  assert.throws(() => scheduler.poll(), /synthetic launch failure/);
  assert.equal(scheduler.activeJob(), undefined);
  assert.equal(f.life.usage(evening).attempts[0].status, 'discarded');
  assert.equal(scheduler.poll().activeJobId, undefined);
});

test('purchases start from home and charge only one completed event within budget', () => {
  for(const action of ['shopping','outing']){
    const f=fixture(),scheduler=f.scheduler(),id=scheduler.poll().activeJobId!;
    const initial=f.life.metrics.snapshot(undefined,evening).finance.cash;
    f.advance(1000);f.complete(id,{...reply(),replyText:JSON.stringify({...JSON.parse(reply(action).replyText),purchase:{amount:50,description:'日常小物件'}})});
    assert.equal(scheduler.poll().committed,true);
    assert.equal(f.life.snapshot(evening+1000).pending?.action,action);
    assert.equal(f.life.metrics.snapshot(undefined,evening+1000).finance.cash,initial);
    if(action==='outing')assert.equal(f.life.snapshot(evening+1000).activity.place,'outside');
    f.life.snapshot(evening+42*60000);f.life.snapshot(evening+43*60000);
    assert.equal(f.life.metrics.snapshot(undefined,evening+43*60000).finance.cash,initial-50);
    assert.equal(f.life.metrics.ledger().filter(row=>row.category===action).length,1);
  }
});

function heartbeatRows(directory: string) {
  const db = new DatabaseSync(join(directory, 'character-life', 'heartbeat-log.sqlite3'), { readOnly: true });
  try { return db.prepare('SELECT value FROM heartbeats ORDER BY at,rowid').all().map(row => JSON.parse(String(row.value))); }
  finally { db.close(); }
}

test('heartbeat records every scheduled check and model settlement, with only the configured administrator affection', () => {
  const f = fixture(), folder = join(f.directory, 'character-life');
  writeFileSync(join(folder, 'heartbeat-log.json'), JSON.stringify({ adminMetricKey: 'admin' }));
  f.life.metrics.snapshot('admin', evening);
  f.life.metrics.observe('admin', 'admin-message', '聊得开心', { intent: 'chat', effect: 'bonding', mode: 'reply', userQuote: '开心' }, evening);
  f.life.metrics.snapshot('someone-else', evening);
  const scheduler = f.scheduler(), id = scheduler.poll().activeJobId!;
  const initial = heartbeatRows(f.directory);
  assert.equal(initial.length, 1);
  assert.equal(initial[0].after.administratorAffection, 0.5);
  assert.equal(initial[0].after.finance.cash, f.life.metrics.inspect()!.finance.cash);
  assert.ok(!JSON.stringify(initial).includes('someone-else'));
  f.advance(1000);
  scheduler.poll();
  assert.equal(heartbeatRows(f.directory).length, 1, 'one-second worker polling is not another heartbeat');
  f.complete(id);
  scheduler.poll();
  const settled = heartbeatRows(f.directory);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].kind, 'committed');
  assert.equal(settled[0].finishedAt, evening + 1000);
  f.life.metrics.spend('chat-spending', 12, 'test', '已发生的消费', evening + 1000);
  f.advance(7 * 60000);
  scheduler.poll();
  const checks = heartbeatRows(f.directory);
  assert.equal(checks.length, 2);
  assert.equal(checks[1].kind, 'check');
  assert.equal(checks[1].after.finance.cash - checks[1].previous.after.finance.cash, -12);
  assert.ok(checks[1].after.energy < checks[1].previous.after.energy);
});

test('parameter logging survives restart without replaying a model and preserves discarded result snapshots', () => {
  const f = fixture(), scheduler = f.scheduler(), id = scheduler.poll().activeJobId!;
  const restarted = f.scheduler();
  restarted.poll();
  assert.equal(heartbeatRows(f.directory).length, 1);
  f.advance(1000); f.complete(id, reply(), 'failed');
  restarted.poll();
  const rows = heartbeatRows(f.directory);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'discarded');
  assert.equal(rows[0].after.administratorAffection, null);
  assert.equal(f.launches(), 1);
});
