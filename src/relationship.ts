import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ConversationMessage } from './conversation.js';
import { suppressedByForgetting } from './memory-recall.js';

export const RELATIONSHIP_AXES = ['familiarity', 'trust', 'comfort', 'openness'] as const;
export const RELATIONSHIP_EVIDENCE_RULES = `关系变化记录相处中实际发生的了解、支持、伤害或修复，不把自己的选择当成对方造成的关系变化。一次普通请求和自己的拒绝只说明这次愿不愿意；不由拒绝反推对方冒犯、信任降低或敞开受损。strained需要原话支持的具体伤害或越界，repaired需要对应事情确实说开，接受拒绝也不自动换来私人分享。stance记录当前分享选择：局部事项用topic，只有实际影响整段相处时才用interaction，不把单次不发某张照片扩成对所有私人分享的封锁。不为填满字段制造关系事件。`;
type Axis = typeof RELATIONSHIP_AXES[number];
export interface RelationshipEvidence {
  axis: Axis;
  topic: string;
  effect: 'learned' | 'supported' | 'strained' | 'repaired';
  meaning: string;
  messageId: string;
  evidence: string;
  responseId: string;
  responseEvidence: string;
}
export interface StoredEvidence extends RelationshipEvidence { id: string; at: number; day: string; audience?:string }

// Relationship evidence comes exclusively from delivered, reciprocal exchanges.
// Passage of time, model-generated life events and message counts do not write here.
export function createRelationshipStore(directory: string,audience?:string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  function use<T>(fn: (db: DatabaseSync) => T): T {
    const path = join(directory, 'relationship.sqlite3');
    try { closeSync(openSync(path, 'wx', 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const db = new DatabaseSync(path);
    try {
      db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL);`);
      return fn(db);
    } finally { db.close(); }
  }
  function validate(value: unknown, messages: ConversationMessage[]): StoredEvidence[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 4) throw new Error('关系经历格式错误');
    return value.map((raw: RelationshipEvidence & { userMessageId?: string; userEvidence?: string; characterMessageId?: string; characterEvidence?: string }) => {
      let entry: RelationshipEvidence = { ...raw,
        messageId: raw?.userMessageId ?? raw?.messageId, evidence: raw?.userEvidence ?? raw?.evidence,
        responseId: raw?.characterMessageId ?? raw?.responseId, responseEvidence: raw?.characterEvidence ?? raw?.responseEvidence };
      let source = messages.find(row => row.id === entry.messageId);
      let response = messages.find(row => row.id === entry.responseId);
      // Message order does not determine the speaker. Normalize the entire pair,
      // including quotations, then validate both against actual receipts.
      if (source?.direction === 'out' && response?.direction === 'in') {
        entry = { ...entry, messageId: entry.responseId, evidence: entry.responseEvidence,
          responseId: entry.messageId, responseEvidence: entry.evidence };
        [source, response] = [response, source];
      }
      if (!entry || !RELATIONSHIP_AXES.includes(entry.axis)
        || !['learned', 'supported', 'strained', 'repaired'].includes(entry.effect)
        || typeof entry.topic !== 'string' || !entry.topic.trim() || entry.topic.length > 60
        || typeof entry.meaning !== 'string' || !entry.meaning.trim() || entry.meaning.length > 250
        || typeof entry.evidence !== 'string' || !entry.evidence.trim() || entry.evidence.length > 400
        || typeof entry.responseEvidence !== 'string' || !entry.responseEvidence.trim() || entry.responseEvidence.length > 400
        || source?.direction !== 'in' || response?.direction !== 'out'
        || source.profile !== 'companion' || response.profile !== 'companion'
        || Math.abs(source.seq - response.seq) > 6 || Math.abs(response.at - source.at) > 6 * 3600000
        || !source.text.includes(entry.evidence) || !response.text.includes(entry.responseEvidence)) {
        throw new Error('关系变化需要双方实际角色对话的原句');
      }
      // Identical exchanges cannot be farmed across batches, days or restarts.
      const id = createHash('sha256').update(JSON.stringify([entry.axis, entry.effect,
        entry.evidence.replace(/\s+/gu, ''), entry.responseEvidence.replace(/\s+/gu, '')])).digest('hex');
      const at = Math.max(source.at, response.at);
      return { ...entry, id, at, ...(audience?{audience}:{}),
        day: new Date(at).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }) };
    });
  }
  function commit(entries: StoredEvidence[]) {
    use(db => {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const entry of entries) db.prepare('INSERT OR IGNORE INTO evidence VALUES(?,?,?)')
          .run(entry.id, JSON.stringify(entry), entry.at);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
  }
  function snapshot(forgotten: string[] = []) {
    const entries = use(db => db.prepare('SELECT value FROM evidence ORDER BY at').all()
      .map(row => JSON.parse(String(row.value)) as StoredEvidence))
      .filter(row => !suppressedByForgetting([row.meaning, row.evidence, row.responseEvidence].join('\n'), forgotten));
    const axes = Object.fromEntries(RELATIONSHIP_AXES.map(axis => {
      const all = entries.filter(row => row.axis === axis);
      const topics = [...new Set(all.map(row => row.topic))];
      const boundaries = topics.flatMap(topic => {
        const history = all.filter(row => row.topic === topic);
        const strain = [...history].reverse().find(row => row.effect === 'strained');
        const repair = [...history].reverse().find(row => row.effect === 'repaired');
        return strain && (!repair || repair.at <= strain.at) ? [strain] : [];
      });
      const positive = all.filter(row => row.effect !== 'strained');
      const varied = new Set(positive.map(row => row.topic)).size >= 2
        && new Set(positive.map(row => row.day)).size >= 2;
      return [axis, { state: !all.length ? 'unknown' : varied ? 'established' : 'emerging',
        experiences: positive.filter(e=>!audience||e.audience===audience).slice(-3).map(({ meaning, at, messageId, responseId }) => ({ meaning, at, messageId, responseId })),
        boundaries: boundaries.filter(e=>!audience||e.audience===audience).slice(-3).map(({ topic, meaning, at }) => ({ topic, meaning, at })) }];
    }));
    return { basis: entries.length ? 'actual_reciprocal_exchanges' : 'no_recorded_exchanges', axes,
      guidance: 'affinity是当前对这个人的亲近和投入，axes是分事项保存的实际相处证据，二者描述不同内容。unknown或没有经历记录表示缺少记录，不表示刚认识、不在意或不信任；不据此否定已有亲近。亲近可以表现为在意、随意说话、愿意了解，不等于必须同意、分享照片或取消具体边界；也不能编造共同往事、知道的习惯或默认恋爱。具体信任与边界看对应原话和经历，不按天数、轮数升级，不因忙碌晚回扣分。不向用户报等级。' };
  }
  return { validate, commit, snapshot };
}
