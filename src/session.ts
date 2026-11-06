import { loadJson, saveJson } from './store.js';
import { mkdirSync, existsSync, readdirSync } from 'fs';
import type { ChatContext } from './wechat/channel.js';
import { DATA_DIR } from './constants.js';
import { join, dirname } from 'path';
import { retireThread } from './thread-retirement.js';
import type { extractFirstSupportedMedia } from './wechat/media.js';
export type QueuedMedia = ReturnType<typeof extractFirstSupportedMedia> | NonNullable<ReturnType<typeof extractFirstSupportedMedia>>[];
import type { ReasoningEffort } from './reasoning.js';
import type { RoutingTask } from './routing.js';

const SESSIONS_DIR = join(DATA_DIR, 'sessions');

export type ExecutionMode = 'plan' | 'workspace' | 'danger';
export type SessionState = 'idle' | 'processing';
export const THREAD_FIELDS = ['threadId', 'contextLlm', 'memoryVersion', 'memoryTurns', 'contextTokens', 'contextWindow',
  'contextModel', 'contextChars', 'rotateBeforeNext', 'lastHandoffAt', 'developerInstructionsHash', 'lastCompactionTokens', 'characterContext','memoryToolsVersion','threadFeedback'] as const;
export function workSession(session: Session): Session {
  const result = { ...session, ...Object.fromEntries(THREAD_FIELDS.map(key => [key, session.workContext?.[key]])) };
  delete result.workContext;
  return result;
}
export function acceptThread(session: Session, result: Session, work = false) {
  const target = work ? (session.workContext ??= {}) : session;
  for (const key of THREAD_FIELDS) (target as any)[key] = result[key];
  if (!work) session.companionVersion = result.companionVersion;
  if (!session.routingTask || (result.routingTask?.updatedAt ?? 0) >= session.routingTask.updatedAt) session.routingTask = result.routingTask;
}

export interface Session {
  threadFeedback?:import('./thread-continuity.js').ThreadFeedback;
  retiredThreadId?:string;
  characterContext?: import('./turn-context.js').CharacterContextSnapshot;
  chatContext?: ChatContext;
  chatMode?: 'companion' | 'assistant';
  modeRevision?: number;
  assistantVersion?: number;
  lastInputAt?: number;
  companionVersion?: number;
  memoryToolsVersion?:number;
  backgroundJobId?: string;
  workJobId?: string;
  lastWorkJobId?: string;
  workContext?: Partial<Session>;
  conversationAfter?: number;
  pendingRequest?: { chatContext?: ChatContext; userText: string; media: QueuedMedia; fromUserId: string; contextToken: string; messageIds?: string[] };
  activeJobId?: string;
  lastJobId?: string;
  queuePaused?: boolean;
  jobContextToken?: string;
  jobFromUserId?: string;
  threadId?: string;
  workingDirectory: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  serviceTier?: 'default' | 'fast';
  lastBurstAt?: number;
  mode?: ExecutionMode;
  state: SessionState;
  memoryVersion?: number;
  memoryTurns?: number;
  contextTokens?: number;
  contextWindow?: number;
  contextModel?: string;
  contextLlm?: string;
  lastCompactionTokens?: number;
  contextChars?: number;
  rotateBeforeNext?: boolean;
  lastHandoffAt?: string;
  developerInstructionsHash?: string;
  routingTask?: RoutingTask;
}

export function createSessionStore(directory = SESSIONS_DIR) {
  function getSessionPath(accountId: string): string {
    return join(directory, `${accountId}.json`);
  }

  function load(accountId: string): Session {
    const session = loadJson<Session>(getSessionPath(accountId), {
      workingDirectory: process.cwd(),
      state: 'idle',
      memoryVersion: 1,
      memoryTurns: 0,
      contextTokens: 0,
      contextChars: 0,
      rotateBeforeNext: false,
    });
    return migrateWechatSession(session);
  }

  function save(accountId: string, session: Session): void {
    mkdirSync(directory, { recursive: true });
    const previous = loadJson<Session | undefined>(getSessionPath(accountId), undefined);
    if (previous?.threadId !== session.threadId) retireThread(dirname(directory), previous?.threadId);
    saveJson(getSessionPath(accountId), session);
  }

  function clear(accountId: string, currentSession?: Session): Session {
    const session: Session = {
      chatContext: currentSession?.chatContext,
      workContext: undefined,
      workJobId: undefined,
      lastWorkJobId: undefined,
      backgroundJobId: undefined,
      companionVersion: undefined,
      pendingRequest: undefined,
      activeJobId: undefined,
      lastJobId: undefined,
      queuePaused: false,
      threadId: undefined,
      contextLlm: undefined,
      memoryVersion: 1,
      memoryTurns: 0,
      contextTokens: 0,
      contextChars: 0,
      rotateBeforeNext: false,
      lastHandoffAt: undefined,
      routingTask: undefined,
      reasoningEffort: undefined,
      lastBurstAt: currentSession?.lastBurstAt,
      chatMode: currentSession?.chatMode ?? 'companion',
      modeRevision: currentSession?.modeRevision,
      assistantVersion: currentSession?.assistantVersion,
      workingDirectory: currentSession?.workingDirectory ?? process.cwd(),
      model: currentSession?.model,
      serviceTier: currentSession?.serviceTier,
      mode: currentSession?.mode,
      state: 'idle',
    };
    save(accountId, session);
    return session;
  }

  const list = () => existsSync(directory) ? readdirSync(directory).filter(name=>name.endsWith('.json')).map(name=>name.slice(0,-5)) : [];
  return { load, save, clear, list };
}

// Old native DSH ids cannot be resumed by Codex. Start one new WeChat thread
// with the shared memory/history handoff, rather than resurrecting an old work thread.
export function migrateWechatSession(session: Session): Session {
  const legacy = session as Session & { engine?: string; engineSessions?: unknown };
  if (legacy.engine || legacy.engineSessions) {
    if (session.activeJobId) throw new Error('旧入口任务仍在运行，先完成交接再启用新入口');
    delete legacy.engine; delete legacy.engineSessions;
    session.threadId = undefined; session.developerInstructionsHash = undefined;
    session.memoryTurns = 0; session.contextTokens = 0; session.contextChars = 0;
    session.contextWindow = undefined; session.contextModel = undefined;
    session.lastCompactionTokens = undefined; session.rotateBeforeNext = false;
    session.lastHandoffAt = new Date().toISOString();
  }
  return session;
}
