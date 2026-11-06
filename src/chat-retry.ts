import { runWithMemory, type createMemoryStore } from './memory.js';
import { runCodex, type CodexRunOptions, type CodexRunResult } from './codex/bridge.js';
import { withChatLlm } from './llm.js';
import { createConversationStore } from './conversation.js';
import type { Session } from './session.js';
import { reviewCharacterReply } from './character-review.js';
import { createHash } from 'node:crypto';
import { isRepeatedFarewell } from './utils/chat-reply.js';
import { CHARACTER_CONFIG } from './companion-profile.js';
import { withFishingRoom } from './fishing.js';
import {retainReviewedContext} from './thread-continuity.js';

export function isModelCapacityError(error?: string): boolean {
  return !!error && /selected model is at capacity|model (?:is )?(?:at|over) capacity|模型.{0,12}(?:容量已满|容量不足|繁忙)/i.test(error);
}

// Owner-requested recovery for ordinary chat only. One new thread, same model,
// no automatic replay of work, quota errors, cancellation or arbitrary failures.
export async function runConversationTurn(options: CodexRunOptions, session: Session,
  memory: ReturnType<typeof createMemoryStore>, persist: () => void, runner = runCodex): Promise<CodexRunResult> {
  if (options.profile === 'companion') {
    options = withFishingRoom(options);
    options = withChatLlm({ ...options, threadConfig: { ...CHARACTER_CONFIG, ...options.threadConfig, personality: 'none' } });
    const c = options.conversation;
    const social = c && options.personaContext ? memory.socialSnapshot(c.peerId).relationship : undefined;
    if (social && social.pausedUntil > Date.now() && !options.signal?.aborted) {
      options.onEvent?.({ type: 'chat.closed', reason: 'social-cooldown' });
      return { replyText:'', replyDisposition:'no_reply', threadId:session.threadId, commands:[],fileChanges:[],
        characterReview:{status:'approved', checks:0,elapsedMs:0,issues:[],model:'local-social-rule',inputTokens:0,outputTokens:0,
          approvedReplyHash:createHash('sha256').update('').digest('hex')},timing:{elapsedMs:0} };
    }
    const rows = c ? createConversationStore(c.accountId, c.peerId).recent(24).filter(row => row.seq > (c.after ?? 0)) : [];
    if (options.personaContext && !options.signal?.aborted && isRepeatedFarewell(rows, c?.messageIds ?? [])) {
      options.onEvent?.({ type: 'chat.closed', reason: 'repeated-farewell' });
      return { replyText: '', replyDisposition: 'no_reply', threadId: session.threadId, commands: [], fileChanges: [],
        characterReview: { status: 'approved', checks: 0, elapsedMs: 0, issues: [], model: 'local-farewell-rule',
          inputTokens: 0, outputTokens: 0, approvedReplyHash: createHash('sha256').update('').digest('hex') },
        timing: { elapsedMs: 0 } };
    }
  }
  let actorContext: string | undefined;
  let actorFacts: CodexRunOptions['turnFacts'];
  const result = await generateConversationTurn(options, session, memory, persist, async call => {
    if (call.profile === 'companion') { actorContext = call.prompt; actorFacts = call.turnFacts; }
    return runner(call);
  });
  if (options.profile === 'companion' && !result.error && !options.signal?.aborted
    && options.isSuperseded?.(result.acceptedInputIds ?? [])) {
    options.onEvent?.({type:'chat.superseded',phase:'before-review'});
    session.rotateBeforeNext = true; persist();
    return { ...result, superseded: true, error: undefined, replyText: '', characterUpdate: undefined,
      mediaCandidates: [],crossDeliveries:[], retainedDraft: {replyText:result.replyText,characterUpdate:result.characterUpdate,mediaCandidates:result.mediaCandidates} };
  }
  // Review the same retrieved facts, media and time snapshot used by generation.
  // Do not keep pre-forgetting context after a memory deletion in this turn.
  const checked = await reviewCharacterReply({ ...options,
    turnFacts: result.memoryForgotten ? undefined : actorFacts,
    turnContext: result.memoryForgotten ? undefined : actorContext }, result, memory, runner);
  if(checked.characterReview?.status==='approved'&&checked.characterReview.stateReconciled
    &&!checked.error&&checked.replyText===result.replyText&&retainReviewedContext(session,checked)) {
    persist();
  } else if (checked.characterReview && (checked.characterReview.status !== 'approved' || checked.characterReview.stateReconciled)) {
    // Native history contains unapproved speech or bookkeeping. Resume from
    // delivered messages and committed state rather than reusing that draft.
    session.threadId = undefined; session.developerInstructionsHash = undefined;
    session.rotateBeforeNext = false; persist();
  }
  if (!checked.error && checked.characterUpdate?.social?.mode === 'quiet') {
    // The reviewer approved the actual quiet choice, not an empty/error answer.
    if (checked.replyText.trim()) return { ...checked, error:'Quiet choice must not contain visible text' };
    return { ...checked, replyDisposition:'no_reply', mediaCandidates:[],crossDeliveries:[] };
  }
  return checked;
}

async function generateConversationTurn(options: CodexRunOptions, session: Session,
  memory: ReturnType<typeof createMemoryStore>, persist: () => void, runner: typeof runCodex): Promise<CodexRunResult> {
  const first = await runWithMemory(options, session, memory, persist, runner);
  if (options.profile !== 'companion' || options.signal?.aborted || !isModelCapacityError(first.error)
    || options.isSuperseded?.(first.acceptedInputIds ?? [])
    || first.commands.length || first.fileChanges.length) return first;
  session.rotateBeforeNext = true;
  persist();
  options.onEvent?.({ type: 'chat.capacity_retry', model: options.model });
  const accepted = first.acceptedInputIds ?? [];
  const c = options.conversation;
  const additions = c ? createConversationStore(c.accountId, c.peerId).byIds(accepted)
    .filter(row => row.direction === 'in' && !c.messageIds?.includes(row.id)).map(row => row.text) : [];
  const retry = await runWithMemory({ ...options,
    prompt: [options.prompt, ...(additions.length ? ['用户随后补充：', ...additions] : [])].join('\n'),
    conversation: c ? { ...c, messageIds: [...new Set([...(c.messageIds ?? []), ...accepted])] } : undefined,
  }, session, memory, persist, runner);
  const spent = first.timing?.elapsedMs ?? 0;
  return { ...retry, capacityRetries: 1, memoryForgotten: first.memoryForgotten || retry.memoryForgotten,
    acceptedInputIds: [...new Set([...accepted, ...(retry.acceptedInputIds ?? [])])],
    ...(retry.timing ? { timing: { ...retry.timing, elapsedMs: spent + retry.timing.elapsedMs,
      firstTokenMs: retry.timing.firstTokenMs === undefined ? undefined : spent + retry.timing.firstTokenMs,
      answerMs: retry.timing.answerMs === undefined ? undefined : spent + retry.timing.answerMs } } : {}) };
}
