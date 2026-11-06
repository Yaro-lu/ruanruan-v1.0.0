import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { randomInt, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DATA_DIR } from './constants.js';
import { atomicWrite } from './jobs.js';

export interface Approval {
  id: string; code: string; accountId: string; userId: string;
  summary: string; details: string; origin: string;
  createdAt: number; expiresAt: number;
  state: 'pending' | 'approved' | 'rejected' | 'expired';
  delivery: 'pending' | 'accepted' | 'failed' | 'uncertain';
  resolvedAt?: number; reply?: string;
}

// Approval is a durable decision for this exact request, never an instruction
// to execute a shell command or a blanket grant for subsequent requests.
export function createApprovalStore(directory = join(DATA_DIR, 'approvals'), now = Date.now) {
  function all(): Approval[] {
    try { return readdirSync(directory).filter(n => /^[a-f0-9-]{36}\.json$/.test(n))
      .map(n => JSON.parse(readFileSync(join(directory, n), 'utf8')) as Approval); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  function save(a: Approval) { mkdirSync(directory, { recursive: true, mode: 0o700 }); atomicWrite(join(directory, a.id + '.json'), a); }
  function find(code: string, accountId?: string, userId?: string): Approval | undefined {
    const a = all().find(a => a.code === code && (!accountId || a.accountId === accountId) && (!userId || a.userId === userId));
    if (a?.state === 'pending' && a.expiresAt <= now()) { a.state = 'expired'; save(a); }
    return a;
  }
  function create(input: Pick<Approval, 'accountId' | 'userId' | 'summary' | 'details' | 'origin'>, ttlMs = 30 * 60_000): Approval {
    if (!input.summary.trim() || ttlMs <= 0 || ttlMs > 24 * 3600_000) throw new Error('授权内容或有效期无效');
    const used = new Set(all().map(a => a.code));
    let code: string; do { code = String(randomInt(100000, 1000000)); } while (used.has(code));
    const a: Approval = { ...input, id: randomUUID(), code, createdAt: now(), expiresAt: now() + ttlMs, state: 'pending', delivery: 'pending' };
    save(a); return a;
  }
  function resolveReply(accountId: string, userId: string, text: string): string | undefined {
    const match = text.trim().match(/^(同意|确认|授权|拒绝|不同意)\s*(?:本次)?(?:授权|请求|测试)?\s*(\d{6})(?=$|[\s，,。！!])/);
    if (!match) return undefined;
    const a = find(match[2], accountId, userId);
    if (!a) return `没有找到属于当前账号的授权请求 ${match[2]}，未授予任何权限。`;
    if (a.state !== 'pending') return `授权 ${a.code} 已${{ approved: '同意', rejected: '拒绝', expired: '过期' }[a.state]}，本条回复没有改变它。\n事项：${a.summary}`;
    a.state = ['拒绝', '不同意'].includes(match[1]) ? 'rejected' : 'approved';
    a.resolvedAt = now(); a.reply = text.trim().slice(0, 2000); save(a);
    return `已${a.state === 'approved' ? '同意' : '拒绝'}授权 ${a.code}。\n事项：${a.summary}\n${a.state === 'approved' ? '已记录，发起任务可读取本次决定；不自动扩大授权范围。' : '该事项不会因这条回复而执行。'}`;
  }
  return { create, find, save, resolveReply };
}
