import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { createConversationStore, type ConversationProfile, type ConversationMemoryPolicy } from '../conversation.js';
import { logger } from '../logger.js';
import type { ChannelCallbacks, SendMediaOptions, WechatChannel, WechatSender } from '../wechat/channel.js';
import { SendRejected, SendSuperseded, type SendAcknowledgement } from '../wechat/receipt.js';
import { MessageItemType, MessageState, MessageType } from '../wechat/types.js';
import { loadDesktopConfig, requireDesktopEnabled, type DesktopConfig } from './config.js';
import { createDesktopStore, type DesktopDelivery } from './store.js';
import { createRoomStore } from './room-context.js';
import { deploymentHeld } from './deployment-hold.js';
import { dirname, join } from 'node:path';

export function createDesktopSender(config: DesktopConfig, options: {
  store?: ReturnType<typeof createDesktopStore>; journalDirectory?: string; journalAccountId?: string; pollMs?: number; receiptTimeoutMs?: number; mention?: {username:string;name:string}|null;
} = {}): WechatSender {
  const store = options.store ?? createDesktopStore(config);
  const context = new AsyncLocalStorage<{ thread?: string; profile: ConversationProfile; memoryPolicy?: ConversationMemoryPolicy }>();
  async function send(peerId: string, token: string, kind: 'text' | 'image' | 'video', value: string,
    clientId = `wcc-${randomUUID()}`, beforeSend?: () => void, mentionOnly = false): Promise<SendAcknowledgement> {
    const current = context.getStore() ?? { profile: 'control' as const };
    const task = store.enqueue({ peerId, clientId, kind, context: token, thread:current.thread, profile:current.profile, mention:options.mention,
      ...(kind === 'text' ? { text: value, mentionOnly } : { file: value }) });
    let deadline = Date.now() + (options.receiptTimeoutMs ?? 180_000);
    let result: DesktopDelivery;
    while (true) {
      result = store.getDelivery(task.id);
      // Exceptional visual recovery has a bounded, explicitly extended lease.
      // Its sender must keep waiting for that same delivery's real receipt.
      if (result.status === 'ready' && 'recoveryExtended' in result && result.recoveryExtended === true
        && Number.isFinite(result.leaseUntil)) deadline = Math.max(deadline, result.leaseUntil! + 5000);
      if (result.status === 'claimed') {
        // Recheck mode changes/cancellation immediately before the GUI operator
        // can act, rather than authorizing an image when it first enters a queue.
        try { store.authorizeDelivery(task.id, beforeSend); }
        catch (e) { store.cancelUnsent(task.id, 'Delivery cancelled before UI authorization'); throw e; }
        continue;
      }
      if (['sent','rejected','uncertain','cancelled'].includes(result.status)) break;
      if (Date.now() >= deadline) {
        result = store.cancelUnsent(task.id, 'Desktop send receipt timed out; inspect the UI before resending');
        break;
      }
      await pause(options.pollMs ?? 200);
    }
    if (result.status !== 'sent') {
      if (result.cancelCause === 'superseded') throw new SendSuperseded(result.error!);
      if (result.status === 'cancelled' || result.status === 'rejected') throw new SendRejected(result.error || '桌面微信尚未发送');
      throw new Error(result.error || '桌面微信发送结果不确定，请先核对界面');
    }
    if (!result.evidence) throw new Error('Desktop delivery has no confirmation evidence');
    const item = kind === 'text' ? { type: MessageItemType.TEXT, text_item: { text: value } }
      : { type: kind === 'image' ? MessageItemType.IMAGE : MessageItemType.VIDEO };
    try {
      createConversationStore(options.journalAccountId??config.accountId, peerId, options.journalDirectory).record('out', {
        from_user_id: config.accountId, to_user_id: peerId, client_id: clientId,
        message_type: MessageType.BOT, message_state: MessageState.FINISH, item_list: [item],
        desktop_receipt: result.evidence,
        ...(current.memoryPolicy ? { memoryPolicy: current.memoryPolicy } : {}),
      }, result.evidence.observedAt, current.thread, current.profile);
    } catch { logger.error('Desktop send confirmed but journal unavailable; do not resend'); }
    // Database mode also verifies a new server-acknowledged outgoing row.
    // Neither that acknowledgement nor a screenshot is a read receipt.
    return { messageIdPresent: !!result.evidence.database?.serverId, desktopEvidence: result.evidence };
  }
  const media = (kind: 'image' | 'video') => async (peerId: string, token: string, path: string, opts: SendMediaOptions = {}) => {
    const clientId = opts.clientId ?? `wcc-${randomUUID()}`;
    const acknowledgement = await send(peerId, token, kind, path, clientId, opts.beforeSend);
    if (opts.notifyRecipient !== false && options.mention!==null && (options.mention||config.contacts.find(c=>c.peerId===peerId)?.actorUsername) && config.contacts.find(c => c.peerId === peerId)?.kind === 'group') {
      try { await send(peerId, token, 'text', '', clientId + '-mention', undefined, true); }
      catch (error) {
        // The attachment is already confirmed and journaled. A notification
        // failure must never turn that image into an uncertain, repeatable send.
        logger.warn('Group member notification failed after confirmed media', {clientId,error:String(error).slice(0,300)});
      }
    }
    return acknowledgement;
  };
  return {
    sendText: (peer, token, text, client) => send(peer, token, 'text', text, client),
    sendImage: media('image'), sendVideo: media('video'),
    inThread: (thread, action, profile = 'control', memoryPolicy) => context.run({ thread, profile, memoryPolicy }, action),
    forConversation: (storageAccountId,mention) => createDesktopSender(config,{...options,store,journalAccountId:storageAccountId,...(mention!==undefined?{mention}:{})}),
    startTyping: () => ({ stop: async () => {} }),
  };
}

export function createDesktopMonitor(config: DesktopConfig, callbacks: ChannelCallbacks, options: {
  store?: ReturnType<typeof createDesktopStore>; pollMs?: number; reloadConfig?: () => DesktopConfig;
} = {}) {
  const store = options.store ?? createDesktopStore(config), controller = new AbortController();
  const rooms=createRoomStore(config.queueDirectory);
  let nextStandbyCheck=0;
  return {
    async run() {
      requireDesktopEnabled(config);
      while (!controller.signal.aborted) {
        if (deploymentHeld(join(dirname(config.queueDirectory), 'auto-repair', 'deploy-hold.json'))) {
          try { await pause(options.pollMs ?? 250, undefined, { signal: controller.signal }); }
          catch (e) { if (!controller.signal.aborted) throw e; }
          continue;
        }
        if (options.reloadConfig) Object.assign(config,options.reloadConfig());
        if(Date.now()>=nextStandbyCheck) {
          nextStandbyCheck=Date.now()+1000;
          if(!store.status().paused)for(const due of rooms.due()) {
            const message=store.storedIncoming(due.eventId);
            if(message)try { await callbacks.onMessage({...message,scheduledRoomCheck:true}); }
            catch(error) { logger.error('Scheduled room check failed', {room:due.roomId,error:String(error).slice(0,200)}); }
          }
        }
        const next = store.takeIncoming();
        if (next) {
          try { await callbacks.onMessage(next.message); store.finishIncoming(next.seq); }
          catch (e) { store.finishIncoming(next.seq, e instanceof Error ? e.message : String(e)); }
        } else {
          try { await pause(options.pollMs ?? 250, undefined, { signal: controller.signal }); }
          catch (e) { if (!controller.signal.aborted) throw e; }
        }
      }
    },
    stop() { controller.abort(); },
  };
}

export function createDesktopChannel(config = loadDesktopConfig()): WechatChannel {
  requireDesktopEnabled(config);
  return {
    account: { accountId: config.accountId, userId: config.ownerPeerId, transport: 'desktop',entryRole:'character' },
    sender: createDesktopSender(config),
    createMonitor: callbacks => createDesktopMonitor(config, callbacks, {reloadConfig:loadDesktopConfig}),
  };
}
