import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLifeStore, lifeOptions } from '../src/character-life.js';
import { beijingWeekStart, dailyLifePlan, weeklyLifePlan } from '../src/life-day-plan.js';

const at = (day: string, time = '10:00') => Date.parse(`${day}T${time}:00+08:00`);
function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'life-week-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, life: createLifeStore(root) };
}

test('week boundaries use Beijing Monday across Sunday, month and year changes', () => {
  assert.equal(beijingWeekStart(Date.parse('2026-11-08T15:59:59Z')), '2026-11-02');
  assert.equal(beijingWeekStart(Date.parse('2026-11-08T16:00:00Z')), '2026-11-09');
  assert.equal(beijingWeekStart(at('2027-01-01')), '2026-12-28');
  const monday = weeklyLifePlan(at('2026-11-02'));
  assert.deepEqual(weeklyLifePlan(at('2026-11-08')).days, monday.days);
  assert.equal(monday.days.length, 7);
  assert.equal(monday.days.filter(day => day.shift === 'off').length, 1);
});

test('one roster is saved before Monday morning and survives each day and restart without model calls', t => {
  const { root, life } = fixture(t), monday = at('2026-11-09', '00:02');
  assert.equal(life.ensureDayPlan(monday), undefined);
  const week = life.weekPlan(monday)!;
  assert.equal(week.generatedAt, monday);
  assert.equal(week.weekStart, '2026-11-09'); assert.equal(week.weekEnd, '2026-11-15');
  for (const entry of week.days) {
    const reopened = createLifeStore(root), now = at(entry.day);
    assert.deepEqual(reopened.ensureWeekPlan(now), week);
    assert.equal(reopened.ensureDayPlan(now)?.backdrop?.shift, entry.shift);
  }
  assert.equal(life.usage(monday).attempts.length, 0);
  assert.equal(life.documents().length, 0);
  const next = life.ensureWeekPlan(at('2026-11-16', '00:01'));
  assert.equal(next.weekStart, '2026-11-16');
  assert.deepEqual(life.weekPlan(monday), week);
});

test('midweek upgrade preserves existing shifts and custom hours without inventing missing past shifts', t => {
  const { life } = fixture(t);
  const tuesday = at('2026-11-03'), wednesday = at('2026-11-04'), friday = at('2026-11-06');
  life.saveDayPlan(JSON.stringify(dailyLifePlan(tuesday, undefined, 'off')), {}, tuesday);
  const boundaries = ['00:00','08:00','10:00','12:00','12:30','18:00','19:00','23:00','24:00'];
  const custom = { day: '2026-11-04', timezone: 'Asia/Shanghai', slots: boundaries.slice(1).map((to, i) => ({
    from: boundaries[i], to, place: i >= 2 && i <= 4 ? 'shop' : 'home', activity: '沿用已保存安排', feeling: '',
  })) };
  life.saveDayPlan(JSON.stringify(custom), {}, wednesday);
  life.saveDayPlan(JSON.stringify(dailyLifePlan(friday, undefined, 'late')), {}, friday);
  const before = life.dayPlan(wednesday);
  const week = life.ensureWeekPlan(friday);
  assert.equal(week.days[0].shift, null);
  assert.equal(week.days[0].source, 'unrecorded');
  assert.equal(week.days[1].shift, 'off');
  assert.equal(week.days[2].from, '10:00'); assert.equal(week.days[2].to, '18:00');
  assert.equal(week.days[4].shift, 'late');
  assert.ok(week.days.slice(5).every(day => day.shift && day.shift !== 'off'));
  assert.deepEqual(life.dayPlan(wednesday), before);
  assert.equal(week.generatedAt, friday, 'Do not pretend the migration was generated on Monday');
});

test('current activity cannot reroll a saved shift; generation and review receive the same weekly facts', t => {
  const { root, life } = fixture(t), monday = at('2026-11-09');
  const week = life.ensureWeekPlan(monday);
  const today = week.days[0];
  life.followSpokenActivity({ text: '在家收拾手边的东西', at: monday, until: monday + 3600000, messageId: 'real-sent' }, monday);
  const snapshot = life.snapshot(monday + 1000);
  assert.equal(snapshot.activity.source, 'dialogue:real-sent');
  assert.equal(snapshot.dayPlan?.backdrop?.shift, today.shift);
  assert.deepEqual(snapshot.weekPlan.days, week.days);
  const batch = life.claim(monday + 2000, true)!;
  assert.deepEqual(batch.weekPlan?.days, week.days);
  assert.match(lifeOptions(batch, root, root).prompt, /本周固定班表/);
  assert.equal(dailyLifePlan(monday, { place: 'shop' }, 'off').backdrop?.shift, 'off');
});
