import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMediaState } from '../media-state.js';
import { describeMedia, mediaIdentity, type CatalogCandidate } from '../media-catalog.js';
import { createConversationStore } from '../conversation.js';
import { deliverImageReply } from './image-delivery.js';

// Enrich the actual accepted transport message, not a second synthetic event.
// A caption failure cannot make an accepted photograph become "unsent".
export async function deliverAlbumReply(options: Parameters<typeof deliverImageReply>[0] & {
  accountId: string; peerId: string; jobId: string; asset?: CatalogCandidate; dataDirectory?: string;
}) {
  const { asset } = options;
  const ledger = asset ? createMediaState(options.accountId, options.dataDirectory) : undefined;
  if (ledger && asset && !ledger.reserve(options.jobId, mediaIdentity(asset), asset.repeatAllowed)) {
    throw new Error('该画面已被其他消息使用，本次未重复发送；可继续聊天或换一张。');
  }
  const journal = asset ? createConversationStore(options.accountId, options.peerId, options.dataDirectory) : undefined;
  let mediaMessageId: string | undefined;
  const captions: string[] = [];
  try {
    const result = await deliverImageReply({ ...options, onPartSent: async part => {
      if (ledger && asset && journal) {
        if (part.kind !== 'text') {
          ledger.confirm(options.jobId, mediaIdentity(asset));
          mediaMessageId = `out:${part.clientId}`;
          if (!journal.annotateMedia(mediaMessageId, { ...describeMedia(asset), ...(captions.length ? { caption: captions.join('\n') } : {}) })) {
            throw new Error('媒体已获微信确认，但相册信息未能关联原消息；请核查记录，不要重发。');
          }
        } else {
          captions.push(part.value);
          if (mediaMessageId) journal.annotateMedia(mediaMessageId, { caption: captions.join('\n') });
        }
      }
      await options.onPartSent?.(part);
    } });
    if (result.cancelled && result.parts.filter(part => part.kind !== 'text').every(part => part.status === 'cancelled')) ledger?.release(options.jobId);
    return result;
  } catch (error) {
    if (ledger) {
      let outcome: { parts: { kind: string; status: string }[] } | undefined;
      try { outcome = JSON.parse(readFileSync(join(options.directory, 'image-delivery.json'), 'utf8')); }
      catch { /* No send starts before the receipt file exists. */ }
      if (!outcome || outcome.parts.filter(part => part.kind !== 'text').every(part => ['pending', 'rejected'].includes(part.status))) ledger.release(options.jobId);
    }
    throw error;
  }
}
