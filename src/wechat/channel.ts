import type { ConversationProfile, ConversationMemoryPolicy } from '../conversation.js';
import type { SupportedMedia, MediaPreparationDeps } from './media.js';
import type { SendAcknowledgement } from './receipt.js';
import type { WeixinMessage } from './types.js';
import type { IdentityView } from '../identity.js';

export type WechatChannelKind = 'ilink' | 'desktop';
export interface ChannelAccount {
  accountId: string;
  userId: string;
  transport: WechatChannelKind;
  entryRole?: 'character' | 'control';
  person?: PersonContext;
}
export interface PersonContext { accountId:string; actorId:string; audience:string; platform?:'wechat'|'qq' }
export interface ChatContext {
  kind: 'private' | 'group'; conversationId: string; conversationName: string;
  actorId: string; actorName: string;
  person?:IdentityView;
  participation?: 'direct'|'ambient';
}
export interface IncomingMessage extends WeixinMessage {
  // Supplied by a local adapter, never trusted from an iLink payload.
  localMedia?: SupportedMedia;
  chatContext?: ChatContext;
  unavailableMedia?: 'image' | 'audio' | 'video' | 'sticker';
  addressed?: boolean;
  contextOnly?: boolean;
  roomEventId?: string;
  scheduledRoomCheck?: boolean;
  desktopSourceId?: string;
  desktopVoiceWaitUntil?: number;
  replyTo?: import('../desktop/room-context.js').MessageReference;
  mentions?:string[];
  desktopMedia?: import('../desktop/room-context.js').RoomMedia;
  desktopPayment?: import('../desktop/database-proof.js').DatabaseMessageProof['payment'];
}
export interface WechatSender {
  sendText(peerId: string, context: string, text: string, clientId?: string): Promise<SendAcknowledgement>;
  sendImage(peerId: string, context: string, path: string, options?: SendMediaOptions): Promise<SendAcknowledgement>;
  sendVideo(peerId: string, context: string, path: string, options?: SendMediaOptions): Promise<SendAcknowledgement>;
  inThread<T>(thread: string | undefined, action: () => Promise<T>, profile?: ConversationProfile, memoryPolicy?: ConversationMemoryPolicy): Promise<T>;
  startTyping(peerId: string, context: string): { stop(): Promise<void> };
  forConversation?(storageAccountId: string, mention?: {username:string;name:string}|null): WechatSender;
}
export interface SendMediaOptions { clientId?: string; beforeSend?: () => void; notifyRecipient?: boolean }
export interface ChannelCallbacks {
  onMessage(message: IncomingMessage): Promise<void>;
  onSessionExpired(): void;
}
export interface WechatChannel {
  account: ChannelAccount;
  sender: WechatSender;
  mediaPreparation?: Pick<MediaPreparationDeps, 'downloadImageToTemp' | 'downloadBinaryMediaToTemp'>;
  createMonitor(callbacks: ChannelCallbacks): { run(): Promise<void>; stop(): void };
}

export function channelKind(value = process.env.WCB_CHANNEL ?? process.env.WCB_WECHAT_TRANSPORT): WechatChannelKind {
  if (value === undefined || value === '' || value === 'desktop') return 'desktop';
  if (value === 'ilink') return value;
  throw new Error(`Unknown chat transport: ${value}`);
}
