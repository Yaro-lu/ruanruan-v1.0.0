import { createGeneratedImageQueue, generateCharacterImage, imageGenerationConfig, type ImageTask } from './generated-images.js';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { existsSync, mkdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';

import { createRoomStore, roomContextText, type RoomSnapshot } from './desktop/room-context.js';
import {createDesktopStore} from './desktop/store.js';
import {viewRoomMedia} from './desktop/media-view.js';
import { createIdentityStore } from './identity.js';
import { loadDesktopConfig } from './desktop/config.js';
import {desktopReplyContext} from './desktop/database-proof.js';
import { createWechatChannel } from './wechat/channel-factory.js';
import { applyEntryRole, conversationAccount, conversationScene, entryAllowsCommands, entryProfile,retireLegacyGroupSession } from './conversation-scope.js';
import { channelKind } from './wechat/channel.js';
import type { ChannelAccount, ChannelCallbacks, IncomingMessage, WechatSender } from './wechat/channel.js';
import { buildCodexPrompt, cleanupTempFiles, extractFirstSupportedMedia, extractText, prepareMediaForCodex, type MediaPreparationDeps } from './wechat/media.js';
import { createSessionStore, workSession, acceptThread, THREAD_FIELDS, type Session, type QueuedMedia } from './session.js';
import { routeCommand, type CommandContext, type CommandResult } from './commands/router.js';
import { createMemoryStore, createWorkMemoryStore } from './memory.js';
import {retainDeliveryContext} from './thread-continuity.js';
import { createJob, launchJob, readJob, inspectJob, sessionJobId, isTerminal, requestStop, stopRequested, offerInput, formatJobStatus, resumePrompt, atomicWrite, jobDir, type Job } from './jobs.js';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { dequeueQueuedMessage, enqueueChatMessage, messageBatchDelay, nextChatBatchIndex, sameChatActor, requeueSupersededBatch } from './message-queue.js';
import { DATA_DIR } from './constants.js';
import { planChatReply, replyTextForDelivery } from './utils/chat-reply.js';
import { loadPersonaSnapshot, BURST_COOLDOWN_MS } from './persona.js';
import { assembleEntryPrompt } from './prompt.js';
import { idleCompactionDue, COMPACTION_IDLE_MS } from './context-policy.js';
import { MessageItemType, MessageType, type WeixinMessage } from './wechat/types.js';
import { isAccountOwner } from './wechat/access.js';
import { controlCommand } from './task-control.js';
import { chooseRoute, conversationProfile } from './routing.js';
import { extractReplyImages } from './codex/images.js';
import { imageDeliverySummary } from './wechat/image-delivery.js';
import { deliverAlbumReply } from './wechat/album-delivery.js';
import { createApprovalStore } from './approvals.js';
import { catalogFile } from './media-catalog.js';
import { createMemeClient, memeFile } from './memecub.js';
import { createConversationStore } from './conversation.js';
import { COMPANION_BASE, CHARACTER_CONFIG, conversationOptions } from './companion-profile.js';
import { pendingConsolidation, consolidationOptions, commitConsolidation, ensureConsolidationBackfill, CONSOLIDATION_IDLE_MS, CONSOLIDATION_INTERVAL_MS } from './consolidation.js';
import { createLifeStore, LIFE_PROFILE } from './character-life.js';
import { deliverChatMessages } from './utils/chat-reply.js';
import { embeddingConfig } from './embeddings.js';
import { characterDeliveryBlockedReason, needsCharacterReview,hasCharacterApproval } from './character-review.js';
import {retainRuntimeFailure} from './runtime-notice.js';
import { resolveCharacterMedia } from './character-media.js';
import { selectedChatLlm } from './llm.js';
import { fishingMemoryPolicy } from './fishing.js';
import { deploymentHeld } from './desktop/deployment-hold.js';
import {deliverCrossConversation} from './cross-delivery.js';

const desktopDeployHeld = () => channelKind() === 'desktop' && deploymentHeld();

interface QueuedCodexMessage {
  chatContext?: IncomingMessage['chatContext'];
  offeredTo?: string;
  profileHint?: 'work' | 'companion';
  userText: string;
  media: QueuedMedia;
  fromUserId: string;
  contextToken: string;
  receivedAt?: number;
  messageIds?: string[];
}

let mediaPreparationDeps: Partial<MediaPreparationDeps> = {};

const queuePath = join(DATA_DIR, 'message-queue.json');
const queuedMessages = new Map<string, QueuedCodexMessage[]>(existsSync(queuePath)
  ? JSON.parse(readFileSync(queuePath, 'utf8')) : []);
function saveQueue() { mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 }); atomicWrite(queuePath, [...queuedMessages]); }
const watching = new Set<string>();
const preparationStops = new Set<string>();
const queuedDrains = new Map<string, ReturnType<typeof setTimeout>>();
const idleCompactions = new Map<string, ReturnType<typeof setTimeout>>();
const idleMemories = new Map<string, ReturnType<typeof setTimeout>>();
const indexTimers = new Map<string, ReturnType<typeof setTimeout>>();
const indexRequests = new Map<string, AbortController>();
function cancelMemory(accountId: string, session: Session) {
  indexRequests.get(accountId)?.abort();
  clearTimeout(idleMemories.get(accountId)); idleMemories.delete(accountId);
  if (session.backgroundJobId) requestStop(session.backgroundJobId);
}
function cancelIdleCompaction(accountId: string) {
  clearTimeout(idleCompactions.get(accountId)); idleCompactions.delete(accountId);
}
function cancelQueuedDrain(accountId: string) {
  clearTimeout(queuedDrains.get(accountId));
  queuedDrains.delete(accountId);
}

function extractTextFromItems(items: NonNullable<WeixinMessage['item_list']>): string {
  return items.map((item) => extractText(item)).filter(Boolean).join('\n');
}

function ensureUsableDirectory(cwd: string): void {
  if (!existsSync(cwd)) {
    throw new Error(`工作目录不存在: ${cwd}`);
  }
  if (!statSync(cwd).isDirectory()) {
    throw new Error(`不是目录: ${cwd}`);
  }
}

async function runDaemon(): Promise<void> {
  const config = loadConfig();
  const channel = await createWechatChannel();
  mediaPreparationDeps = channel.mediaPreparation ?? {};
  const base = channel.account;
  const sessionStore = createSessionStore();
  type Runtime = { account: ChannelAccount; session: Session; sender: WechatSender };
  const runtimes = new Map<string, Runtime>();
  function runtime(peer: string, context?: IncomingMessage['chatContext']): Runtime {
    const account = conversationAccount(base, peer, context);
    const found = runtimes.get(account.accountId);
    if (found) return found;
    const session = sessionStore.load(account.accountId);
    applyEntryRole(account, session);
    if (context) session.chatContext = context;
    const sender = channel.sender.forConversation?.(account.accountId) ?? channel.sender;
    const result = {account, session, sender};
    runtimes.set(account.accountId, result);
    if (account.entryRole === 'character' && session.workJobId) {
      requestStop(session.workJobId); session.workJobId = undefined;
    }
    if (account.entryRole === 'character' && session.activeJobId
      && readJob(session.activeJobId).options?.profile === 'work') {
      requestStop(session.activeJobId); session.activeJobId = undefined;
    }
    if (session.state === 'processing' && !session.activeJobId) {
      session.state = 'idle'; session.rotateBeforeNext = true;
    }
    if (session.pendingRequest && JSON.stringify(queuedMessages.get(account.accountId)?.[0]) === JSON.stringify(session.pendingRequest)) {
      dequeueQueuedMessage(queuedMessages, account.accountId); saveQueue();
    }
    sessionStore.save(account.accountId, session);
    if (session.backgroundJobId) void watchMemory(session.backgroundJobId, account, session, sessionStore, config);
    if (session.workJobId) void watchJob(session.workJobId, account, session, sessionStore, sender, config);
    if (session.activeJobId) {
      session.state = 'processing';
      void watchJob(session.activeJobId, account, session, sessionStore, sender, config);
    } else if (queuedMessages.get(account.accountId)?.length) {
      session.queuePaused = true; sessionStore.save(account.accountId, session);
    }
    scheduleIdleCompaction(account, session, sessionStore, sender, config);
    scheduleMemory(account, session, sessionStore, config);
    scheduleIndex(account, session);
    return result;
  }
  runtime(base.userId);
  if (base.transport === 'desktop') for (const id of sessionStore.list()) {
    if (!id.startsWith(base.accountId+'-chat-')) continue;
    const saved = sessionStore.load(id);
    if (saved.chatContext && saved.jobFromUserId) {
      const canonical=conversationAccount(base,saved.jobFromUserId,saved.chatContext).accountId;
      if(canonical===id)runtime(saved.jobFromUserId,saved.chatContext);
      else if(!queuedMessages.get(id)?.length) {
        const retired=retireLegacyGroupSession(base,id,saved,sessionStore.load(canonical));
        if(retired)sessionStore.save(id,retired);
      }
    }
  }
  const imageConfig = base.entryRole === 'control' ? undefined : imageGenerationConfig();
  if (imageConfig && base.entryRole !== 'control') {
    const images = createGeneratedImageQueue(); images.recover();
    const canSend = (task: ImageTask) => {
      const r = runtimes.get(task.accountId);
      return !!r && r.session.chatMode !== 'assistant' && (r.session.modeRevision??0) === task.modeRevision
        && Date.now()-task.at < 10*60000;
    };
    const canDeliver = (task: ImageTask) => {
      const r = runtimes.get(task.accountId);
      return !!r && r.session.state === 'idle' && !r.session.activeJobId && !queuedMessages.get(task.accountId)?.length;
    };
    const drain = () => desktopDeployHeld() ? undefined : void images.processOne({canSend, canDeliver, generate:task=>generateCharacterImage(task,imageConfig),
      deliver:async task=>{
        const {session,sender} = runtimes.get(task.accountId)!;
        const context=task.chatContext;
        const destination=sender.forConversation?.(task.accountId,context?.kind==='group'?(context.participation==='direct'?{username:context.actorId,name:context.actorName}:null):undefined)??sender;
        const path=task.asset&&catalogFile(task.asset); if(!path) throw Error('Generated image file unavailable');
        const delivery=await destination.inThread(session.threadId,()=>deliverAlbumReply({directory:join(DATA_DIR,'generated-images',task.id),
          images:[path],texts:task.proposal.caption?[task.proposal.caption]:[],accountId:task.accountId,peerId:task.peerId,jobId:`generated:${task.id}`,
          asset:task.asset,sender:destination,toUserId:task.peerId,contextToken:()=>session.jobContextToken??readJob(task.id).contextToken,
          shouldContinue:()=>canSend(task)&&canDeliver(task)}),'companion', fishingMemoryPolicy({profile:'companion',
            conversation:{accountId:task.accountId,peerId:task.peerId,roomId:context?.kind==='group'?context.conversationId:undefined}}));
        return delivery.parts.some(part=>part.kind==='image'&&part.status==='sent');
      }}).then(task=>{if(task?.status==='failed')logger.warn('Background character image failed',{id:task.id,error:task.error});})
      .catch(()=>logger.warn('Background image queue unavailable'));
    setInterval(drain,3000).unref(); drain();
  }
  const callbacks: ChannelCallbacks = {
    onMessage: async msg => {
      if (!msg.from_user_id || (base.transport !== 'desktop' && !isAccountOwner(base.userId,msg.from_user_id))) return;
      if (base.transport === 'desktop' && !msg.chatContext && msg.from_user_id !== base.userId) return;
      const {session,sender} = runtime(msg.from_user_id,base.transport==='desktop'?msg.chatContext:undefined);
      const account=conversationAccount(base,msg.from_user_id,base.transport==='desktop'?msg.chatContext:undefined);
      if (msg.chatContext && base.transport==='desktop') session.chatContext = msg.chatContext;
      await handleMessage(msg,account,session,sessionStore,sender,config);
      scheduleIdleCompaction(account,session,sessionStore,sender,config);
    },
    onSessionExpired: () => {
      logger.warn('Session expired, please rerun setup');
      console.error(base.transport==='desktop' ? '⚠️ 请在微信桌面完成登录' : '⚠️ 控制账号会话已过期，请显式使用 WCB_CHANNEL=ilink 重新扫码绑定');
    },
  };

  const monitor = channel.createMonitor(callbacks);

  const shutdown = (): void => {
    logger.info('Shutting down...');
    monitor.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('Daemon started', { accountId: base.accountId, entryRole: base.entryRole });
  console.log(`已启动 (账号: ${base.accountId})`);
  await monitor.run();
}

export async function handleMessage(
  msg: IncomingMessage,
  account: ChannelAccount,
  session: Session,
  sessionStore: ReturnType<typeof createSessionStore>,
  sender: WechatSender,
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  if (msg.message_type !== MessageType.USER) return;
  if (!msg.from_user_id || !msg.item_list) return;
  if (!isAccountOwner(account.userId, msg.from_user_id)) {
    logger.warn('Ignored message from non-owner');
    return;
  }

  applyEntryRole(account, session);
  if (account.entryRole === 'character') session.queuePaused = false;
  const journal = createConversationStore(account.accountId, msg.from_user_id);
  const profile = entryProfile(account, session.chatMode === 'assistant' ? 'work' : 'companion');
  const userText = extractTextFromItems(msg.item_list);
  const isSlashCommand = userText.trim().startsWith('/');
  const commandsAllowed = entryAllowsCommands(account);
  const command = commandsAllowed ? controlCommand(userText, profile === 'work') : undefined;
  const approvalReply = commandsAllowed ? createApprovalStore().resolveReply(account.accountId, msg.from_user_id, userText) : undefined;
  const messageId = journal.record('in', msg, msg.create_time_ms || Date.now(), undefined,
    isSlashCommand || command || approvalReply ? 'control' : profile);
  if(msg.chatContext?.kind==='group' && account.transport==='desktop') {
    // Passive rooms also need a durable peer so their memory cursor resumes
    // after restart, even when the character has never chosen to speak there.
    if(!session.jobFromUserId) {
      session.jobFromUserId=msg.from_user_id;
      session.chatContext=msg.chatContext;
      sessionStore.save(account.accountId,session);
    }
    const rooms=createRoomStore(loadDesktopConfig().queueDirectory);
    const event=msg.roomEventId?rooms.event(msg.chatContext.conversationId,msg.roomEventId):undefined;
    if(msg.contextOnly||!event){scheduleMemory(account,session,sessionStore,config);return;}
    if(session.activeJobId&&msg.scheduledRoomCheck)return;
    const participation=rooms.consider(event,!!msg.addressed,Date.now(),msg.scheduledRoomCheck);
    if(!participation){scheduleMemory(account,session,sessionStore,config);return;}
    msg.chatContext={...msg.chatContext,participation};
    session.chatContext=msg.chatContext;
  }
  session.lastInputAt = Date.now();
  const contextToken = msg.context_token || session.jobContextToken || '';
  cancelIdleCompaction(account.accountId);
  cancelMemory(account.accountId, session);
  const fromUserId = msg.from_user_id;
  try { if (account.transport === 'ilink') {
    const { cacheNewsContext, resumePendingNews } = await import(new URL('./control/news-context.js', import.meta.url).href);
    if (cacheNewsContext(account, msg)) resumePendingNews();
  } }
  catch { logger.warn('Could not update or resume daily news delivery context'); }
  if(account.transport==='desktop'&&msg.chatContext&&['image','sticker'].includes(msg.unavailableMedia??'')&&msg.desktopSourceId) {
    try {
      const preview=await viewRoomMedia(loadDesktopConfig().queueDirectory,msg.chatContext.conversationId,msg.desktopSourceId);
      if(preview.path) {msg.localMedia={kind:'image',item:{type:MessageItemType.IMAGE},localPath:preview.path};msg.unavailableMedia=undefined;}
    } catch(error) {logger.warn('Incoming image remains pending',{error:String(error).slice(0,180)});}
  }
  const media = account.transport !== 'ilink' && msg.localMedia ? msg.localMedia : extractFirstSupportedMedia(msg.item_list);
  session.jobContextToken = contextToken;
  session.jobFromUserId = fromUserId;
  sessionStore.save(account.accountId, session);
  if (msg.unavailableMedia && account.transport === 'desktop' && msg.chatContext?.kind!=='group') {
    logger.warn('Incoming media unavailable; forwarding its factual status for normal generation', {kind:msg.unavailableMedia});
  }
  if (!commandsAllowed && isSlashCommand) return;
  if (account.entryRole === 'control' && /^\/q$/iu.test(userText.trim())) {
    await sender.sendText(fromUserId,contextToken,'【系统】服务器助手是独立的 Codex 服务器助手，直接发送任务即可。');
    return;
  }
  if (approvalReply) {
    await sender.sendText(fromUserId, contextToken, approvalReply);
    return;
  }
  if (/^\/q$/iu.test(userText.trim())) {
    const result = routeCommand({ accountId: account.accountId, session, text: userText,
      updateSession: partial => Object.assign(session, partial), clearSession: () => session });
    // Switching speakers cancels undelivered dialogue; actual work keeps its
    // durable job and can be inspected through /progress or /resume.
    if (session.activeJobId) requestStop(session.activeJobId);
    queuedMessages.delete(account.accountId); saveQueue(); cancelQueuedDrain(account.accountId);
    session.queuePaused = false;
    sessionStore.save(account.accountId, session);
    await sender.sendText(fromUserId, contextToken, result.reply!);
    return;
  }
  if (command) {
    const taskId = sessionJobId(session, account.entryRole === 'control');
    if (command === 'progress') {
      const id = taskId;
      const text = id ? [formatJobStatus(readJob(id), inspectJob(id)), imageDeliverySummary(jobDir(id))].filter(Boolean).join('\n') : '暂无任务记录。';
      await sender.sendText(fromUserId, contextToken, text + `\n队列：${queuedMessages.get(account.accountId)?.length ?? 0} 条${session.queuePaused ? '（已暂停）' : ''}`);
    } else if (command === 'stop') {
      cancelQueuedDrain(account.accountId);
      session.queuePaused = true;
      if (session.routingTask) session.routingTask = { ...session.routingTask, state: 'cancelled', updatedAt: Date.now() };
      if (session.state === 'processing' && !session.activeJobId) preparationStops.add(account.accountId);
      sessionStore.save(account.accountId, session);
      const running = [session.activeJobId, session.workJobId].filter((id): id is string => !!id);
      await sender.sendText(fromUserId, contextToken, running.length ? running.map(requestStop).join('\n') : session.state === 'processing' ? '已请求停止；附件准备结束后不会启动执行，队列已暂停。' : '当前没有执行中的任务，队列已暂停。');
    } else if (command === 'resume') {
      if (session.state === 'processing' && !session.activeJobId) {
        await sender.sendText(fromUserId, contextToken, '正在准备当前消息，未重复启动。可用 /stop 停止。');
      } else if (session.activeJobId || session.workJobId) {
        void watchJob((session.activeJobId ?? session.workJobId)!, account, session, sessionStore, sender, config);
        await sender.sendText(fromUserId, contextToken, '已接回当前任务；不会重新执行原请求。');
      } else if (session.pendingRequest) {
        const pending = session.pendingRequest;
        void sendToCodex(pending.userText, pending.media, fromUserId, contextToken, account, session, sessionStore, sender, config, pending.messageIds);
      } else if (taskId && ['stopped', 'interrupted', 'failed'].includes(inspectJob(taskId).state)) {
        const previous = readJob(taskId);
        if (previous.kind === 'update') {
          const job = createJob({ accountId: account.accountId, kind: 'update', recoveryOf: previous.recoveryOf ?? previous.id,
            userText: '核查并恢复中断的 CLI 更新', fromUserId, contextToken, session: { ...session }, tempFiles: [] });
          session.activeJobId = job.id; session.state = 'processing'; sessionStore.save(account.accountId, session);
          try { launchJob(job); } catch (error) { logger.error('Recovery launch failed', { error: String(error) }); }
          void watchJob(job.id, account, session, sessionStore, sender, config);
          await sender.sendText(fromUserId, contextToken, '已启动更新恢复检查：验证现有版本，必要时从备份恢复；不重复安装。');
        } else {
          void sendToCodex(resumePrompt(previous), undefined, fromUserId, contextToken, account, session, sessionStore, sender, config);
        }
      } else {
        session.queuePaused = false; sessionStore.save(account.accountId, session);
        if (!drainQueue(account, session, sessionStore, sender, config)) {
          const last = taskId ? inspectJob(taskId) : undefined;
          const previous = taskId ? readJob(taskId) : undefined;
          const unapproved = needsCharacterReview(previous?.options) && last?.result && !hasCharacterApproval(last.result);
          await sender.sendText(fromUserId, contextToken, unapproved
            ? '那条我先不照搬了，你再说说想聊哪一部分。' : last?.result?.replyText || '没有待恢复的任务。');
        }
      }
    } else if (command === 'update') {
      if (session.state === 'processing' || session.activeJobId || session.workJobId) {
        await sender.sendText(fromUserId, contextToken, '请等当前任务结束后再更新 CLI，或先 /stop。');
      } else {
        const job = createJob({ accountId: account.accountId, kind: 'update', userText,
          fromUserId, contextToken, session: { ...session }, tempFiles: [] });
        session.activeJobId = job.id; session.state = 'processing'; sessionStore.save(account.accountId, session);
        try { launchJob(job); } catch (error) { logger.error('Update launch failed', { error: String(error) }); }
        void watchJob(job.id, account, session, sessionStore, sender, config);
        await sender.sendText(fromUserId, contextToken, '已创建独立 CLI 更新任务；可用 /progress 查看进度。');
      }
    }
    return;
  }


  if ((!commandsAllowed || !isSlashCommand) && (userText || media)) {
    if (session.activeJobId && readJob(session.activeJobId).kind === 'compact') {
      const notice = join(jobDir(session.activeJobId), 'busy-notice');
      const firstNotice = !existsSync(notice);
      if (firstNotice) writeFileSync(notice, '', { flag: 'wx', mode: 0o600 });
      requestStop(session.activeJobId);
      if (firstNotice && profile!=='companion') {
        try { await sender.sendText(fromUserId, contextToken, '稍等哦，我这边忙一下，马上回来。'); }
        catch { logger.warn('Could not send compaction busy notice; preserving incoming message'); }
      }
    }
    enqueueChatMessage(queuedMessages, account.accountId, { userText, media, fromUserId, contextToken, messageIds: [messageId], profileHint: profile, chatContext:msg.chatContext });
    saveQueue();
    drainQueue(account, session, sessionStore, sender, config);
    return;
  }

  if(profile==='companion'&&!userText&&!media)return;
  if (session.state === 'processing' || session.workJobId) {
    if (!userText.startsWith('/status') && !userText.startsWith('/help')) {
      await sender.sendText(fromUserId, contextToken, '⏳ 正在处理上一条消息，请稍后...');
      return;
    }
  }

  if (isSlashCommand) {
    const updateSession = (partial: Partial<Session>) => {
      if (profile === 'work') {
        partial = { ...partial };
        for (const key of THREAD_FIELDS) if (key in partial) {
          session.workContext ??= {};
          (session.workContext as Record<string, unknown>)[key] = partial[key];
          delete partial[key];
        }
      }
      Object.assign(session, partial);
      sessionStore.save(account.accountId, session);
    };

    const ctx: CommandContext = {
      accountId: account.accountId,
      entryRole: account.entryRole,
      session,
      updateSession,
      clearSession: () => {
        cancelMemory(account.accountId, session);
        if (session.workJobId) requestStop(session.workJobId);
        cancelQueuedDrain(account.accountId);
        queuedMessages.delete(account.accountId); saveQueue();
        const memory = profile === 'work' ? createWorkMemoryStore(account.accountId)
          : createMemoryStore(account.accountId,undefined,account.person);
        memory.archive(profile === 'work' ? workSession(session) : session, 'manual-clear');
        memory.clearRecent();
        const cleared = sessionStore.clear(account.accountId, session);
        cleared.conversationAfter = createConversationStore(account.accountId, fromUserId).latestSequence();
        sessionStore.save(account.accountId, cleared);
        return cleared;
      },
      text: userText,
    };

    const result: CommandResult = routeCommand(ctx);
    if (result.reply) {
      await sender.sendText(fromUserId, contextToken, result.reply);
      return;
    }
    if (result.codexPrompt) {
      if (session.chatMode !== 'assistant') {
        await sender.sendText(fromUserId, contextToken, '执行技能请先发 /Q 切换到普通AI助手。');
      } else void sendToCodex(result.codexPrompt, media, fromUserId, contextToken, account, session, sessionStore, sender, config, undefined, 'work');
      return;
    }
    if (result.handled) {
      return;
    }
  }

  if (!userText && !media) {
    await sender.sendText(fromUserId, contextToken, '暂不支持此类型消息，请发送文字、图片、语音、音频或视频');
    return;
  }

  void sendToCodex(userText, media, fromUserId, contextToken, account, session, sessionStore, sender, config);
}

async function sendToCodex(
  userText: string,
  media: QueuedMedia,
  fromUserId: string,
  contextToken: string,
  account: ChannelAccount,
  session: Session,
  sessionStore: ReturnType<typeof createSessionStore>,
  sender: WechatSender,
  config: ReturnType<typeof loadConfig>,
  messageIds?: string[],
  requestedProfile?: 'work' | 'companion',
  chatContext?: IncomingMessage['chatContext'],
): Promise<void> {
  cancelQueuedDrain(account.accountId);
  preparationStops.delete(account.accountId);
  const currentChat=chatContext??session.chatContext;
  if(account.person&&currentChat)account={...account,person:{...account.person,actorId:currentChat.actorId,audience:currentChat.kind==='group'?currentChat.conversationId:'private'}};
  sender=sender.forConversation?.(account.accountId,currentChat?.kind==='group'
    ? currentChat.participation==='direct'?{username:currentChat.actorId,name:currentChat.actorName}:null : undefined)??sender;
  session.pendingRequest = { userText, media, fromUserId, contextToken, messageIds,chatContext:currentChat };
  session.state = 'processing';
  sessionStore.save(account.accountId, session);
  const typing = sender.startTyping(fromUserId, contextToken);
  let typingHandedOff = false;

  const tempFiles: string[] = [];
  let prompt = userText.trim();
  let routingText = userText;
  let imagePaths: string[] = [];

  try {
    if (media) {
      const prepared=[];
      for(const item of Array.isArray(media)?media:[media]) {
      const preparedMedia = await prepareMediaForCodex(item, mediaPreparationDeps);
      tempFiles.push(...preparedMedia.tempFiles);

      if (preparedMedia.immediateReply) {
        session.state = 'idle';
        sessionStore.save(account.accountId, session);
        if(account.entryRole==='character'||requestedProfile==='companion')throw Error(preparedMedia.immediateReply);
        await sender.sendText(fromUserId, contextToken, preparedMedia.immediateReply);
        return;
      }
      prepared.push(preparedMedia);
      if (!routingText) routingText = preparedMedia.promptFragments.find(fragment => fragment.startsWith('微信语音转写：'))?.slice('微信语音转写：'.length) ?? '';
      imagePaths.push(...preparedMedia.imagePaths);
      }
      const combined={...prepared[0],promptFragments:prepared.flatMap(p=>p.promptFragments),imagePaths};
      prompt = buildCodexPrompt(userText,combined);
    }

    if (!prompt) {
      if(account.entryRole==='character'||requestedProfile==='companion')throw Error('Incoming media has no usable content');
      session.state = 'idle';
      sessionStore.save(account.accountId, session);
      await sender.sendText(fromUserId, contextToken, '⚠️ 未提取到可发送给 Codex 的内容，请重试。');
      return;
    }

    if (preparationStops.has(account.accountId)) {
      if(account.entryRole!=='character'&&requestedProfile!=='companion')
        await sender.sendText(fromUserId, contextToken, '任务已停止，未启动服务器命令。');
      return;
    }

    const cwd = session.workingDirectory || config.workingDirectory;
    const mode = session.mode ?? config.mode ?? 'workspace';
    ensureUsableDirectory(cwd);

    const routing = chooseRoute(routingText, session, config, !!media);
    applyEntryRole(account, session);
    const profile = entryProfile(account, requestedProfile ?? conversationProfile(routingText, routing, session));
    if (profile === 'work') session.routingTask = routing.task;
    routing.options = conversationOptions(routing, profile);
    logger.info('Request route selected', { kind: routing.kind, profile, reason: routing.reason, ...routing.options, taskId: routing.task?.id });
    if (profile === 'work' && session.workJobId) {
      const queue = queuedMessages.get(account.accountId) ?? [];
      queue.unshift({ userText, media, fromUserId, contextToken, messageIds, profileHint: 'work' });
      queuedMessages.set(account.accountId, queue); saveQueue();
      return;
    }
    const persona = profile === 'companion' ? loadPersonaSnapshot(true) : undefined;
    const mediaCandidates: import('./media-catalog.js').CatalogCandidate[] = [];
    const entry = assembleEntryPrompt(persona, routing, mediaCandidates, true, profile);
    let referencedContext: string | undefined;
    if(profile==='companion'&&account.transport==='desktop'&&currentChat) {
      const desktop=loadDesktopConfig(),transport=createDesktopStore(desktop);
      const messages=createConversationStore(account.accountId,fromUserId).byIds(messageIds??[]);
      const references=[];
      const unavailable=[];
      for(const row of messages) {
        const payload=row.payload as IncomingMessage;
        const source=payload.desktopSourceId??payload.roomEventId;
        if(!source)continue;
        let current=transport.storedIncoming(source)??payload;
        if(current.unavailableMedia&&!current.localMedia)
          unavailable.push({source,kind:current.unavailableMedia,available:false});
        if(current.replyTo?.media) {
          const refId=current.replyTo.sourceId??source;
          try {
            const preview=await viewRoomMedia(desktop.queueDirectory,currentChat.conversationId,refId,{detail:true});
            if(preview.path&&!imagePaths.includes(preview.path)&&imagePaths.length<3)imagePaths.push(preview.path);
          } catch(error) {
            logger.warn('Referenced image remains unavailable; retaining the message', {source,error:String(error).slice(0,200)});
          }
          current=transport.storedIncoming(source)??current;
        }
        if(current.replyTo) {
          const {media,...ref}=current.replyTo;
          references.push({...ref,media:media?{id:ref.sourceId??source,kind:media.kind,available:!!(media.localPath||media.url),quality:media.quality}:undefined});
        }
      }
      if(references.length)referencedContext='【本轮引用的原消息】\n'+JSON.stringify(references)+'\n引用是对原消息的指向，不是当前发言人新说的话；附图对应这些原消息。';
      if(unavailable.length)referencedContext=[referencedContext,'【本轮附件取得状态】\n'+JSON.stringify(unavailable)+
        '\n附件画面或声音尚未取得，保留为未知；这些是接收状态，不是需要复述的后台话术。'].filter(Boolean).join('\n');
    }
    const scene = profile === 'companion' ? conversationScene(currentChat) : '';
    let roomContext: RoomSnapshot | undefined;
    if(profile==='companion'&&currentChat?.kind==='group') {
      const identities=createIdentityStore(),channelAccountId=account.person?.accountId??account.accountId;
      roomContext=createRoomStore(loadDesktopConfig().queueDirectory,
        (actorId,roomId)=>identities.view({platform:'wechat',channelAccountId,actorId},roomId)).snapshot(currentChat.conversationId,currentChat);
      entry.turnContext=[entry.turnContext,roomContextText(roomContext)].filter(Boolean).join('\n\n');
    }
    if (scene) {
      entry.developerInstructions += '\n\n'+scene;
      entry.characterFacts = (entry.characterFacts??'')+'\n\n'+scene;
    }
    const scope = profile === 'work' ? workSession(session) : { ...session,chatContext:currentChat };
    const chatDirectory = join(DATA_DIR, 'chat-workspace');
    if (profile === 'companion') mkdirSync(chatDirectory, { recursive: true, mode: 0o700 });
    const job = createJob({ accountId: account.accountId, kind: 'codex', userText, routing: profile === 'work' ? routing : undefined,
      mediaCandidates,
      fromUserId, contextToken, session: scope, tempFiles: [...tempFiles], options: {
        profile, prompt, cwd: profile === 'companion' ? chatDirectory : cwd, threadId: scope.threadId,
        ...(profile === 'companion' ? { baseInstructions: COMPANION_BASE, threadConfig: CHARACTER_CONFIG } : {}),
        conversation: { label:currentChat?.kind==='group'?currentChat.conversationName:currentChat?.person?.preferredName??currentChat?.actorName??currentChat?.conversationName,
          accountId: account.accountId, peerId: fromUserId, messageIds, after: session.conversationAfter,person:account.person,roomId:currentChat?.kind==='group'?currentChat.conversationId:undefined }, ...routing.options,
        ...entry, roomContext, referencedContext,
        personaContext: persona ? { version: persona.version, fingerprint: persona.fingerprint, files: persona.files, bytes: persona.bytes } : undefined,
        mode: profile === 'companion' ? 'plan' : mode, images: imagePaths,
      } });
    if (profile === 'work') { session.workJobId = job.id; session.state = 'idle'; }
    else session.activeJobId = job.id;
    session.pendingRequest = undefined;
    sessionStore.save(account.accountId, session);
    try { launchJob(job); } catch (error) { logger.error('Task launch failed', { error: String(error) }); }
    // The independent worker owns the image files until it completes.
    tempFiles.length = 0;
    typingHandedOff = true;
    void watchJob(job.id, account, session, sessionStore, sender, config, typing);

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to process WeChat message', { error: errorMsg });
    session.state = 'idle';
    sessionStore.save(account.accountId, session);
    if(account.entryRole==='character'||requestedProfile==='companion')void retainRuntimeFailure(errorMsg)
      .catch(error=>logger.warn('Could not retain character preparation failure',{error:String(error)}));
    else await sender.sendText(fromUserId, contextToken, `⚠️ 处理消息时出错\n${errorMsg.slice(0, 1200)}`);
  } finally {
    if (!typingHandedOff) await typing.stop();
    cleanupTempFiles(tempFiles);
    session.pendingRequest = undefined;
    preparationStops.delete(account.accountId);
    if (!session.activeJobId) {
      session.state = 'idle'; sessionStore.save(account.accountId, session);
      drainQueue(account, session, sessionStore, sender, config);
    }
  }
}

function drainQueue(
  account: ChannelAccount, session: Session, store: ReturnType<typeof createSessionStore>,
  sender: WechatSender, config: ReturnType<typeof loadConfig>,
): boolean {
  cancelQueuedDrain(account.accountId);
  if (session.queuePaused) return false;
  const queue = queuedMessages.get(account.accountId);
  if(!queue?.length)return false;
  if (desktopDeployHeld()) {
    queuedDrains.set(account.accountId, setTimeout(() => drainQueue(account, session, store, sender, config), 500));
    return true;
  }
  const active=session.activeJobId?readJob(session.activeJobId):undefined;
  if(active && (active.options?.profile!=='companion'||isTerminal(inspectJob(active.id))))return false;
  if(!active&&session.state==='processing')return false;
  const eligible=(row:QueuedCodexMessage)=>active
    ? row.profileHint!=='work' && !row.media && row.offeredTo!==active.id && sameChatActor(row,{fromUserId:active.fromUserId,chatContext:active.session.chatContext})
    : !session.workJobId || (row.profileHint??conversationProfile(row.userText,chooseRoute(row.userText,session,config,!!row.media),session))==='companion';
  const index=nextChatBatchIndex(queue,eligible);
  const next = index < 0 ? undefined : queue?.[index];
  if (!next) return false;
  const delay = messageBatchDelay(next);
  if (delay > 0) {
    queuedDrains.set(account.accountId, setTimeout(() => {
      queuedDrains.delete(account.accountId);
      drainQueue(account, session, store, sender, config);
    }, delay));
    return true;
  }
  if(active) {
    if(next.messageIds?.length) {
      offerInput(active.id,{text:next.userText,ids:next.messageIds});next.offeredTo=active.id;saveQueue();
    }
    return true;
  }
  session.pendingRequest = next; store.save(account.accountId, session);
  queue!.splice(index, 1);
  if (!queue!.length) queuedMessages.delete(account.accountId);
  saveQueue();
  void sendToCodex(next.userText, next.media, next.fromUserId, next.contextToken, account, session, store, sender, config, next.messageIds, next.profileHint, next.chatContext);
  return true;
}

function scheduleIdleCompaction(
  account: ChannelAccount, session: Session, store: ReturnType<typeof createSessionStore>,
  sender: WechatSender, config: ReturnType<typeof loadConfig>,
) {
  cancelIdleCompaction(account.accountId);
  if (account.entryRole === 'control') return;
  const runtime = process.env.WCB_CODEX_RUNTIME_SOCKET;
  if (!runtime || !idleCompactionDue(session) || queuedMessages.get(account.accountId)?.length) return;
  idleCompactions.set(account.accountId, setTimeout(() => {
    idleCompactions.delete(account.accountId);
    if (desktopDeployHeld() || !idleCompactionDue(session) || queuedMessages.get(account.accountId)?.length) return;
    const previous = session.lastJobId ? readJob(session.lastJobId).options : undefined;
    const chatOptions = previous?.profile === 'companion' ? previous : undefined;
    const characterThread = !!chatOptions || (session.companionVersion ?? 0) >= 4;
    // The next real turn will rebuild delivered history on the selected
    // backend. Do not spend the old backend's quota compacting that old thread.
    if (characterThread && (chatOptions?.llmProvider ?? 'codex') !== selectedChatLlm().id) return;
    session.lastCompactionTokens = session.contextTokens;
    const job = createJob({ accountId: account.accountId, kind: 'compact', userText: '',
      fromUserId: session.jobFromUserId ?? account.userId, contextToken: session.jobContextToken ?? '',
      session: { ...session }, tempFiles: [], options: {
        prompt: '', threadId: session.threadId,
        cwd: characterThread ? join(DATA_DIR, 'chat-workspace') : session.workingDirectory,
        mode: characterThread ? 'plan' : session.mode ?? config.mode ?? 'workspace',
        developerInstructions: characterThread ? assembleEntryPrompt(loadPersonaSnapshot(true),
          chooseRoute('', session, config), [], true, 'companion').developerInstructions : previous?.developerInstructions,
        baseInstructions: characterThread ? COMPANION_BASE : undefined,
        threadConfig: characterThread ? CHARACTER_CONFIG : undefined,
        model: session.contextModel, serviceTier: chatOptions?.serviceTier ?? config.serviceTier,
        llmProvider: chatOptions?.llmProvider, llmFingerprint: chatOptions?.llmFingerprint, modelProvider: chatOptions?.modelProvider,
        reasoningEffort: chatOptions?.reasoningEffort ?? session.reasoningEffort ?? config.reasoningEffort,
        contextWindow: session.contextWindow,
      } });
    session.activeJobId = job.id; session.state = 'processing'; store.save(account.accountId, session);
    try { launchJob(job); } catch (error) { logger.warn('Could not launch idle compaction', { error: String(error) }); }
    void watchJob(job.id, account, session, store, sender, config);
  }, COMPACTION_IDLE_MS));
}

function scheduleIndex(account: ChannelAccount, session: Session) {
  if (account.entryRole === 'control') return;
  clearTimeout(indexTimers.get(account.accountId));
  indexTimers.set(account.accountId, setTimeout(async () => {
    try {
      const config = embeddingConfig(), peer = session.jobFromUserId ?? account.userId;
      if (desktopDeployHeld() || !config || !peer || loadPersonaSnapshot(true)?.version !== 'ruanruan-core-v6'
        || session.activeJobId || session.workJobId || session.state === 'processing'
        || queuedMessages.get(account.accountId)?.length) return;
      const controller = new AbortController(); indexRequests.set(account.accountId, controller);
      const index = createMemoryStore(account.accountId,undefined,account.person).semantic(peer, session.conversationAfter);
      const result = await index.index(config, controller.signal);
      if (result.indexed) logger.info('Memory embeddings indexed', result);
    } catch { logger.warn('Background memory indexing postponed'); }
    finally { indexRequests.delete(account.accountId); scheduleIndex(account, session); }
  }, 30000));
}

function scheduleMemory(account: ChannelAccount, session: Session, store: ReturnType<typeof createSessionStore>, config: ReturnType<typeof loadConfig>, delay = CONSOLIDATION_IDLE_MS) {
  clearTimeout(idleMemories.get(account.accountId));
  if (account.entryRole === 'control') return;
  if (!process.env.WCB_CODEX_RUNTIME_SOCKET || (account.entryRole!=='character'&&![5, 6].includes(session.companionVersion ?? 0))) return;
  idleMemories.set(account.accountId, setTimeout(() => {
    idleMemories.delete(account.accountId);
    if (desktopDeployHeld() || session.activeJobId || session.workJobId || session.backgroundJobId || session.queuePaused || queuedMessages.get(account.accountId)?.length) return;
    const peer = session.jobFromUserId ?? account.userId;
    if (!peer) return;
    const remaining = (createMemoryStore(account.accountId,undefined,account.person).continuity.meta().attempted ?? 0) + CONSOLIDATION_INTERVAL_MS - Date.now();
    if (remaining > 0) { scheduleMemory(account, session, store, config, remaining + 50); return; }
    ensureConsolidationBackfill(account.accountId,peer,{person:account.person,after:session.conversationAfter});
    const batch = pendingConsolidation(account.accountId, peer, session.conversationAfter,Date.now(),{person:account.person});
    if (!batch) return;
    if (!batch.messages.length) { scheduleMemory(account, session, store, config); return; }
    const options = consolidationOptions(batch, account.accountId, { cwd: join(DATA_DIR, 'chat-workspace'),
      ...LIFE_PROFILE });
    const job = createJob({ accountId: account.accountId, kind: 'consolidate', consolidation: batch,
      userText: '', fromUserId: peer, contextToken: '', options, session: { ...session }, tempFiles: [] });
    createMemoryStore(account.accountId,undefined,account.person).continuity.attempted();
    session.backgroundJobId = job.id; store.save(account.accountId, session);
    try { launchJob(job); } catch (error) { logger.warn('Memory job launch failed', { error: String(error) }); }
    void watchMemory(job.id, account, session, store, config);
  }, delay));
}

async function watchMemory(id: string, account: ChannelAccount, session: Session, store: ReturnType<typeof createSessionStore>, config: ReturnType<typeof loadConfig>) {
  let committed = false;
  let lifeBatch: Job['life'];
  try {
    const job = readJob(id);
    lifeBatch = job.life;
    while (true) {
      const status = inspectJob(id);
      if (isTerminal(status)) {
        const canCommit = status.state === 'completed' && !!status.result && !stopRequested(id)
          && !session.activeJobId && !session.workJobId && !queuedMessages.get(account.accountId)?.length
          && session.state !== 'processing' && (session.lastInputAt ?? 0) <= job.createdAt
          && job.session.conversationAfter === session.conversationAfter;
        if (job.life) {
          committed = createLifeStore().settle(job.life, status.result ?? { replyText: '', commands: [], fileChanges: [] }, canCommit);
          logger.info('Character life heartbeat finished', { id, committed, model: job.options?.model,
            inputTokens: status.result?.inputTokens, outputTokens: status.result?.outputTokens });
        } else if (canCommit && job.consolidation) {
          const outcome = commitConsolidation(account.accountId, job.consolidation, status.result!);
          committed = true;
          logger.info('Delivered conversation consolidated', { id, through: job.consolidation.through, ...outcome });
        }
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (error) {
    if (lifeBatch) createLifeStore().settle(lifeBatch, { replyText: '', commands: [], fileChanges: [], error: String(error) }, false);
    logger.warn('Background memory not committed', { id, error: String(error) });
  }
  finally {
    if (session.backgroundJobId === id) { session.backgroundJobId = undefined; store.save(account.accountId, session); }
    if (committed || !lifeBatch) scheduleMemory(account, session, store, config);
  }
}

export async function watchJob(
  id: string, account: ChannelAccount, session: Session, store: ReturnType<typeof createSessionStore>,
  sender: WechatSender, config: ReturnType<typeof loadConfig>,
  initialTyping?: ReturnType<WechatSender['startTyping']>,
): Promise<void> {
  if (watching.has(id)) { await initialTyping?.stop(); return; }
  watching.add(id);
  let typing = initialTyping;
  let deliveryProgress:(()=>string[])|undefined;
  try {
    const job = readJob(id);
    if(job.options?.conversation?.person)account={...account,person:job.options.conversation.person};
    const context=job.session.chatContext;
    sender=sender.forConversation?.(account.accountId,context?.kind==='group'?(context.participation==='direct'?{username:context.actorId,name:context.actorName}:null):undefined)??sender;
    while (true) {
      const s = inspectJob(id);
      if (s.acceptedInputIds?.length) {
        const queue = queuedMessages.get(account.accountId);
        if (queue?.length) {
          queuedMessages.set(account.accountId, queue.filter(row => !row.messageIds?.length
            || !row.messageIds.every(value => s.acceptedInputIds!.includes(value))));
          if (queuedMessages.get(account.accountId)?.length !== queue.length) saveQueue();
        }
      }
      if (isTerminal(s)) {
        if (job.kind === 'compact') {
          if (s.result?.contextTokens !== undefined) session.contextTokens = s.result.contextTokens;
          session.activeJobId = undefined; session.state = 'idle';
          store.save(account.accountId, session);
          logger.info('Idle compaction finished', { id, state: s.state, contextTokens: session.contextTokens });
          drainQueue(account, session, store, sender, config);
          scheduleMemory(account, session, store, config);
          return;
        }
        const modeChanged = (job.session.modeRevision ?? 0) !== (session.modeRevision ?? 0);
        if (job.kind === 'codex' && s.session) {
          acceptThread(session, s.session, job.options?.profile === 'work');
          if (modeChanged && job.options?.profile === 'companion') session.rotateBeforeNext = true;
          if (s.result?.memoryForgotten) session.workContext = undefined;
        } else if (s.threadId) session.threadId = s.threadId;
        if (s.state !== 'completed') {
          // A failed conversational reply is not a suspended server operation.
          // New messages may continue; the failed request is never replayed.
          if (!modeChanged) session.queuePaused ||= job.options?.profile !== 'companion' || s.state === 'stopped';
          if (job.options?.profile === 'work') (session.workContext ??= {}).rotateBeforeNext = true;
          else session.rotateBeforeNext = true;
          if (session.routingTask) session.routingTask = { ...session.routingTask, state: s.state === 'stopped' ? 'cancelled' : 'failed', updatedAt: Date.now() };
        }
        // Persist results before attempting delivery. A failed send leaves activeJobId for /resume.
        store.save(account.accountId, session);
        if (s.result?.superseded && job.options?.profile === 'companion') {
          const queue = queuedMessages.get(account.accountId) ?? [];
          const original: QueuedCodexMessage = { ...job.session.pendingRequest,
            userText: job.userText, fromUserId: job.fromUserId, contextToken: job.contextToken,
            media: job.session.pendingRequest?.media, chatContext: job.session.chatContext,
            messageIds: job.options.conversation?.messageIds, profileHint: 'companion' };
          const acceptedIds = [...new Set([...(s.acceptedInputIds ?? []), ...(s.result.acceptedInputIds ?? [])])];
          const accepted = createConversationStore(account.accountId, job.fromUserId).byIds(acceptedIds)
            .filter(row => !original.messageIds?.includes(row.id)).map(row => ({ ...original, userText: row.text,
              media: undefined, messageIds: [row.id] }));
          if (requeueSupersededBatch(queue, original, accepted)) {
            queuedMessages.set(account.accountId, queue); saveQueue();
          }
          session.rotateBeforeNext = true; session.lastJobId = id;
          if (session.activeJobId === id) session.activeJobId = undefined;
          session.state = 'idle'; store.save(account.accountId, session);
          await typing?.stop(); typing = undefined;
          cleanupTempFiles(job.tempFiles);
          logger.info('Superseded draft retained; full input continues with the new batch', {id});
          drainQueue(account, session, store, sender, config); return;
        }
        const blocked=characterDeliveryBlockedReason(job.options,s.result);
        if(blocked) {
          session.lastJobId=id;if(session.activeJobId===id)session.activeJobId=undefined;
          session.state='idle';store.save(account.accountId,session);
          logger.warn('Character reply retained without delivery',{id,error:blocked,review:s.result?.characterReview});
          if(s.state!=='stopped')void retainRuntimeFailure(s.result?.characterReview?.failureReason??blocked,id)
            .catch(error=>logger.warn('Could not retain character delivery failure',{id,error:String(error)}));
          await typing?.stop();typing=undefined;
          drainQueue(account,session,store,sender,config);return;
        }
        const text = job.options?.profile==='companion'?s.result?.replyText??'':s.result?.error
          ? `⚠️ ${s.phase}\n${s.result.error.slice(0, 1200)}\n可用 /resume 核查现场后继续。`:replyTextForDelivery(s.result);
        const replyContext=account.transport==='desktop'&&job.options?.profile==='companion'
          ?desktopReplyContext(job.contextToken,[...(s.result?.acceptedInputIds??[]),...(s.acceptedInputIds??[])])
          :session.jobContextToken??job.contextToken;
        const allowBurst = job.options?.profile === 'companion' || Date.now() - (session.lastBurstAt ?? 0) >= BURST_COOLDOWN_MS;
        const selected = resolveCharacterMedia(s.result?.error ? { replyText: text } : { ...s.result!, replyText: text }, job.mediaCandidates);
        const attachments = s.result?.error ? { text, images: [] } : extractReplyImages(selected.text, job.options?.cwd ?? session.workingDirectory);
        const videos: string[] = [];
        let selectedPath: string | undefined;
        if (selected.asset && !attachments.images.length && !modeChanged) {
          if (selected.asset.purpose === 'reaction') {
            selectedPath = memeFile(selected.asset, jobDir(id));
          } else selectedPath = catalogFile(selected.asset);
        }
        if (selectedPath && selected.asset) {
          if (selected.asset.kind === 'image') attachments.images.push(selectedPath); else videos.push(selectedPath);
        }
        const reply = planChatReply(attachments.text, allowBurst);
        const shouldContinue = () => (job.session.modeRevision ?? 0) === (session.modeRevision ?? 0)
          && (job.options?.profile !== 'companion' || !queuedMessages.get(account.accountId)?.some(row=>
            sameChatActor(row,{fromUserId:job.fromUserId,chatContext:job.session.chatContext})));
        const journal = createConversationStore(account.accountId, session.jobFromUserId ?? job.fromUserId);
        const beforeDelivery = journal.latestSequence();
        deliveryProgress=()=>journal.since(beforeDelivery,100).filter(row=>row.direction==='out').map(row=>row.text);
        try {
        if (!modeChanged) await sender.inThread(s.result?.error ? undefined : s.result?.threadId, async () => {
        if (attachments.images.length || videos.length) {
          const delivery = await deliverAlbumReply({ directory: jobDir(id), images: attachments.images, texts: reply.messages.filter(message => message.trim()),
            videos,
            ...(selected.asset?.purpose === 'reaction' ? { textFirst: account.transport !== 'desktop', optionalImage: true, emptyImageFallback: '',
              prepareImage: async () => {
                const memes = createMemeClient();
                try { await memes.download(selected.asset!, jobDir(id)); }
                finally { await memes.close(); }
              } } : {}),
            accountId: account.accountId, peerId: session.jobFromUserId ?? job.fromUserId, jobId: id,
            asset: selectedPath ? selected.asset : undefined,
            sender, toUserId: session.jobFromUserId ?? job.fromUserId,
            contextToken: () => replyContext, shouldContinue });
          if (delivery.cancelled) retainDeliveryContext(session,deliveryProgress!());
        } else {
          const delivery = await deliverChatMessages(reply.messages,
            message => sender.sendText(session.jobFromUserId ?? job.fromUserId, replyContext, message),
            { shouldContinue, gapMs: job.options?.profile === 'companion' && (s.result?.timing?.elapsedMs ?? 0) < 8000 ? 450 : 0 });
          if (delivery.interrupted) retainDeliveryContext(session,deliveryProgress!());
        }
        }, s.result?.error ? 'control' : job.options?.profile === 'work' ? 'work' : 'companion',
          fishingMemoryPolicy(job.options));
        // Cross-conversation choices share the review, but use destination
        // journals and receipts. A failed transfer does not discard this reply.
        if(!modeChanged&&job.options?.profile==='companion'&&!s.result?.error) {
          for(const plan of s.result?.crossDeliveries??[]) {
            if(!shouldContinue())break;
            try {
              const delivered=await deliverCrossConversation(plan,{sender,jobDirectory:jobDir(id),sourceJobId:id,
                shouldContinue,threadId:s.result?.threadId,memoryPolicy:fishingMemoryPolicy(job.options)??fishingMemoryPolicy({profile:'companion',
                  conversation:{accountId:plan.route.storageAccountId,peerId:plan.route.peerId,
                    roomId:plan.route.kind==='group'?plan.route.conversationId:undefined}})});
              logger.info('Reviewed cross-conversation delivery settled',{id,planId:plan.id,target:plan.route.peerId,
                sent:delivered.parts.filter(part=>part.status==='sent').length,cancelled:delivered.cancelled??false});
            }catch(error){logger.warn('Cross-conversation delivery retained',{id,planId:plan.id,error:String(error).slice(0,300)});}
          }
        }
        } finally {
          if (!modeChanged && job.options?.profile === 'companion' && s.result && !s.result.error) {
            try {
              const memory = createMemoryStore(account.accountId,undefined,account.person);
              const inputs = journal.byIds([...(job.options.conversation?.messageIds ?? []), ...(s.result.acceptedInputIds ?? [])]);
              const sent = journal.since(beforeDelivery, 100).filter(row => row.direction === 'out');
              if(s.result.characterUpdate?.cancelImageTaskId && (sent.length||s.result.replyDisposition==='no_reply'))
                createGeneratedImageQueue().cancel(s.result.characterUpdate.cancelImageTaskId,account.accountId,session.jobFromUserId??job.fromUserId);
              const generation=selected.generation;
              const generationConfig=imageGenerationConfig();
              if(generation && generationConfig && sent.length && shouldContinue()){
                const latest=inputs.filter(row=>row.direction==='in'&&row.profile==='companion').at(-1);
                if(latest)createGeneratedImageQueue().enqueue({id,proposal:generation,accountId:account.accountId,chatContext:job.session.chatContext,
                  peerId:session.jobFromUserId??job.fromUserId,modeRevision:session.modeRevision??0,inputSeq:latest.seq,at:Date.now()},generationConfig);
              }
              const decision=s.result.characterUpdate?.social;
              if (decision && (s.result.replyDisposition==='no_reply' || sent.length)) {
                const source=inputs.find(row=>row.profile==='companion' && row.direction==='in' && row.text.includes(decision.userQuote));
                if(source)memory.socialObserve(session.jobFromUserId ?? job.fromUserId, source.id, source.text, decision, Date.now(), sent.map(row=>row.text).join('\n'));
              }
              const outcome = memory.character.commit(s.result.characterUpdate, [...inputs, ...sent], memory);
              logger.info('Delivered character turn committed', outcome);
            } catch { logger.warn('Delivered character state deferred; source messages remain available'); }
          }
        }
        if (reply.burst) session.lastBurstAt = Date.now();
        await typing?.stop();
        typing = undefined;
        cleanupTempFiles(job.tempFiles);
        session.lastJobId = id;
        if (session.workJobId === id) { session.lastWorkJobId = id; session.workJobId = undefined; }
        if (session.activeJobId === id) { session.activeJobId = undefined; session.state = 'idle'; }
        store.save(account.accountId, session);
        if (!drainQueue(account, session, store, sender, config)) scheduleIdleCompaction(account, session, store, sender, config);
        scheduleMemory(account, session, store, config);
        return;
      }
      if (job.kind === 'codex' && !s.executionStarted) {
        typing ??= sender.startTyping(session.jobFromUserId ?? job.fromUserId, session.jobContextToken ?? job.contextToken);
      } else if (typing) {
        await typing.stop();
        typing = undefined;
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  } catch (error) {
    logger.error('Task attachment/delivery failed; retained for resume', { id, error: String(error) });
    if (account.entryRole === 'character' && session.activeJobId === id) {
      // Chat-only entries have no /resume command. Keep delivery receipts for
      // inspection without holding all later messages behind the failed turn.
      session.lastJobId = id;
      session.activeJobId = undefined;
      session.state = 'idle';
      if(deliveryProgress)retainDeliveryContext(session,deliveryProgress());
      else session.rotateBeforeNext = true;
      store.save(account.accountId, session);
      drainQueue(account, session, store, sender, config);
    }
  } finally {
    await typing?.stop();
    watching.delete(id);
  }
}

const command = process.argv[2];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
if (command === 'setup') {
  (async () => {
    if (channelKind() !== 'ilink') throw new Error('个人微信请按 docs/DEPLOYMENT.md 登录桌面并运行 desktop/activate.mjs；不使用 API 扫码入口。');
    const { runSetup } = await import(new URL('./control/setup.js', import.meta.url).href);
    await runSetup();
  })().catch((err) => {
    logger.error('Setup failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('设置失败:', err);
    process.exit(1);
  });
} else {
  runDaemon().catch((err) => {
    logger.error('Daemon start failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('启动失败:', err);
    process.exit(1);
  });
}

}
