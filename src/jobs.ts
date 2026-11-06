import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { DATA_DIR } from './constants.js';
import type { CodexRunOptions, CodexRunResult } from './codex/bridge.js';
import type { Session } from './session.js';
import type { RoutingDecision } from './routing.js';
import type { CatalogCandidate } from './media-catalog.js';
import type { ConsolidationBatch } from './consolidation.js';
import type { LifeBatch } from './character-life.js';
import { sameChatActor } from './message-queue.js';

export type JobState = 'pending' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted';
export interface Job {
  id: string; accountId: string; kind: 'codex' | 'update' | 'compact' | 'consolidate' | 'life'; createdAt: number;
  life?: LifeBatch;
  consolidation?: ConsolidationBatch;
  userText: string; fromUserId: string; contextToken: string;
  recoveryOf?: string;
  routing?: RoutingDecision;
  options?: CodexRunOptions; session: Session; tempFiles: string[];
  mediaCandidates?: CatalogCandidate[];
}
export interface JobStatus {
  acceptedInputIds?: string[];
  state: JobState; phase: string; updatedAt: number; threadId?: string;
  executionStarted?: boolean;
  result?: CodexRunResult; session?: Session;
}
export interface QueuedInput { text: string; ids: string[] }
export function hasUnconsumedChatInput(job: Job, acceptedIds: readonly string[] = []): boolean {
  if (job.options?.profile !== 'companion') return false;
  const path = join(DATA_DIR, 'message-queue.json');
  if (!existsSync(path)) return false;
  const queues = new Map<string, Array<{fromUserId:string;chatContext?:Session['chatContext'];profileHint?:string;messageIds?:string[]}>>(JSON.parse(readFileSync(path, 'utf8')));
  const accepted = new Set(acceptedIds);
  return (queues.get(job.accountId) ?? []).some(row => row.profileHint !== 'work'
    && sameChatActor(row, {fromUserId:job.fromUserId,chatContext:job.session.chatContext})
    && (!row.messageIds?.length || row.messageIds.some(id => !accepted.has(id))));
}
export function offerInput(id: string, input: QueuedInput) {
  const path = join(jobDir(id), 'inputs.json');
  const previous: QueuedInput[] = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
  if (!previous.some(row => row.ids.some(value => input.ids.includes(value)))) atomicWrite(path, [...previous, input]);
}
export function pendingInput(id: string, attempted: Set<string>): QueuedInput | undefined {
  const path = join(jobDir(id), 'inputs.json');
  if (!existsSync(path)) return;
  const rows: QueuedInput[] = JSON.parse(readFileSync(path, 'utf8'));
  const row = rows.find(input => input.ids.every(value => !attempted.has(value)));
  if (row) for (const value of row.ids) attempted.add(value);
  return row;
}
export const JOBS_DIR = join(DATA_DIR, 'jobs');
export function atomicWrite(path: string, data: unknown): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}
export function jobDir(id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid job ID');
  return join(JOBS_DIR, id);
}
export function readJob(id: string): Job { return JSON.parse(readFileSync(join(jobDir(id), 'job.json'), 'utf8')); }
export function sessionJobId(session: Session, workOnly = false): string | undefined {
  for (const id of [session.activeJobId, session.workJobId, session.lastJobId, session.lastWorkJobId]) {
    if (!id) continue;
    if (!workOnly) return id;
    try {
      const job = readJob(id);
      if (job.kind === 'update' || job.options?.profile === 'work') return id;
    } catch { /* Removed jobs are not a resumable task. */ }
  }
  return undefined;
}
export function readStatus(id: string): JobStatus { return JSON.parse(readFileSync(join(jobDir(id), 'status.json'), 'utf8')); }
export function writeStatus(id: string, value: JobStatus): void { atomicWrite(join(jobDir(id), 'status.json'), value); }
export function isTerminal(s: JobStatus): boolean { return !['pending', 'running'].includes(s.state); }
export function unitName(id: string): string { jobDir(id); return `wechat-task-${id}.service`; }
export function createJob(input: Omit<Job, 'id' | 'createdAt'>): Job {
  const job: Job = { ...input, id: randomUUID(), createdAt: Date.now() };
  mkdirSync(jobDir(job.id), { recursive: true, mode: 0o700 });
  atomicWrite(join(jobDir(job.id), 'job.json'), job);
  writeStatus(job.id, { state: 'pending', phase: '等待启动', updatedAt: Date.now() });
  return job;
}
export function jobResourceProperties(job: Pick<Job, 'kind' | 'options'>): string[] {
  if (['life', 'consolidate', 'compact'].includes(job.kind)) return [
    '--slice=wechat-background.slice', '--property=MemoryHigh=384M', '--property=MemoryMax=512M',
    '--property=MemorySwapMax=256M', '--property=CPUWeight=20', '--property=Nice=10'];
  if (job.kind === 'codex' && job.options?.profile === 'companion') return [
    '--slice=wechat-chat.slice', '--property=MemoryHigh=384M', '--property=MemoryMax=512M',
    '--property=MemorySwapMax=256M', '--property=CPUWeight=100'];
  // The server-control entry can run administrator-requested tools; its task
  // budget is separate from the character channel's small chat workers.
  return [];
}
export function launchJob(job: Job): void {
  const worker = fileURLToPath(new URL('./job-worker.js', import.meta.url));
  const background = ['life', 'consolidate', 'compact'].includes(job.kind);
  try {
    execFileSync('systemd-run', ['--user', '--quiet', '--collect', `--unit=${unitName(job.id)}`,
      '--property=UMask=0077', '--property=KillMode=control-group', '--property=TimeoutStopSec=10',
      '--property=NoNewPrivileges=no', '--property=PrivateTmp=no',
      ...jobResourceProperties(job),
      '--setenv=PATH=/usr/local/bin:/usr/bin:/bin', `--setenv=WCB_DATA_DIR=${DATA_DIR}`,
      ...(process.env.WCB_CODEX_RUNTIME_SOCKET ? [`--setenv=WCB_CODEX_RUNTIME_SOCKET=${process.env.WCB_CODEX_RUNTIME_SOCKET}`] : []),
      ...['WCB_FISHING_GROUP_ID', 'WCB_FISHING_GROUP_NAME'].flatMap(key =>
        process.env[key] ? [`--setenv=${key}=${process.env[key]}`] : []),
      ...(job.kind === 'update' ? ['/usr/bin/flock', '-n', join(DATA_DIR, 'cli-update.lock')] : []),
      ...(background ? ['/usr/bin/python3', fileURLToPath(new URL('../../desktop/background_budget.py', import.meta.url)), jobDir(job.id), '--'] : []),
      process.execPath, worker, job.id], { encoding: 'utf8', timeout: 15000 });
  } catch (error) {
    writeStatus(job.id, { state: 'failed', phase: '独立任务启动失败', updatedAt: Date.now(),
      result: { replyText: '', commands: [], fileChanges: [], error: String(error) } });
    throw error;
  }
}
export function unitActive(id: string): boolean {
  try {
    const state = execFileSync('systemctl', ['--user', 'show', unitName(id), '-p', 'ActiveState', '--value'], { encoding: 'utf8', timeout: 5000 }).trim();
    return ['active', 'activating', 'deactivating'].includes(state);
  } catch { return false; }
}
export function inspectJob(id: string): JobStatus {
  const s = readStatus(id);
  if (!isTerminal(s) && Date.now() - s.updatedAt > 5000 && !unitActive(id)) {
    // A reboot/crash is never treated as permission to rerun side effects.
    return { ...s, state: 'interrupted', phase: '进程已中断；使用 /resume 核查现场后继续',
      result: { replyText: '', commands: [], fileChanges: [], threadId: s.threadId,
        error: '任务进程已中断，未自动重跑。/resume 会先核查已完成的操作。' } };
  }
  return s;
}
export function requestStop(id: string): string {
  const job = readJob(id), status = inspectJob(id);
  if (isTerminal(status)) return '任务已结束。';
  if (job.kind === 'update') return 'CLI 更新事务不能中途强杀；会完成验证或回退。排队任务已暂停。';
  writeFileSync(join(jobDir(id), 'stop'), '', { mode: 0o600 });
  return '已请求停止当前任务，并暂停队列。已完成的操作不会自动撤销。';
}
export function stopRequested(id: string): boolean { return existsSync(join(jobDir(id), 'stop')); }
export function formatJobStatus(job: Job, s: JobStatus): string {
  return `任务 ${job.id.slice(0, 8)} · ${s.state}\n${s.phase}\n已用时 ${Math.floor((Date.now() - job.createdAt) / 1000)} 秒`;
}
export function resumePrompt(job: Job): string {
  return `继续此前被停止或中断的任务。先读取现场、日志和已有结果，核实哪些操作已经成功，只完成剩余工作；不要直接重复安装、删除、发送或其他有副作用的操作。\n原任务：${job.userText}\n任务记录目录：${jobDir(job.id)}`;
}
