import { channelKind, type WechatChannel } from './channel.js';
import { createDesktopChannel } from '../desktop/channel.js';

// The control adapter is local-only. URL loading keeps the desktop source tree
// buildable when the private adapter directory is absent from the release.
export async function createWechatChannel(kind = channelKind()): Promise<WechatChannel> {
  if (kind === 'desktop') return createDesktopChannel();
  if (kind !== 'ilink') throw new Error(`Unknown chat transport: ${kind}`);
  const moduleUrl = new URL('../control/channel.js', import.meta.url).href;
  const { createControlChannel } = await import(moduleUrl);
  return createControlChannel();
}
