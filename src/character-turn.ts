import { validSocialDecision, type SocialDecision } from './character-metrics.js';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ConversationMessage } from './conversation.js';
import type { StateKey } from './continuity.js';
import type { RelationshipEvidence } from './relationship.js';
import { suppressedByForgetting } from './memory-recall.js';

export const CHARACTER_STATE_MARKER = '<<<RUANRUAN_STATE>>>';
interface Citation { userQuote: string; replyQuote: string }
export interface CharacterUpdate {
  social?: SocialDecision;
  imageRequestId?: string;
  cancelImageTaskId?: string;
  stance?: Citation & { kind?: 'choice' | 'boundary'; topic: string; scope: 'topic' | 'interaction'; sharing: 'open' | 'limited' | 'declined'; meaning: string };
  state?: { key: StateKey; text: string; replyQuote: string; validForMinutes: number }[];
  relationship?: (Citation & Pick<RelationshipEvidence, 'axis' | 'effect' | 'topic' | 'meaning'>)[];
}
export const SHARING_CHOICE_CONTRACT = 'choice只记录本次选择，不建立后续限制；当前资料中的boundaries才是持续界限，sharing=open撤回对应限制。kind与scope分别表示持续性和影响范围。';
export const CHARACTER_TURN_INSTRUCTIONS = `内部接续协议：正文后另起一行输出 ${CHARACTER_STATE_MARKER} 和JSON对象，入口隐藏。无更新用{}，不输出推理。最多一个stance、两个state、两个relationship；只记录本轮已表达且需要接续的内容。
stance仅用于明确持续的界限；普通单次选择不记stance，也不为引用补台词。stance:{"kind":"boundary","topic":"稳定事项名","scope":"topic或interaction","sharing":"open或limited或declined","meaning":"已表达的变化","userQuote":"本轮用户原句","replyQuote":"正文原句"}。同类同事项复用topic。${SHARING_CHOICE_CONTRACT}
state:[{"key":"activity/plan/attention/feeling/openThread","text":"状态内容","replyQuote":"正文原句","validForMinutes":30}]。activity为当前活动，plan为未来意向；有效期上限依次为120/1440/4320/240/10080分钟，结束用0。
relationship:[{"axis":"familiarity/trust/comfort/openness","effect":"learned/supported/strained/repaired","topic":"事项","meaning":"本轮实际变化","userQuote":"用户原句","replyQuote":"正文原句"}]。
可选social:{"intent":"chat/joke/vent/help/conflict/closing","effect":"none/bonding/important/disrespect/harassment/repair","mode":"reply|quiet|pause","userQuote":"本轮用户原句","minutes":15}。repair可带repair:"attempt或completed"；completed另需replyQuote为正文里明确已经修复的原句。quiet的正文为空，pause先输出正文后暂停1至120分钟；好感和conflict余气的数值、衰减及修复时机由程序计算，不填写数值。
媒体：选相册用[[ASSET:本轮候选编号]]；确认character_scene的generation_proposed提案用imageRequestId=requestId；取消未发送图片用cancelImageTaskId=对应任务id。每轮至多一个媒体。媒体动作mediaAction由程序计算，状态JSON不填写此字段。未确认的提案不执行，确认生图在文字实际送达后排入后台；回执前不属于已发送。
引用必须来自本轮双方连续原文，程序绑定实际消息与时间，仅成功投递的状态落库。工具与参数以本轮工具定义为准。`;

export function parseCharacterReply(raw: string): { reply: string; update?: CharacterUpdate } {
  const index = raw.indexOf(CHARACTER_STATE_MARKER);
  if (index < 0) return { reply: raw.trim() };
  const reply = raw.slice(0, index).trim();
  try {
    const value = JSON.parse(raw.slice(index + CHARACTER_STATE_MARKER.length).trim());
    if (!value || Array.isArray(value) || typeof value !== 'object'
      || (value.state !== undefined && (!Array.isArray(value.state) || value.state.length > 2))
      || (value.relationship !== undefined && (!Array.isArray(value.relationship) || value.relationship.length > 2))) return { reply };
    if (value.social !== undefined && (!validSocialDecision(value.social)
      || value.social.repair === 'completed' && !reply.includes(value.social.replyQuote))) delete value.social;
    for(const key of ['imageRequestId','cancelImageTaskId'])if(value[key]!==undefined&&(typeof value[key]!=='string'||!/^[a-f0-9-]{36}$/i.test(value[key])))delete value[key];
    const fields = ['social', 'imageRequestId', 'cancelImageTaskId', 'stance', 'state', 'relationship'];
    return { reply, update: Object.fromEntries(Object.entries(value).filter(([key]) => fields.includes(key))) };
  } catch { return { reply }; }
}
export function createCharacterTurnStore(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  function use<T>(fn: (db: DatabaseSync) => T) {
    const path = join(directory, 'character-turn.sqlite3');
    try { closeSync(openSync(path, 'wx', 0o600)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    const db = new DatabaseSync(path);
    try { db.exec('PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS stances(id TEXT PRIMARY KEY,topic TEXT,at INTEGER,value TEXT)'); return fn(db); }
    finally { db.close(); }
  }
  function snapshot(forgotten: string[] = [], now = Date.now()) {
    return use(db => db.prepare('SELECT value FROM stances ORDER BY at,id').all().map(row => JSON.parse(String(row.value))))
      .map(row => ({ ...row, kind: row.kind ?? 'choice' }))
      .filter(row => !suppressedByForgetting(JSON.stringify(row), forgotten))
      .reduce((all: any[], row) => [...all.filter(item => item.kind !== row.kind || item.scope !== row.scope || item.topic !== row.topic), row], [])
      .filter(row => row.kind === 'boundary' || row.at > now - 7 * 86400000);
  }
  function context(forgotten: string[] = [], now = Date.now()) {
    const rows = snapshot(forgotten, now);
    // One-off choices already exist in the delivered dialogue. Repeating them
    // as pinned state turns yesterday's refusal into today's default policy.
    return { boundaries: rows.filter(row => row.kind === 'boundary' && row.sharing !== 'open').slice(-4) };
  }
  function commit(update: CharacterUpdate | undefined, messages: ConversationMessage[], memory: {
    continuity: { validate: Function; commit: Function; meta: Function };
    relationship: { validate: Function; commit: Function }; life: { followSpokenActivity: Function; observeDialogue: Function };
  }) {
    const stats = { stances: 0, states: 0, relationships: 0, rejected: 0 };
    const rows = messages.filter(row => row.profile === 'companion');
    // Delivery establishes wakefulness, not a preceding sleep/wakeup event.
    const spoken = rows.filter(row => row.direction === 'out' && ((row.payload as any)?.item_list ?? [])
      .some((item: any) => item.text_item?.text?.trim())).sort((a, b) => a.at - b.at).at(-1);
    if (spoken) memory.life.observeDialogue(spoken.at);
    if (!update) return stats;
    const quote = (direction: 'in' | 'out', text: unknown) => typeof text === 'string' && text.trim() && text.length <= 400
      ? rows.find(row => {
        const payload = row.payload as any;
        const spoken = payload?.local_media ? (payload.item_list ?? []).map((item: any) => item.text_item?.text ?? '').join('\n') : row.text;
        return row.direction === direction && spoken.includes(text);
      }) : undefined;
    const apply = (fn: () => void) => { try { fn(); } catch { stats.rejected++; } };
    if (update.stance?.kind==='boundary') apply(() => {
      const entry = update.stance!, source = quote('in', entry.userQuote), reply = quote('out', entry.replyQuote);
      if (!source || !reply || reply.at < source.at || !['topic', 'interaction'].includes(entry.scope)
        || !['choice', 'boundary'].includes(entry.kind ?? 'choice')
        || !['open', 'limited', 'declined'].includes(entry.sharing)
        || typeof entry.topic !== 'string' || !entry.topic.trim() || entry.topic.length > 60
        || typeof entry.meaning !== 'string' || !entry.meaning.trim() || entry.meaning.length > 250) throw new Error('Ungrounded stance');
      const kind = entry.kind ?? 'choice';
      const id = createHash('sha256').update(`${source.id}:${reply.id}:${kind}:${entry.scope}:${entry.topic}`).digest('hex');
      use(db => db.prepare('INSERT OR IGNORE INTO stances VALUES(?,?,?,?)').run(id, entry.topic, reply.at,
        JSON.stringify({ ...entry, kind, id, at: reply.at, sourceIds: [source.id, reply.id] })));
      stats.stances++;
    });
    for (const entry of update.state ?? []) apply(() => {
      const reply = quote('out', entry.replyQuote);
      if (!reply) throw new Error('Undelivered state');
      const valid = memory.continuity.validate([{ ...entry, evidence: entry.replyQuote, messageId: reply.id }], rows);
      memory.continuity.commit(valid, memory.continuity.meta().through ?? 0);
      if (entry.key === 'activity') memory.life.followSpokenActivity(valid[0]);
      stats.states++;
    });
    for (const entry of update.relationship ?? []) apply(() => {
      const source = quote('in', entry.userQuote), reply = quote('out', entry.replyQuote);
      if (!source || !reply) throw new Error('Undelivered relationship');
      memory.relationship.commit(memory.relationship.validate([{ ...entry, messageId: source.id, evidence: entry.userQuote,
        responseId: reply.id, responseEvidence: entry.replyQuote }], rows));
      stats.relationships++;
    });
    return stats;
  }
  return { snapshot, context, commit };
}
