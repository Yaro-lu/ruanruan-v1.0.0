import type {ChatContext} from './wechat/channel.js';
export const MESSAGE_BATCH_WINDOW_MS = 2000;

interface ChatMessage {
  userText: string;
  chatContext?: ChatContext;
  media?: unknown;
  fromUserId: string;
  contextToken: string;
  receivedAt?: number;
  messageIds?: string[];
  offeredTo?: string;
  profileHint?: 'work'|'companion';
}

export function sameChatActor(a:Pick<ChatMessage,'fromUserId'|'chatContext'>,b:Pick<ChatMessage,'fromUserId'|'chatContext'>) {
  return a.fromUserId===b.fromUserId && a.chatContext?.conversationId===b.chatContext?.conversationId
    && a.chatContext?.actorId===b.chatContext?.actorId;
}
const windowFor=(message:ChatMessage)=>message.profileHint==='work'?600:MESSAGE_BATCH_WINDOW_MS;
const mediaItems=(media:unknown)=>media?Array.isArray(media)?media:[media]:[];

// Each sender has a rolling silence deadline. Interleaved group members do not
// extend one another's deadline. Text and attachments stay in one durable batch.
export function enqueueChatMessage<T extends ChatMessage>(
  queues: Map<string, T[]>, accountId: string, message: T, now = Date.now(),
): number {
  const current = queues.get(accountId) ?? [];
  const previous = [...current].reverse().find(row=>sameChatActor(row,message));
  if (previous && !previous.offeredTo && previous.profileHint===message.profileHint && previous.receivedAt !== undefined
    && now >= previous.receivedAt && now - previous.receivedAt <= windowFor(message)) {
    previous.userText = [previous.userText,message.userText].filter(Boolean).join('\n');
    const media=[...mediaItems(previous.media),...mediaItems(message.media)];
    if(media.length)previous.media=(media.length===1?media[0]:media) as T['media'];
    previous.contextToken = message.contextToken || previous.contextToken;
    previous.receivedAt = now;
    previous.messageIds = [...(previous.messageIds ?? []), ...(message.messageIds ?? [])];
  } else current.push({ ...message, receivedAt: now });
  queues.set(accountId, current);
  return current.length;
}

export function messageBatchDelay(message: ChatMessage, now = Date.now()): number {
  if (message.receivedAt === undefined) return 0;
  return Math.max(0, message.receivedAt + windowFor(message) - now);
}

// Keep the whole unfinished utterance when a generated draft is superseded.
// Other group members retain their place and their own silence deadline.
export function requeueSupersededBatch<T extends ChatMessage>(queue: T[], original: T, accepted: T[] = []): boolean {
  const pending = queue.filter(row => row.profileHint !== 'work' && sameChatActor(row, original));
  if (!pending.length) return false;
  const latest = pending.reduce((a,b) => (a.receivedAt ?? 0) > (b.receivedAt ?? 0) ? a : b);
  const seen = new Set<string>();
  const parts = [original, ...accepted, ...pending].filter(row => {
    if (row.messageIds?.length && row.messageIds.every(id => seen.has(id))) return false;
    for (const id of row.messageIds ?? []) seen.add(id);
    return true;
  });
  const media = parts.flatMap(row => mediaItems(row.media));
  const combined = { ...latest, userText: parts.map(row => row.userText).filter(Boolean).join('\n'),
    messageIds: [...seen], media: media.length > 1 ? media : media[0], offeredTo: undefined,
    chatContext: original.chatContext?.participation === 'direct' ? { ...latest.chatContext!, participation: 'direct' as const } : latest.chatContext } as T;
  const index = queue.indexOf(pending[0]);
  queue.splice(0, queue.length, ...queue.filter(row => !pending.includes(row)));
  queue.splice(index, 0, combined);
  return true;
}

export function nextChatBatchIndex<T extends ChatMessage>(queue:T[],eligible:(message:T)=>boolean=()=>true,now=Date.now()):number {
  let selected=-1,deadline=Infinity;
  queue.forEach((row,index)=>{
    if(!eligible(row))return;
    const due=row.receivedAt===undefined?0:row.receivedAt+windowFor(row);
    if(due<deadline){selected=index;deadline=due;}
  });
  return selected;
}

export function enqueueQueuedMessage<T>(
  queues: Map<string, T[]>,
  accountId: string,
  message: T,
): number {
  const current = queues.get(accountId) ?? [];
  current.push(message);
  queues.set(accountId, current);
  return current.length;
}

export function dequeueQueuedMessage<T>(
  queues: Map<string, T[]>,
  accountId: string,
): T | undefined {
  const current = queues.get(accountId);
  if (!current?.length) {
    return undefined;
  }

  const next = current.shift();
  if (!current.length) {
    queues.delete(accountId);
  }
  return next;
}

export function getQueuedMessageCount<T>(
  queues: Map<string, T[]>,
  accountId: string,
): number {
  return queues.get(accountId)?.length ?? 0;
}
