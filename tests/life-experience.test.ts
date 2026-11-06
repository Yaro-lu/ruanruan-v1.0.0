import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLifeStore, lifeOptions } from '../src/character-life.js';
import { dailyLifePlan } from '../src/life-day-plan.js';
import { chooseLifeCue, parseLifeProposal } from '../src/life-actions.js';

const at = Date.parse('2026-11-03T10:00:00+08:00');
function fixture(t: any) {
  const directory = mkdtempSync(join(tmpdir(), 'life-experience-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, life: createLifeStore(directory) };
}
const detail = { activity: '把奶黄色杯子放到自然光下看杯沿', summary: '理货时把奶黄色杯子转了半圈，发现杯沿有一条浅色细线',
  feeling: '这个配色还挺耐看，先不买', moodDelta: 2, participants: ['self'], shareThought: '有点想给熟人看看那个奶黄色杯子的配色',
  goalId: 'small_shop', step: '下一次比较同色杯子放在一起会不会更好挑', learning: '同一个杯子换个摆放角度，颜色层次更容易看清' };
const result = (action: string | null, value = detail) => ({ replyText: JSON.stringify({ action, reason: '手边有一点空当，自己想看看',
  ...(action ? { detail: value } : {}), nextInMinutes: 45 }), commands: [], fileChanges: [] });

test('daily setup is stable, refreshes by Beijing day, rotates shifts and never invents live weather', t => {
  const { life } = fixture(t);
  assert.equal(life.ensureDayPlan(Date.parse('2026-11-03T07:59:00+08:00')), undefined);
  const first = life.ensureDayPlan(at)!;
  assert.deepEqual(life.ensureDayPlan(at + 3600000), first);
  assert.equal(first.source, 'daily_routine'); assert.equal(first.backdrop?.weather, 'unknown');
  assert.equal(life.ensureDayPlan(at + 86400000)?.day, '2026-11-04');
  const shifts = new Set(Array.from({ length: 21 }, (_, i) => dailyLifePlan(at + i * 86400000).backdrop!.shift));
  assert.deepEqual([...shifts].sort(), ['early', 'late', 'off']);
  assert.equal(life.documents().length, 0);
});

test('concrete detail, mood, sharing thought and goal change only after completion; no anticipated outcome leaks', t => {
  const { life } = fixture(t);
  life.saveDayPlan(JSON.stringify(dailyLifePlan(at, { place: 'shop' })), {}, at);
  const b = life.claim(at, true)!;
  assert.ok(b.availableActions?.includes('shop_moment'));
  assert.equal(life.settle(b, result('shop_moment'), true, at + 1000), true);
  const pending = life.snapshot(at + 2000);
  assert.equal(pending.recent.length, 0); assert.equal(pending.shareThought, undefined);
  assert.doesNotMatch(JSON.stringify(pending.pending), /浅色细线|自己想看看之外的感受/);
  const finished = life.snapshot(at + 6 * 60000);
  assert.equal(finished.recent[0].summary, detail.summary); assert.equal(finished.feeling, detail.feeling);
  assert.equal(finished.shareThought?.text, detail.shareThought); assert.equal(finished.goals[0].step, detail.step);
  assert.equal(finished.activity.place, 'shop'); assert.equal(finished.activity.source, 'simulated_routine');
  assert.equal(finished.resources?.freeMinutes, 120, 'ordinary work detail does not consume personal leisure allowance');
  assert.equal(life.snapshot(at + 7 * 60000).recent.length, 1);
  assert.equal(life.snapshot(at + 4 * 3600000).shareThought, undefined);
});

test('two quiet decisions offer a fresh optional idea without forcing an event or permanently banning an action', t => {
  const { life, directory } = fixture(t);
  for (const offset of [0, 46, 92]) {
    const now = at + offset * 60000, b = life.claim(now, true)!;
    if (offset === 92) {
      assert.ok(b.cue); assert.equal(b.cue?.trigger, 'idle');
      assert.ok(b.availableActions?.includes('shop_observation'));
      const prompt = lifeOptions(b, directory, directory);
      assert.doesNotMatch(prompt.prompt, /简单弄了点吃的，把饭吃完了/);
      assert.match(prompt.developerInstructions!, /不是行动类别黑名单/);
    }
    life.settle(b, result(null), true, now + 1000);
  }
  assert.equal(life.snapshot(at + 94 * 60000).recent.length, 0);
  assert.equal(chooseLifeCue('constant', 'shop', ['shop_moment'], 2, [])?.id,
    chooseLifeCue('constant', 'shop', ['shop_moment'], 2, [])?.id);
  assert.equal(chooseLifeCue('constant', 'shop', [], 9, []), undefined);
});

test('spoken activity interrupts a proposed experience and invalid details cannot invent user participation', t => {
  const { life } = fixture(t), b = life.claim(at, true)!;
  life.settle(b, result('shop_moment'), true, at + 1000);
  life.followSpokenActivity({ text: '已经回到住处了', at: at + 2000, until: at + 3600000, messageId: 'delivered' }, at + 2000);
  assert.equal(life.snapshot(at + 6 * 60000).recent.length, 0);
  assert.throws(() => parseLifeProposal(JSON.stringify({ action: 'shop_moment', reason: '看看', detail: { ...detail, participants: ['self', 'user'] } }), true, ['small_shop']));
  assert.throws(() => parseLifeProposal('{"action":"meal","reason":"饿了"}', true, ['small_shop']));
});
