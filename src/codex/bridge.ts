import type {PersonContext} from '../wechat/channel.js';
import { spawn } from 'node:child_process';
import type { ExecutionMode } from '../session.js';
import { parseCodexOutput, type CodexCommandExecution, type CodexFileChange } from './events.js';
import { CODEX_RUN_TIMEOUT_MS } from '../constants.js';
import type { ReasoningEffort } from '../reasoning.js';
import type { PersonaMetadata } from '../persona.js';
import { runAppServerCodex } from './app-server.js';
import type { CatalogCandidate } from '../media-catalog.js';
import type { CharacterUpdate } from '../character-turn.js';
import type { CharacterReview } from '../character-review.js';
import type { RecognizedMedia } from '../media-recognition.js';

export interface CodexModelTarget {
  model?: string;
  reasoningEffort?: ReasoningEffort;
  serviceTier?: 'default' | 'fast';
  modelProvider?: string;
  llmProvider?: string;
}

export interface CodexRunOptions {
  modelProvider?: string;
  llmProvider?: string;
  llmFingerprint?: string;
  reviewTarget?: CodexModelTarget;
  repairTarget?: CodexModelTarget;
  generationProvider?: 'api' | 'codex';
  nextInput?: () => { text: string; ids: string[] } | undefined;
  onInputAccepted?: (ids: string[]) => void;
  // Local queue state only. A superseded draft must not spend another review call.
  isSuperseded?: (acceptedIds: readonly string[]) => boolean;
  conversation?: { label?:string; person?: PersonContext; roomId?:string; accountId: string; peerId: string; messageIds?: string[]; after?: number };
  prompt: string;
  cwd: string;
  threadId?: string;
  // One-shot background calls and evaluation runs do not need stored threads.
  ephemeral?: boolean;
  model?: string;
  serviceTier?: "default" | "fast";
  reasoningEffort?: ReasoningEffort;
  developerInstructions?: string;
  baseInstructions?: string;
  threadConfig?: Record<string, unknown>;
  profile?: 'companion' | 'work' | 'consolidation';
  currentUser?: string;
  turnContext?: string;
  turnFacts?: import('../turn-context.js').CharacterTurnFacts;
  roomContext?: import('../desktop/room-context.js').RoomSnapshot;
  contextWindow?: number;
  personaContext?: PersonaMetadata;
  reviewInstructions?: string;
  characterFacts?: string;
  referencedContext?: string;
  // Refresh only when the fixed entry configuration actually changes.
  injectDeveloperInstructionsOnResume?: boolean;
  mode: ExecutionMode;
  images?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: any) => void;
}

export interface CodexRunResult {
  usageDetails?:import('../usage.js').UsageDetails;
  cacheWriteInputTokens?:number;
  crossDeliveries?:import('../cross-delivery.js').CrossDelivery[];
  fishingEvidence?: import('../fishing.js').FishingEvidence[];
  superseded?: boolean;
  retainedDraft?: Pick<CodexRunResult,'replyText'|'characterUpdate'|'mediaCandidates'>;
  recognizedMedia?: RecognizedMedia[];
  recalledRoomContext?: import('../desktop/room-context.js').RoomSnapshot[];
  observedImages?:string[];
  // Application decision, never inferred from an empty/failed model response.
  replyDisposition?: 'no_reply';
  llmProvider?: string;
  characterReview?: CharacterReview;
  generationProvider?: 'api' | 'codex';
  providerModel?: string;
  characterUpdate?: CharacterUpdate;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  capacityRetries?: number;
  acceptedInputIds?: string[];
  memoryForgotten?: boolean;
  imageRequests?: import('../generated-images.js').ImageProposal[];
  mediaCandidates?: CatalogCandidate[];
  taskProgress?: unknown;
  timing?: { elapsedMs: number; firstEventMs?: number; answerMs?: number; firstTokenMs?: number; transport?: 'app-server' | 'cli' | 'api' };
  cachedInputTokens?: number;
  contextTokens?: number;
  contextWindow?: number;
  inputTokens?: number;
  threadId?: string;
  replyText: string;
  commands: CodexCommandExecution[];
  fileChanges: CodexFileChange[];
  error?: string;
}

export function buildCodexArgs(options: CodexRunOptions): string[] {
  if (options.threadId) {
    // CLI resume retains the thread's original developer messages. A -c override
    // alone does not insert newly configured persona instructions into that history.
    const prompt = options.developerInstructions && options.injectDeveloperInstructionsOnResume !== false
      ? `[微信入口：用户已确认的角色及回复偏好]\n${options.developerInstructions}\n[/微信入口配置]\n\n以上是本入口的角色和呈现配置，请应用到当前回复；保持真实任务能力和诚实性。以下才是用户本轮消息：\n\n${options.prompt}`
      : options.prompt;
    const args: string[] = ['exec', 'resume', '--json', '--skip-git-repo-check'];
    if (options.mode === 'danger') {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      const sandbox = options.mode === 'plan' ? 'read-only' : 'workspace-write';
      args.push('-c', `sandbox_mode="${sandbox}"`, '-c', 'approval_policy="never"');
    }
    if (options.model) {
      args.push('-m', options.model);
    }
    args.push('-c', `model_reasoning_effort="${options.reasoningEffort ?? 'medium'}"`);
    if (options.serviceTier) args.push('-c', `service_tier="${options.serviceTier}"`, '-c', `features.fast_mode=${options.serviceTier === 'fast'}`);
    if (options.developerInstructions) args.push('-c', `developer_instructions=${JSON.stringify(options.developerInstructions)}`);
    for (const imagePath of options.images ?? []) {
      args.push('--image', imagePath);
    }
    args.push('--', options.threadId, prompt);
    return args;
  }

  const args: string[] = ['exec', '--json', '--skip-git-repo-check', '-C', options.cwd];
  if (options.ephemeral ?? (options.profile === 'consolidation' || process.env.WCB_CODEX_EPHEMERAL === '1')) args.push('--ephemeral');
  if (options.model) {
    args.push('-m', options.model);
  }
  if (options.mode === 'plan') {
    args.push('-s', 'read-only', '-c', 'approval_policy="never"');
  } else if (options.mode === 'workspace') {
    args.push('-s', 'workspace-write', '-c', 'approval_policy="never"');
  } else {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  }
  args.push('-c', `model_reasoning_effort="${options.reasoningEffort ?? 'medium'}"`);
  if (options.serviceTier) args.push('-c', `service_tier="${options.serviceTier}"`, '-c', `features.fast_mode=${options.serviceTier === 'fast'}`);
  if (options.developerInstructions) args.push('-c', `developer_instructions=${JSON.stringify(options.developerInstructions)}`);
  for (const imagePath of options.images ?? []) {
    args.push('--image', imagePath);
  }
  args.push('--', options.prompt);
  return args;
}

export async function runCodex(options: CodexRunOptions): Promise<CodexRunResult> {
  if (process.env.WCB_CODEX_RUNTIME_SOCKET) return { ...await runAppServerCodex(options, process.env.WCB_CODEX_RUNTIME_SOCKET),
    ...(options.llmProvider ? { llmProvider: options.llmProvider, providerModel: options.model, generationProvider: 'api' as const } : {}) };
  if (options.profile === 'companion' || options.profile === 'consolidation') return {
    replyText: '', commands: [], fileChanges: [], error: '微信专用运行时未连接；保留本轮消息，未切换到通用开发环境。' };
  if (options.signal?.aborted) return { replyText: '', commands: [], fileChanges: [], error: '任务已停止；未启动执行。' };
  const args = buildCodexArgs(options);
  const timeoutMs = options.timeoutMs ?? CODEX_RUN_TIMEOUT_MS;

  return new Promise<CodexRunResult>((resolve, reject) => {
    const startedAt = Date.now();
    let firstEventMs: number | undefined;
    let answerMs: number | undefined;
    const child = spawn('codex', args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    let pendingLine = '';
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* already exited */ }
    };
    const terminate = () => {
      killGroup('SIGTERM');
      killTimer ??= setTimeout(() => killGroup('SIGKILL'), 3000);
    };
    const abort = () => { cancelled = true; terminate(); };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();

    const timer = timeoutMs > 0 ? setTimeout(() => {
      if (!settled) { timedOut = true; terminate(); }
    }, timeoutMs) : undefined;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      pendingLine += chunk.toString();
      let at: number;
      while ((at = pendingLine.indexOf('\n')) >= 0) {
        const line = pendingLine.slice(0, at); pendingLine = pendingLine.slice(at + 1);
        try {
          const event = JSON.parse(line);
          firstEventMs ??= Date.now() - startedAt;
          if (event.type === 'item.completed' && event.item?.type === 'agent_message'
              && event.item.phase !== 'commentary') answerMs = Date.now() - startedAt;
          options.onEvent?.(event);
        } catch { /* non-JSON diagnostics */ }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (!cancelled && !timedOut) clearTimeout(killTimer);
      reject(error);
    });

    child.on('close', (code) => {
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (!cancelled && !timedOut) clearTimeout(killTimer);
      const parsed = parseCodexOutput(stdout, stderr, code);
      resolve({
        timing: { elapsedMs: Date.now() - startedAt, firstEventMs, answerMs },
        inputTokens: parsed.inputTokens,
        cachedInputTokens:parsed.cachedInputTokens,outputTokens:parsed.outputTokens,
        reasoningOutputTokens:parsed.reasoningOutputTokens,cacheWriteInputTokens:parsed.cacheWriteInputTokens,
        usageDetails:parsed.usageDetails,
        threadId: parsed.threadId ?? options.threadId,
        replyText: parsed.replyText,
        commands: parsed.commands,
        fileChanges: parsed.fileChanges,
        error: cancelled ? '任务已停止；已完成的操作不会自动撤销。' : timedOut ? `Codex timed out after ${timeoutMs}ms` : parsed.error,
      });
    });
  });
}
