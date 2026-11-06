import { createHash } from 'node:crypto';

type Place = 'home' | 'shop' | 'outside';
interface Action {
  place: Place; minutes: number; energy: number; text: string; outcome: string;
  discretionary?: boolean; purchase?: boolean; destination?: Place; withinRoutine?: boolean;
}

// The host owns time, location and resource costs. Specific experiences belong
// to the proposal and become memories only when the action actually completes.
// outcome is retained solely for pending actions created by the older protocol.
export const LIFE_ACTIONS: Record<string, Action> = {
  rest: { place: 'home', minutes: 20, energy: 15, text: '在住处休息一会儿', outcome: '休息了一会儿，恢复了点精神' },
  music: { place: 'home', minutes: 15, energy: 4, discretionary: true, text: '在住处听会儿歌', outcome: '听了一会儿熟悉的歌，放松下来' },
  meal: { place: 'home', minutes: 30, energy: 12, text: '在住处弄点吃的', outcome: '简单弄了点吃的，把饭吃完了' },
  shop_observation: { place: 'shop', minutes: 20, energy: -5, text: '留意门店陈列和客人的动线', outcome: '留意了门店陈列，记下一个以后可以继续比较的细节' },
  shopping: { place: 'home', minutes: 15, energy: -2, discretionary: true, purchase: true, text: '挑选需要的小东西', outcome: '挑选并买了需要的小东西' },
  outing: { place: 'home', destination: 'outside', minutes: 40, energy: -6, discretionary: true, purchase: true, text: '出门逛一会儿', outcome: '出门逛了一会儿' },
  walk: { place: 'home', destination: 'outside', minutes: 30, energy: -5, discretionary: true, text: '附近散步或看看橱窗，来回路程包含在时长内，不消费', outcome: '在附近走了走' },
  budget: { place: 'home', minutes: 25, energy: -8, discretionary: true, text: '整理小店开支中的一个具体问题', outcome: '把租金、进货和日常开销分开列了出来，还没有得出确定预算' },
  shop_moment: { place: 'shop', minutes: 5, energy: -1, withinRoutine: true, text: '店里手边的一件小事', outcome: '接着处理了店里的小事' },
  shop_break: { place: 'shop', minutes: 5, energy: 2, withinRoutine: true, text: '上班空当短暂歇口气', outcome: '在店里歇了一会儿' },
  home_moment: { place: 'home', minutes: 10, energy: -1, withinRoutine: true, text: '住处的一件小事或和小林的日常互动', outcome: '弄了点住处的小事' },
  curiosity: { place: 'home', minutes: 15, energy: -2, discretionary: true, text: '琢磨一个感兴趣的小问题', outcome: '琢磨了一会儿感兴趣的问题' },
  commute_moment: { place: 'outside', minutes: 3, energy: -1, withinRoutine: true, text: '路上的一个小见闻', outcome: '留意到路上的小事' },
};

export interface LifeExperience {
  activity: string; summary: string; feeling: string; moodDelta: number;
  participants: ('self' | 'roommate' | 'coworker' | 'customer')[];
  goalId?: string; step?: string; learning?: string; shareThought?: string;
}
export interface LifeProposal {
  action: string | null; reason: string; detail?: LifeExperience;
  purchase?: { amount: number; description: string }; nextInMinutes: number;
}
const short = (value: unknown, size: number) => typeof value === 'string' && !!value.trim() && value.length <= size;
export function parseLifeProposal(raw: string, requireDetail: boolean, goalIds: string[]): LifeProposal {
  const p = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, ''));
  if (!p || (p.action !== null && !Object.hasOwn(LIFE_ACTIONS, p.action)) || !short(p.reason, 200)) throw Error('Invalid life action');
  const nextInMinutes = p.nextInMinutes ?? 60;
  if (!Number.isFinite(nextInMinutes) || nextInMinutes < 45 || nextInMinutes > 180) throw Error('Invalid heartbeat interval');
  const d = p.detail;
  if (p.action !== null && requireDetail && !d) throw Error('Life action needs its concrete experience and feeling');
  if (d && (p.action === null || !short(d.activity, 220) || !short(d.summary, 400) || !short(d.feeling, 200)
    || !Number.isInteger(d.moodDelta) || Math.abs(d.moodDelta) > 6
    || !Array.isArray(d.participants) || !d.participants.includes('self') || d.participants.length > 4
    || !d.participants.every((v: string) => ['self', 'roommate', 'coworker', 'customer'].includes(v))
    || (d.goalId !== undefined && !goalIds.includes(d.goalId))
    || (d.step !== undefined && (!d.goalId || !short(d.step, 250)))
    || (d.learning !== undefined && (!d.goalId || !short(d.learning, 250)))
    || (d.shareThought !== undefined && !short(d.shareThought, 160)))) throw Error('Invalid life experience');
  if (p.purchase && (!Number.isFinite(p.purchase.amount) || p.purchase.amount <= 0 || !short(p.purchase.description, 160))) throw Error('Invalid life purchase');
  return { action: p.action, reason: p.reason, nextInMinutes, ...(d ? { detail: {
    activity: d.activity, summary: d.summary, feeling: d.feeling, moodDelta: d.moodDelta, participants: d.participants,
    ...(d.goalId ? { goalId: d.goalId } : {}), ...(d.step ? { step: d.step } : {}), ...(d.learning ? { learning: d.learning } : {}),
    ...(d.shareThought ? { shareThought: d.shareThought } : {}),
  } } : {}), ...(p.purchase ? { purchase: { amount: p.purchase.amount, description: p.purchase.description } } : {}) };
}

const cues = [
  { id: 'shop_object', place: 'shop', actions: ['shop_moment', 'shop_observation'], prompt: '手边的一件货品，某个颜色、手感或用起来的小细节让你多看了一眼。具体是什么，喜欢还是嫌弃，由你决定。' },
  { id: 'shop_customer', place: 'shop', actions: ['shop_moment', 'shop_observation'], prompt: '设想一个普通顾客挑选或结账的小习惯，可能有趣也可能有点烦；不用制造冲突或事故。' },
  { id: 'shop_pause', place: 'shop', actions: ['shop_break', 'shop_moment'], prompt: '手头有一个很短的空当。可以喝口水、摆弄手边东西、吃一小口已有零食，也可以仍然忙自己的。' },
  { id: 'home_food', place: 'home', actions: ['meal', 'home_moment'], prompt: '今天偏想吃哪一种具体味道？用家里已有的食材或零食安排一个小细节；想花钱购买则另选消费动作。' },
  { id: 'home_roommate', place: 'home', actions: ['home_moment'], prompt: '和小林共用的厨房或客厅里，有一件顺手的小事可接续。可以互相照顾、拌两句嘴，也可不理会；别预设每次都闹矛盾。' },
  { id: 'home_question', place: 'home', actions: ['curiosity', 'home_moment'], prompt: '一个具体的冷门问题或奇怪联想勾起好奇，可以只是没想明白；没有联网工具，不声称搜到或核验了答案。' },
  { id: 'home_taste', place: 'home', actions: ['music', 'rest', 'home_moment'], prompt: '留意眼前的旋律、抱枕、杯子或其他小物，顺着当下感觉弄一小会儿，不必每次总结放松和感悟。' },
  { id: 'home_shop', place: 'home', actions: ['budget', 'shopping', 'home_moment'], prompt: '从已有开店目标中挑一个还没解决的小问题，或看一件想买却没决定的小物；新的问题才继续，别重写同一份开支分类。' },
  { id: 'road_detail', place: 'outside', actions: ['commute_moment'], prompt: '路边一个气味、橱窗或普通的小见闻短暂吸引注意，不改变目的地，不凭空购物或安排见网友。' },
] as const;
export interface LifeCue { id: string; prompt: string; source: 'optional_simulation_idea'; trigger: 'idle' | 'chance' }
export function chooseLifeCue(seed: string, place: string, available: string[], idleStreak: number, recentIds: string[]): LifeCue | undefined {
  const hash = createHash('sha256').update(seed).digest();
  if (idleStreak < 2 && hash.readUInt32BE(0) / 0x100000000 >= 0.35) return;
  const compatible = cues.filter(cue => cue.place === place && cue.actions.some(action => available.includes(action)));
  const unused = compatible.filter(cue => !recentIds.includes(cue.id));
  const pool = unused.length ? unused : compatible;
  const cue = pool[hash.readUInt32BE(4) % pool.length];
  return cue ? { id: cue.id, prompt: cue.prompt, source: 'optional_simulation_idea', trigger: idleStreak >= 2 ? 'idle' : 'chance' } : undefined;
}

export function availableLifeActions(state: { activity: { place: string; source: string; until: number }; resources?: { energy: number; freeMinutes: number } },
  now: number, routineUntil: number, asleep: boolean): string[] {
  if (asleep || !['simulated_routine', 'simulated_commute'].includes(state.activity.source) && state.activity.until > now) return [];
  return Object.entries(LIFE_ACTIONS).filter(([, action]) => state.activity.place === action.place
    && now + action.minutes * 60000 <= routineUntil && (state.resources?.energy ?? 0) + action.energy >= 15
    && (!action.discretionary || (state.resources?.freeMinutes ?? 0) >= action.minutes)).map(([id]) => id);
}
