import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { parseCodexOutput } from './events.js';
import type { CodexRunOptions, CodexRunResult } from './bridge.js';
import { REQUEST_COMPACTION_RATIO } from '../context-policy.js';
import { createWechatTools } from '../wechat-tools.js';
import { characterDialogueInput } from '../companion-profile.js';
import {conversationThreadTitle,isCharacterThreadTitle} from '../thread-continuity.js';
import {sumReportedUsage,tokenUsage} from '../usage.js';

// A private local relay owns one official stdio app-server. Workers only own
// their socket; turn/completed does not wait for CLI/SessionEnd shutdown.
export async function runAppServerCodex(options: CodexRunOptions, socket: string, operation: 'turn' | 'compact' = 'turn'): Promise<CodexRunResult> {
  if (options.signal?.aborted) return { replyText: '', commands: [], fileChanges: [], error: '任务已停止；未启动执行。' };
  const startedAt = Date.now();
  // The CLI's TOML accepts the legacy name "fast". The native RPC expects the
  // advertised tier id "priority"; passing "fast" is silently unsupported.
  const serviceTier = options.serviceTier === 'fast' ? 'priority' : options.serviceTier;
  const ephemeral = options.ephemeral ?? (options.profile === 'consolidation' || process.env.WCB_CODEX_EPHEMERAL === '1');
  const connection = createConnection(socket);
  const lines = createInterface({ input: connection });
  const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const events: string[] = [];
  const tools = options.conversation && options.profile !== 'work' && options.profile !== 'consolidation' ? createWechatTools(options.conversation.accountId, options.conversation.peerId,
    options.profile === 'companion' ? { currentUser: options.currentUser ?? options.prompt,
      after: options.conversation.after, person:options.conversation.person,roomId:options.conversation.roomId,roomContext:options.roomContext, signal: options.signal,
      messageIds: options.conversation.messageIds, messageId: options.conversation.messageIds?.at(-1) } : {}) : undefined;
  let sequence = 0;
  let threadId = options.threadId;
  let turnId: string | undefined;
  let submitted = false;
  let finished = false;
  let cancelled = false;
  let timedOut = false;
  let firstEventMs: number | undefined;
  let answerMs: number | undefined;
  let firstTokenMs: number | undefined;
  let cachedInputTokens: number | undefined;
  let outputTokens: number | undefined;
  let reasoningOutputTokens: number | undefined;
  let contextTokens: number | undefined;
  let contextWindow: number | undefined;
  const usageEvents:any[]=[];
  const usageTotals=new Set<string>();
  let grace: ReturnType<typeof setTimeout> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let steerTimer: ReturnType<typeof setInterval> | undefined;
  let steering = false;
  let completion: { error?: string } | undefined;
  const acceptedInputIds: string[] = [];
  let resolveTurn!: (result: CodexRunResult) => void;
  const done = new Promise<CodexRunResult>(resolve => { resolveTurn = resolve; });
  const send = (value: unknown) => connection.write(JSON.stringify(value) + '\n');
  const request = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    if (finished) { reject(new Error('Codex 连接已结束')); return; }
    const id = ++sequence;
    const deadline = setTimeout(() => { pending.delete(id); reject(new Error(`Codex ${method} 未响应`)); }, 30000);
    pending.set(id, { resolve, reject, timer: deadline });
    send({ id, method, params });
  });
  const emit = (event: any) => { events.push(JSON.stringify(event)); options.onEvent?.(event); };
  function finish(error?: string) {
    if (finished) return;
    if (steering) { completion = { error }; return; }
    finished = true;
    clearTimeout(timer); clearTimeout(grace); clearInterval(steerTimer);
    options.signal?.removeEventListener('abort', abort);
    // After a steer, only the final answer belongs to the combined request.
    // Earlier unsent drafts remain in the native transcript, not in WeChat.
    const outputEvents = acceptedInputIds.length ? events.filter((line, index) => {
      const event = JSON.parse(line);
      return event.type !== 'item.completed' || event.item?.type !== 'agent_message'
        || !events.slice(index + 1).some(next => { const later = JSON.parse(next); return later.type === 'item.completed' && later.item?.type === 'agent_message' && later.item.phase !== 'commentary'; });
    }) : events;
    const parsed = parseCodexOutput(outputEvents.join('\n'), '', 0);
    const failure = error ?? (cancelled ? '任务已停止；已完成的操作不会自动撤销。' : undefined);
    resolveTurn({ inputTokens: parsed.inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, contextTokens, contextWindow, threadId,
      ...(usageEvents.length?tokenUsage(sumReportedUsage(usageEvents.map(value=>tokenUsage(value.last)))):{}),
      ...(usageEvents.length?{usageDetails:{source:'codex-app-server',scope:usageEvents.every(value=>value.total)?'reported_requests':'last_request',
        raw:usageEvents,observedCalls:usageEvents.length}}:{}),
      mediaCandidates: tools?.candidates, imageRequests: tools?.imageRequests, observedImages:tools?.viewedImages,
      recognizedMedia: tools?.recognizedMedia,
      memoryForgotten: tools?.forgotten,
      recalledRoomContext: tools?.recalledRoomContext,
      fishingEvidence: tools?.fishingEvidence,
      crossDeliveries:tools?.crossDeliveries,
      acceptedInputIds,
      replyText: parsed.replyText, commands: parsed.commands, fileChanges: parsed.fileChanges,
      timing: { elapsedMs: Date.now() - startedAt, firstEventMs, answerMs, firstTokenMs, transport: 'app-server' },
      error: failure });
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(failure ?? 'Codex 本轮已结束')); }
    pending.clear();
    connection.end();
  }
  async function interrupt() {
    if (!submitted || !turnId || !threadId) return;
    try { await request('turn/interrupt', { threadId, turnId }); }
    catch (error) { finish(`停止请求未获确认：${String(error)}；请核查原线程，未自动重跑。`); }
  }
  async function steer() {
    if (finished || completion || steering || cancelled || answerMs !== undefined || !turnId || !threadId) return;
    const input = options.nextInput?.();
    if (!input) return;
    steering = true;
    try {
      await request('turn/steer', { threadId, expectedTurnId: turnId,
        input: [{ type: 'text', text: characterDialogueInput(input.text,true,options.roomContext?.focus), text_elements: [] }] });
      acceptedInputIds.push(...input.ids);
      tools?.appendUser(input.text, input.ids);
      options.onInputAccepted?.(input.ids);
    } catch { /* Leave unacknowledged messages in the durable queue. */ }
    finally { steering = false; finishPending(); }
  }
  function finishPending() { if (completion) finish(completion.error); }
  function abort() {
    cancelled = true;
    if (!submitted) { finish('任务已停止；未启动执行。'); return; }
    void interrupt();
    grace ??= setTimeout(() => finish('停止请求已发出但轮次尚未确认结束；请核查原线程，未自动重跑。'), 15000);
  }
  connection.on('error', error => finish(`Codex 本地运行时连接失败：${error.message}；未自动重跑。`));
  connection.on('close', () => { if (!finished) finish('Codex 本地运行时连接中断；原任务未自动重跑。'); });
  lines.on('line', line => {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (finished) return;
    firstEventMs ??= Date.now() - startedAt;
    if (message.id !== undefined && !message.method) {
      const item = pending.get(message.id);
      if (!item) return;
      clearTimeout(item.timer); pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result);
      return;
    }
    if (message.id !== undefined) {
      if (message.method === 'item/tool/call' && tools && message.params?.threadId === threadId && !cancelled) {
        if (turnId && message.params.turnId !== turnId) {
          send({ id: message.id, result: { success: false, contentItems: [{ type: 'inputText', text: '工具请求不属于当前轮次' }] } });
          return;
        }
        void tools.call(message.params.tool, message.params.arguments).then(value => {
          if (!finished) send({ id: message.id, result: { success: true, contentItems: (value as any)?.contentItems??[{ type: 'inputText', text: JSON.stringify(value) }] } });
        }, error => {
          if (!finished) send({ id: message.id, result: { success: false, contentItems: [{ type: 'inputText', text: `微信工具未完成：${error instanceof Error ? error.message.slice(0, 200) : '参数或本地读取失败'}。请根据原因调整，不要声称操作成功。` }] } });
        });
        return;
      }
      // approval_policy=never remains authoritative. Interactive requests must
      // be surfaced in the final reply; this transport cannot approve actions.
      if (/requestApproval$/.test(message.method)) send({ id: message.id, result: { decision: 'decline' } });
      else send({ id: message.id, error: { code: -32601, message: '微信入口不支持交互式工具请求，请在最终回复中说明所需信息。' } });
      return;
    }
    const p = message.params ?? {};
    if (!submitted || p.threadId !== threadId || (turnId && p.turnId && p.turnId !== turnId)) return;
    if (message.method === 'turn/started') {
      turnId = p.turn.id;
      if (cancelled) void interrupt();
    } else if (message.method === 'item/agentMessage/delta') {
      firstTokenMs ??= Date.now() - startedAt;
    } else if (message.method === 'item/started' || message.method === 'item/completed') {
      const item = p.item;
      const type = ({ agentMessage: 'agent_message', commandExecution: 'command_execution', fileChange: 'file_change', contextCompaction: 'context_compaction' } as Record<string, string>)[item.type];
      if (!type) return;
      const normalized = { ...item, type, exit_code: item.exitCode,
        ...(item.changes ? { changes: item.changes.map((change: any) => ({ path: change.path, kind: change.kind?.type ?? change.kind })) } : {}) };
      if (message.method === 'item/completed' && type === 'agent_message' && item.phase !== 'commentary') answerMs = Date.now() - startedAt;
      emit({ type: message.method.replace('/', '.'), item: normalized });
    } else if (message.method === 'thread/tokenUsage/updated') {
      if(turnId&&p.turnId&&p.turnId!==turnId)return;
      if(!p.tokenUsage?.last)return;
      // Native total identifies successive reported requests. Repeated updates
      // of the same total must not count the same request twice.
      const usageKey=JSON.stringify(p.tokenUsage.total??p.tokenUsage.last);
      if(!usageTotals.has(usageKey)){
        usageTotals.add(usageKey);
        if(!p.tokenUsage.total)usageEvents.length=0;
        usageEvents.push(p.tokenUsage);
      }
      cachedInputTokens = p.tokenUsage.last.cachedInputTokens;
      outputTokens = p.tokenUsage.last.outputTokens;
      reasoningOutputTokens = p.tokenUsage.last.reasoningOutputTokens;
      contextTokens = p.tokenUsage.last.totalTokens ?? p.tokenUsage.last.inputTokens;
      contextWindow = p.tokenUsage.modelContextWindow ?? undefined;
      emit({ type: 'turn.completed', usage: { input_tokens: p.tokenUsage.last.inputTokens } });
    } else if (message.method === 'turn/completed') {
      if (p.turn.status === 'completed') finish(timedOut ? 'Codex 调用超时；原任务未自动重跑。' : undefined);
      else finish(p.turn.error?.message ?? (cancelled ? '任务已停止；已完成的操作不会自动撤销。' : `Codex 轮次状态：${p.turn.status}`));
    }
  });
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  if (options.timeoutMs && options.timeoutMs > 0) timer = setTimeout(() => { timedOut = true; abort(); }, options.timeoutMs);
  try {
    await request('initialize', { clientInfo: { name: 'wechat_codex', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized', params: {} });
    const loaded = await request(threadId ? 'thread/resume' : 'thread/start', {
      ...(threadId ? { threadId, excludeTurns: true } : {}),
      ...(!threadId ? { ephemeral } : {}),
      model: options.model, modelProvider: options.modelProvider, cwd: options.cwd, serviceTier,
      approvalPolicy: 'never', sandbox: options.mode === 'danger' ? 'danger-full-access' : options.mode === 'plan' ? 'read-only' : 'workspace-write',
      developerInstructions: options.developerInstructions,
      baseInstructions: options.baseInstructions,
      ...(!threadId && tools ? { dynamicTools: tools.specs } : {}),
      config: { ...options.threadConfig,
        ...(options.contextWindow ? { model_auto_compact_token_limit: Math.floor(options.contextWindow * REQUEST_COMPACTION_RATIO) } : {}) },
    });
    threadId = loaded.thread.id;
    if (loaded.thread.status?.type === 'active') throw new Error('原线程已有运行中的任务，未重复启动；请先核查该任务。');
    const title=conversationThreadTitle(options);
    if (!ephemeral && title && loaded.thread.name!==title && (!loaded.thread.name||isCharacterThreadTitle(loaded.thread.name))) {
      await request('thread/name/set', { threadId, name:title });
    }
    emit({ type: 'thread.started', thread_id: threadId });
    if (cancelled || finished) { finish('任务已停止；未启动执行。'); return await done; }
    const text = options.threadId && options.injectDeveloperInstructionsOnResume && options.developerInstructions
      ? `[微信入口配置更新]\n${options.developerInstructions}\n[/微信入口配置更新]\n\n${options.prompt}` : options.prompt;
    submitted = true;
    if (operation === 'compact') {
      await request('thread/compact/start', { threadId });
      return await done;
    }
    const started = await request('turn/start', { threadId, input: [
      { type: 'text', text, text_elements: [] }, ...(options.images ?? []).map(path => ({ type: 'localImage', path })),
    ], model: options.model, serviceTier, effort: options.reasoningEffort ?? 'medium' });
    turnId = started.turn.id;
    if (options.nextInput && options.profile === 'companion') steerTimer = setInterval(() => { void steer(); }, 150);
    if (cancelled) void interrupt();
  } catch (error) { finish(String(error)); }
  return await done;
}
