import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJob, writeStatus, jobDir, stopRequested, pendingInput, hasUnconsumedChatInput, type JobStatus } from './jobs.js';
import { createConversationStore } from './conversation.js';
import { createMemoryStore, createWorkMemoryStore } from './memory.js';
import { runConversationTurn } from './chat-retry.js';
import { runCodex } from './codex/bridge.js';
import { runAppServerCodex } from './codex/app-server.js';
import { updateCli, recoverCliUpdate } from './cli-update.js';
import { finishRoute } from './routing.js';
import type { CodexRunResult } from './codex/bridge.js';
import { logger } from './logger.js';
import { runLife } from './life-runtime.js';

const id = process.argv[2];
const job = readJob(id);
const controller = new AbortController();
let phase = '正在启动';
let threadId = job.session.threadId;
let executionStarted = false;
const acceptedInputIds: string[] = [];
const attemptedInputIds = new Set<string>();
const report = () => writeStatus(id, { state: 'running', phase, updatedAt: Date.now(), threadId, executionStarted, session: job.session, acceptedInputIds });
const progress = (value: string) => { phase = value; report(); };
report();
const heartbeat = setInterval(() => {
  if (job.kind !== 'update' && stopRequested(id)) controller.abort();
  report();
}, 1000);
process.on('SIGTERM', () => { if (job.kind !== 'update') controller.abort(); });
process.on('SIGINT', () => { if (job.kind !== 'update') controller.abort(); });

try {
  let result;
  if (job.kind === 'update') {
    result = { replyText: job.recoveryOf
      ? await recoverCliUpdate(jobDir(job.recoveryOf), progress)
      : await updateCli(jobDir(id), progress), commands: [], fileChanges: [] };
  } else if (job.kind === 'consolidate' || job.kind === 'life') {
    if (!job.options) throw new Error('缺少记忆整理参数');
    progress(job.kind === 'life' ? '正在后台推进人物生活' : '正在后台整理已送达的对话');
    result = await (job.kind === 'life' ? runLife : runCodex)({ ...job.options, signal: controller.signal, timeoutMs: 120000 });
  } else if (job.kind === 'compact') {
    const socket = process.env.WCB_CODEX_RUNTIME_SOCKET;
    if (!job.options || !socket) throw new Error('后台压缩需要常驻运行时');
    if (stopRequested(id)) controller.abort();
    progress('正在空闲时整理上下文');
    const options = { ...job.options, signal: controller.signal, timeoutMs: 0,
      onEvent: event => {
        appendFileSync(join(jobDir(id), 'events.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 });
        if (event.type === 'thread.started') threadId = event.thread_id;
      } } as Parameters<typeof runCodex>[0];
    result = await runAppServerCodex(options, socket, 'compact');
    if (result.contextTokens !== undefined) job.session.contextTokens = result.contextTokens;
    if (result.contextWindow) job.session.contextWindow = result.contextWindow;
  } else {
    if (!job.options) throw new Error('缺少执行参数');
    if (stopRequested(id)) controller.abort();
    progress('正在分析任务');
    result = await runConversationTurn({ ...job.options, timeoutMs: 0, signal: controller.signal,
      isSuperseded: ids => hasUnconsumedChatInput(job, ids),
      nextInput: job.options.profile === 'companion' ? () => pendingInput(id, attemptedInputIds) : undefined,
      onInputAccepted: ids => {
        acceptedInputIds.push(...ids);
        if (threadId) createConversationStore(job.accountId, job.fromUserId).markSeen(threadId, ids);
        report();
      },
      onEvent: (event: any) => {
        appendFileSync(join(jobDir(id), 'events.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 });
        if (event.type === 'thread.started') { threadId = event.thread_id; report(); }
        if (event.type === 'chat.capacity_retry') progress('模型暂时繁忙，正在新会话接续当前消息');
        if (event.type === 'chat.persona_review') progress(event.phase === 'repairing'
          ? '正在调整人物表达' : event.phase === 'approved' ? '人物表达检查完成' : '正在检查人物表达');
        if (['item.started', 'item.completed'].includes(event.type) && ['command_execution', 'file_change'].includes(event.item?.type)) executionStarted = true;
        if (event.type === 'item.started' && event.item?.type === 'command_execution') progress('正在执行服务器命令');
        if (event.type === 'item.completed' && event.item?.type === 'command_execution') progress(event.item.exit_code === 0 ? '命令已完成，继续处理' : '命令返回非零状态，正在检查');
        if (event.type === 'item.completed' && event.item?.type === 'file_change') progress('已更新文件，继续验证');
        if (event.type === 'item.started' && event.item?.type === 'context_compaction') progress('正在压缩会话上下文');
      } }, job.session, job.options.profile === 'work' ? createWorkMemoryStore(job.accountId)
        : createMemoryStore(job.accountId, undefined, job.options.conversation?.person), report,
        runCodex);
  }
  finishRoute(job.session, job.routing, (result as CodexRunResult).taskProgress, !!result.error, controller.signal.aborted);
  if (job.routing) logger.info('Request route finished', { id, kind: job.routing.kind, taskState: job.session.routingTask?.state });
  const status: JobStatus = { state: controller.signal.aborted ? 'stopped' : result.error ? 'failed' : 'completed',
    phase: controller.signal.aborted ? '任务已停止' : result.error ? '任务失败' : '任务完成',
    updatedAt: Date.now(), result, session: job.session, threadId: result.threadId ?? threadId, executionStarted, acceptedInputIds };
  clearInterval(heartbeat); writeStatus(id, status);
} catch (error) {
  clearInterval(heartbeat);
  finishRoute(job.session, job.routing, undefined, true, controller.signal.aborted);
  writeStatus(id, { state: 'failed', phase: '任务失败', updatedAt: Date.now(), threadId, session: job.session, acceptedInputIds,
    result: { replyText: '', commands: [], fileChanges: [], error: String(error) } });
}
