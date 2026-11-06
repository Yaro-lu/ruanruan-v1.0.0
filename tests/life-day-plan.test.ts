import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beijingTime, parseDayPlan, dayPlanContext } from '../src/life-day-plan.js';
import { createLifeStore, lifeOptions } from '../src/character-life.js';

const now = Date.parse('2026-10-29T20:00:00+08:00');
const draft = () => ({ day: '2026-10-29', timezone: 'Asia/Shanghai', slots: Array.from({ length: 8 }, (_, i) => ({
  from: `${String(i * 3).padStart(2, '0')}:00`, to: `${String((i + 1) * 3).padStart(2, '0')}:00`,
  place: 'home', activity: i === 6 ? '听一会儿歌' : '休息', feeling: '',
})) });
test('day boundaries and displayed times use Beijing even under a UTC server process', () => {
  assert.equal(beijingTime(Date.parse('2026-10-28T16:30:00Z')), '2026-10-29 00:30:00');
  const plan = parseDayPlan(JSON.stringify(draft()), now);
  assert.equal(dayPlanContext(plan, Date.parse('2026-10-29T15:59:00Z'))?.day, '2026-10-29');
  assert.equal(dayPlanContext(plan, Date.parse('2026-10-29T16:00:00Z')), undefined);
  assert.throws(() => parseDayPlan(JSON.stringify({ ...draft(), timezone: 'UTC' }), now));
  const gap = draft(); gap.slots[2].from = '06:30';
  assert.throws(() => parseDayPlan(JSON.stringify(gap), now));
  const overlap = draft(); overlap.slots[2].to = '10:00';
  assert.throws(() => parseDayPlan(JSON.stringify(overlap), now));
});
test('a whole-day draft guides later heartbeats without overwriting current state or creating memories', () => {
  const root = mkdtempSync(join(tmpdir(), 'life-plan-'));
  try {
    const life = createLifeStore(root);
    const prior = life.tick(now);
    life.saveDayPlan(JSON.stringify(draft()), { generationProvider: 'api', providerModel: 'gpt-6.1-sol' }, now);
    const after = life.snapshot(now);
    assert.deepEqual(after.activity, prior.activity);
    assert.equal(after.revision, prior.revision);
    assert.deepEqual(after.recent, []);
    assert.equal(life.documents().length, 0);
    assert.deepEqual(after.dayPlan?.slots.map(s => s.from), ['18:00', '21:00']);
    assert.equal(after.dayPlan?.status, 'intentions_only');
    const batch = life.claim(now, true)!;
    assert.ok(batch.dayPlan);
    const options = lifeOptions(batch, root, root);
    assert.match(options.prompt, /当前北京时间：2026-10-29 20:00:00/);
    assert.match(options.prompt, /听一会儿歌/);
    assert.throws(() => life.saveDayPlan(JSON.stringify(draft()), {}, now));
    life.followSpokenActivity({ text: '躺下准备睡了', at: now + 1000, until: now + 3600000, messageId: 'sent' }, now + 1000);
    assert.equal(life.snapshot(now + 2000).activity.text, '躺下准备睡了');
    assert.equal(life.documents().length, 0);
    assert.deepEqual(createLifeStore(root).dayPlan(now)?.slots, draft().slots);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
