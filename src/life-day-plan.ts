import type { CodexRunResult } from './codex/bridge.js';
import { createHash } from 'node:crypto';

export const LIFE_TIMEZONE = 'Asia/Shanghai';
export type LifeWorkShift = 'early' | 'late' | 'off';
export interface LifeWeekPlan {
  weekStart: string;
  weekEnd: string;
  timezone: typeof LIFE_TIMEZONE;
  generatedAt: number;
  source: 'weekly_roster';
  days: { day: string; shift: LifeWorkShift | null; label: string; from?: string; to?: string;
    source: 'weekly_roster' | 'existing_day_plan' | 'unrecorded' }[];
}
const DAY_MS = 86400000;
const sample = (key: string) => createHash('sha256').update(`ruanruan:${key}`).digest().readUInt32BE(0);
const shiftLabels = { early: '早班 09:00–17:30', late: '晚班 13:00–21:30', off: '轮休' };
export function beijingTime(at = Date.now()) {
  return new Date(at).toLocaleString('sv-SE', { timeZone: LIFE_TIMEZONE });
}
export function beijingWeekStart(at: number) {
  const localDay = Date.parse(beijingTime(at).slice(0, 10));
  return new Date(localDay - ((new Date(localDay).getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
}

// One local roster, persisted by the life store. No model call or reroll.
// A midweek upgrade keeps known shifts and leaves missing past days unknown.
export function weeklyLifePlan(now: number, existing: LifeDayPlan[] = [], preservePast = false): LifeWeekPlan {
  const weekStart = beijingWeekStart(now), today = beijingTime(now).slice(0, 10);
  const dates = Array.from({ length: 7 }, (_, i) => new Date(Date.parse(weekStart) + i * DAY_MS).toISOString().slice(0, 10));
  const inherited = new Map(existing.map(plan => {
    const work = plan.slots.filter(slot => slot.place === 'shop');
    const shift = plan.backdrop?.shift ?? (!work.length ? 'off' : work[0].from < '13:00' ? 'early' : 'late');
    const from = shift === 'off' ? undefined : work[0]?.from;
    const to = shift === 'off' ? undefined : work.at(-1)?.to;
    const label = plan.backdrop?.label ?? (shift === 'off' ? shiftLabels.off : `${shift === 'early' ? '早班' : '晚班'} ${from}–${to}`);
    return [plan.day, { day: plan.day, shift, label, from, to, source: 'existing_day_plan' as const }] as const;
  }));
  const open = dates.filter(day => !inherited.has(day) && (!preservePast || day >= today));
  const alreadyOff = dates.some(day => inherited.get(day)?.shift === 'off');
  const off = !alreadyOff && open.length ? open[sample(`week:${weekStart}`) % open.length] : undefined;
  return { weekStart, weekEnd: dates[6], timezone: LIFE_TIMEZONE, generatedAt: now, source: 'weekly_roster',
    days: dates.map(day => {
      const known = inherited.get(day);
      if (known) return known;
      if (preservePast && day < today) return { day, shift: null, label: '历史排班未记录', source: 'unrecorded' };
      const shift: LifeWorkShift = day === off ? 'off' : sample(`${weekStart}:${day}`) % 2 ? 'early' : 'late';
      return { day, shift, label: shiftLabels[shift], source: 'weekly_roster',
        ...(shift === 'off' ? {} : { from: shift === 'early' ? '09:00' : '13:00', to: shift === 'early' ? '17:30' : '21:30' }) };
    }) };
}

export function weekPlanContext(plan: LifeWeekPlan) {
  return { ...plan, status: 'fixed_weekly_roster',
    note: '每周一统一确定周一至周日的班表，周内心跳和聊天沿用；当前活动不会重排班次。排班只说明工作安排，不证明已经出勤或完成活动。' };
}
export interface DayPlanSlot {
  from: string;
  to: string;
  place: 'home' | 'shop' | 'outside';
  activity: string;
  feeling: string;
  phase?: 'asleep' | 'morning' | 'work' | 'meal' | 'commute' | 'leisure' | 'evening';
}
export interface LifeDayPlan {
  day: string;
  timezone: typeof LIFE_TIMEZONE;
  generatedAt: number;
  slots: DayPlanSlot[];
  source?: 'daily_routine';
  backdrop?: { shift: 'early' | 'late' | 'off'; label: string; roommate: string; interest: string; weather: 'unknown' };
  usage: Pick<CodexRunResult, 'generationProvider' | 'providerModel' | 'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'reasoningOutputTokens' | 'timing'>;
}
const minute = (time: string) => time === '24:00' ? 1440 : /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)
  ? Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) : NaN;

export function parseDayPlan(raw: string, now = Date.now(), usage: LifeDayPlan['usage'] = {}): LifeDayPlan {
  const value = JSON.parse(raw);
  const day = beijingTime(now).slice(0, 10);
  if (value?.day !== day || value.timezone !== LIFE_TIMEZONE || !Array.isArray(value.slots)
    || value.slots.length < 8 || value.slots.length > 32) throw new Error('Invalid Beijing day plan');
  let end = 0;
  const slots = value.slots.map((slot: DayPlanSlot) => {
    if (!slot || typeof slot.from !== 'string' || typeof slot.to !== 'string'
      || minute(slot.from) !== end || !Number.isFinite(minute(slot.to)) || minute(slot.to) <= end
      || !['home', 'shop', 'outside'].includes(slot.place)
      || typeof slot.activity !== 'string' || !slot.activity.trim() || slot.activity.length > 160
      || typeof slot.feeling !== 'string' || slot.feeling.length > 100) throw new Error('Invalid day plan interval');
    end = minute(slot.to);
    if (slot.phase !== undefined && !['asleep', 'morning', 'work', 'meal', 'commute', 'leisure', 'evening'].includes(slot.phase)) throw new Error('Invalid day plan phase');
    return { from: slot.from, to: slot.to, place: slot.place, activity: slot.activity, feeling: slot.feeling,
      ...(slot.phase ? { phase: slot.phase } : {}) };
  });
  if (end !== 1440) throw new Error('Day plan must cover 00:00–24:00');
  return { day, timezone: LIFE_TIMEZONE, generatedAt: now, slots, usage };
}

// Daily interests and free-time intentions vary; the saved weekly shift does not.
export function dailyLifePlan(now: number, anchor?: { place: DayPlanSlot['place'] }, scheduledShift?: LifeWorkShift): LifeDayPlan {
  const day = beijingTime(now).slice(0, 10);
  let shift = scheduledShift ?? weeklyLifePlan(now).days.find(entry => entry.day === day)!.shift!;
  const localMinute = minute(beijingTime(now).slice(11, 16));
  if (!scheduledShift && anchor?.place === 'shop') shift = localMinute < 13 * 60 ? 'early' : localMinute >= 17 * 60 + 30 ? 'late' : shift === 'off' ? 'early' : shift;
  const interests = ['好吃的热食和咸口零食', '杯子的颜色、手感和是否值得买', '一段喜欢的旋律', '一个还没弄懂的冷门问题', '小店里让人逛着舒服的细节'];
  const roommates = ['各忙各的，碰上了再聊两句', '小林今天可能晚归，晚饭先自己安排', '想找空当和小林一起吃点东西'];
  const backdrop: NonNullable<LifeDayPlan['backdrop']> = { shift,
    label: shiftLabels[shift],
    roommate: roommates[sample(`${day}:roommate`) % roommates.length], interest: interests[sample(`${day}:interest`) % interests.length], weather: 'unknown' };
  const slots: DayPlanSlot[] = [];
  const add = (to: string, place: DayPlanSlot['place'], phase: NonNullable<DayPlanSlot['phase']>, activity: string) =>
    slots.push({ from: slots.at(-1)?.to ?? '00:00', to, place, phase, activity, feeling: '' });
  add('08:00', 'home', 'asleep', '夜间在住处休息，是否睡着沿用已确认状态');
  if (shift === 'early') {
    add('08:30', 'home', 'morning', '洗漱，吃点早饭'); add('09:00', 'outside', 'commute', '预留去门店的路程');
    add('12:00', 'shop', 'work', '收银、补货，留意手边的小事'); add('12:30', 'shop', 'meal', '轮流吃午饭');
    add('17:30', 'shop', 'work', '接着上班，忙闲看当时情况'); add('18:00', 'outside', 'commute', '下班回住处');
    add('19:00', 'home', 'meal', '安排晚饭'); add('21:00', 'home', 'leisure', `有兴致时弄点自己的事：${backdrop.interest}`);
  } else if (shift === 'late') {
    add('09:00', 'home', 'morning', '慢慢起身，吃早饭'); add('11:30', 'home', 'leisure', `上午留给自己：${backdrop.interest}`);
    add('12:30', 'home', 'meal', '吃午饭，准备出门'); add('13:00', 'outside', 'commute', '预留去门店的路程');
    add('17:00', 'shop', 'work', '收银、理货，接续店里的小事'); add('17:30', 'shop', 'meal', '轮流吃晚饭');
    add('21:30', 'shop', 'work', '接着上班，临近下班整理手头的事'); add('22:00', 'outside', 'commute', '下班回住处');
  } else {
    add('09:00', 'home', 'morning', '休息日慢慢吃早饭'); add('11:00', 'home', 'leisure', `随自己兴致安排：${backdrop.interest}`);
    add('12:00', 'home', 'meal', '吃午饭'); add('15:00', 'home', 'leisure', '可以出门慢慢逛，也可以继续待着，暂未决定');
    add('18:00', 'home', 'leisure', '留出一段不赶时间的空当'); add('19:00', 'home', 'meal', '安排晚饭');
    add('21:00', 'home', 'leisure', '弄点自己喜欢的小事');
  }
  add('23:00', 'home', 'evening', '回到住处放松，想不想和小林聊看当时心情');
  add('24:00', 'home', 'asleep', '准备夜间休息，是否睡着沿用已确认状态');
  return { ...parseDayPlan(JSON.stringify({ day, timezone: LIFE_TIMEZONE, slots }), now), source: 'daily_routine', backdrop };
}

export function currentPlanSlot(plan: LifeDayPlan | undefined, now: number) {
  if (plan?.day !== beijingTime(now).slice(0, 10)) return undefined;
  const time = minute(beijingTime(now).slice(11, 16));
  return plan.slots.find(slot => minute(slot.from) <= time && time < minute(slot.to));
}

// Past drafts never become recollections. The next few intentions can guide
// the existing causal engine; only its completed actions create memories.
export function dayPlanContext(plan: LifeDayPlan | undefined, now: number) {
  const local = beijingTime(now);
  if (!plan || plan.day !== local.slice(0, 10)) return undefined;
  const currentMinute = minute(local.slice(11, 16));
  return { day: plan.day, timezone: LIFE_TIMEZONE, status: 'intentions_only',
    backdrop: plan.backdrop,
    note: '生活安排是意向，不能声称已经做过。班次沿用本周固定班表；休闲意向可调整，实际对话、当前活动及已完成事件保持原有事实。',
    slots: plan.slots.filter(slot => minute(slot.to) > currentMinute && minute(slot.from) < currentMinute + 180).slice(0, 4) };
}
