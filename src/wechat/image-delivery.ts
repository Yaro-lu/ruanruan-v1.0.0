import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite } from '../jobs.js';
import { SendRejected, SendSuperseded, type SendAcknowledgement } from './receipt.js';
import type { WechatSender } from './channel.js';

export interface Part {
  kind: 'image' | 'video' | 'text'; value: string; clientId: string;
  status: 'pending' | 'sending' | 'sent' | 'rejected' | 'uncertain' | 'cancelled';
  acknowledgement?: SendAcknowledgement; error?: string;
}
export interface Delivery { version: 1; parts: Part[]; cancelled?: boolean }
class Superseded extends Error {}

export function imageDeliverySummary(directory: string): string | undefined {
  try {
    const delivery: Delivery = JSON.parse(readFileSync(join(directory, 'image-delivery.json'), 'utf8'));
    const images = delivery.parts.filter(part => part.kind === 'image' || part.kind === 'video');
    const sent = images.filter(part => part.status === 'sent').length;
    const uncertain = delivery.parts.some(part => part.status === 'uncertain' || part.status === 'sending');
    return `媒体投递：${sent}/${images.length} 已获接口确认${uncertain ? '；有结果不确定的消息，暂停重发' : sent < images.length ? '；尚未全部送出' : ''}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return '图片投递记录读取异常';
  }
}

// Durable progress for replies containing images. Upload failures may be retried;
// a send with an ambiguous acknowledgement must be checked, not replayed.
export async function deliverImageReply(options: {
  directory: string; images: string[]; videos?: string[]; texts: string[];
  sender: Pick<WechatSender, 'sendText' | 'sendImage'> & Partial<Pick<WechatSender, 'sendVideo'>>;
  toUserId: string; contextToken: () => string;
  onPartSent?: (part: Part) => void | Promise<void>;
  shouldContinue?: () => boolean;
  textFirst?: boolean;
  prepareImage?: (path: string) => Promise<void>;
  optionalImage?: boolean;
  emptyImageFallback?: string;
}): Promise<Delivery> {
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const path = join(options.directory, 'image-delivery.json');
  let delivery: Delivery;
  try { delivery = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const images = [
      ...options.images.map(value => ({ kind: 'image' as const, value })),
      ...(options.videos ?? []).map(value => ({ kind: 'video' as const, value })),
    ];
    const texts = options.texts.map(value => ({ kind: 'text' as const, value }));
    delivery = { version: 1, parts: (options.textFirst ? [...texts, ...images] : [...images, ...texts])
      .map(part => ({ ...part, clientId: `wcc-${randomUUID()}`, status: 'pending' as const })) };
    atomicWrite(path, delivery);
  }
  if (delivery.version !== 1 || !Array.isArray(delivery.parts)) throw new Error('图片投递记录格式异常');
  const cancel = () => {
    delivery.cancelled = true;
    for (const part of delivery.parts) if (part.status === 'pending' || part.status === 'rejected') part.status = 'cancelled';
    atomicWrite(path, delivery);
    return delivery;
  };
  for (const part of delivery.parts) {
    if (part.status === 'sent') { await options.onPartSent?.(part); continue; }
    if (part.status === 'cancelled') continue;
    if (part.status === 'sending' || part.status === 'uncertain') throw new Error('图片回复的投递结果不确定，已暂停重发；请先核对微信收件');
    if (options.shouldContinue && !options.shouldContinue()) return cancel();
    if (part.kind === 'image' && options.prepareImage) {
      try { await options.prepareImage(part.value); }
      catch (error) {
        if (!options.optionalImage) throw error;
        part.status = 'cancelled'; part.error = '反应图未能准备，未发送图片'; delivery.cancelled = true;
        if (options.emptyImageFallback && !delivery.parts.some(row => row.kind === 'text' && row.value.trim())) {
          delivery.parts.push({ kind: 'text', value: options.emptyImageFallback, clientId: `wcc-${randomUUID()}`, status: 'pending' });
        }
        atomicWrite(path, delivery); continue;
      }
    }
    let sending = false;
    const beforeSend = () => {
      if (options.shouldContinue && !options.shouldContinue()) throw new Superseded();
      sending = true; part.status = 'sending'; delete part.error; atomicWrite(path, delivery);
    };
    try {
      // A following caption already carries the group's native @. Standalone
      // image replies need their own notification, after media confirmation.
      const notifyRecipient = !delivery.parts.slice(delivery.parts.indexOf(part) + 1)
        .some(row => row.kind === 'text' && row.value.trim() && row.status !== 'cancelled');
      if (part.kind === 'image') {
        part.acknowledgement = await options.sender.sendImage(options.toUserId, options.contextToken(), part.value,
          { clientId: part.clientId, beforeSend, notifyRecipient });
      } else if (part.kind === 'video') {
        if (!options.sender.sendVideo) throw new Error('视频发送器不可用');
        part.acknowledgement = await options.sender.sendVideo(options.toUserId, options.contextToken(), part.value,
          { clientId: part.clientId, beforeSend, notifyRecipient });
      } else {
        beforeSend();
        part.acknowledgement = await options.sender.sendText(options.toUserId, options.contextToken(), part.value, part.clientId);
      }
      part.status = 'sent';
      atomicWrite(path, delivery);
    } catch (error) {
      if (error instanceof Superseded || error instanceof SendSuperseded) { part.status = 'cancelled'; return cancel(); }
      part.status = !sending ? 'pending' : error instanceof SendRejected ? 'rejected' : 'uncertain';
      // API/CDN errors are already sanitized; do not persist raw request bodies.
      part.error = error instanceof Error ? error.message.slice(0, 300) : '图片投递失败';
      atomicWrite(path, delivery);
      throw error;
    }
    // Receipt is durable before metadata callbacks; a bookkeeping failure must
    // not turn an accepted message into an uncertain send or cause a replay.
    await options.onPartSent?.(part);
  }
  return delivery;
}
