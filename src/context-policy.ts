import type { Session } from './session.js';

export const IDLE_COMPACTION_RATIO = 0.6;
export const REQUEST_COMPACTION_RATIO = 0.7;
export const COMPACTION_IDLE_MS = 30000;

export function idleCompactionDue(session: Session): boolean {
  const window = session.contextWindow;
  const tokens = session.contextTokens;
  if (!session.threadId || !window || tokens === undefined || !session.contextModel
      || session.state !== 'idle' || session.activeJobId || session.queuePaused) return false;
  if (tokens < window * IDLE_COMPACTION_RATIO) return false;
  // Do not repeat an ineffective or interrupted summary after every short reply.
  return session.lastCompactionTokens === undefined || tokens > session.lastCompactionTokens + window * 0.02;
}
