import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const DESKTOP_DIR = join(homedir(), '.wechat-codex-desktop');
export interface ContactProfile { wechatId?:string; nickname?:string; roomNickname?:string; remark?:string }
export interface DesktopContact {
  peerId: string;
  uiLabel: string;
  identityNote: string;
  username?: string;
  actorUsername?: string;
  actorName?: string;
  kind?: 'private' | 'group';
  profile?:ContactProfile;
  members?: {username:string;name:string;mentionNames?:string[];profile?:ContactProfile}[];
  /** Successful read of this room's current member table, in Unix milliseconds. */
  rosterObservedAt?: number;
}
export interface DesktopConfig {
  version: 1;
  enabled: boolean;
  accountId: string;
  ownerPeerId: string;
  exchangeDirectory: string;
  queueDirectory: string;
  contacts: DesktopContact[];
  database?: { accountDirectory: string; selfUsername: string; ownerUsername: string };
  multiUser?: boolean;
  identityDirectory?:string;
}
export function desktopConfigPath() {
  return process.env.WCB_DESKTOP_CONFIG || join(DESKTOP_DIR, 'bridge.json');
}
export function parseDesktopConfig(value: unknown): DesktopConfig {
  const v = value as DesktopConfig;
  if (!v || v.version !== 1 || typeof v.enabled !== 'boolean') throw new Error('Invalid desktop configuration');
  if (typeof v.accountId !== 'string' || !/^desktop-[a-zA-Z0-9_-]+$/.test(v.accountId)) {
    throw new Error('Desktop accountId must use its own desktop- namespace');
  }
  if (typeof v.ownerPeerId !== 'string' || !Array.isArray(v.contacts)) throw new Error('Invalid desktop contact binding');
  const peers = new Set<string>(), labels = new Map<string,string>();
  for (const c of v.contacts) {
    if (!c || typeof c.peerId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(c.peerId)
      || typeof c.uiLabel !== 'string' || !c.uiLabel.trim()
      || typeof c.identityNote !== 'string' || !c.identityNote.trim()
      || peers.has(c.peerId) || (labels.has(c.uiLabel) && (!c.username || labels.get(c.uiLabel)!==c.username))
      || (c.username !== undefined && !/^[A-Za-z0-9_@.-]+$/.test(c.username))
      || (c.actorUsername !== undefined && !/^[A-Za-z0-9_@.-]+$/.test(c.actorUsername))
      || (c.kind !== undefined && !['private','group'].includes(c.kind))
      || (c.rosterObservedAt !== undefined && (!Number.isSafeInteger(c.rosterObservedAt) || c.rosterObservedAt <= 0))
      || (c.kind==='group' && (!c.username?.endsWith('@chatroom') || (!c.actorUsername && !Array.isArray(c.members))))) throw new Error('Desktop contacts need unique IDs, unambiguous labels and verified identity notes');
    peers.add(c.peerId); labels.set(c.uiLabel,c.username??c.peerId);
  }
  if (v.enabled && (!v.ownerPeerId || !peers.has(v.ownerPeerId))) throw new Error('Bind the desktop owner before enabling');
  for (const path of [v.exchangeDirectory, v.queueDirectory,...(v.identityDirectory?[v.identityDirectory]:[])]) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Desktop directories must be absolute paths');
  }
  if (v.database && (!/^[A-Za-z0-9_]+$/.test(v.database.accountDirectory)
    || !/^[A-Za-z0-9_-]+$/.test(v.database.selfUsername) || !/^[A-Za-z0-9_-]+$/.test(v.database.ownerUsername)
    || !v.database.accountDirectory.startsWith(v.database.selfUsername + '_')
    || v.database.selfUsername === v.database.ownerUsername)) throw new Error('Invalid verified database binding');
  return { ...v, exchangeDirectory: resolve(v.exchangeDirectory), queueDirectory: resolve(v.queueDirectory) };
}
export function loadDesktopConfig(path = desktopConfigPath()): DesktopConfig {
  return parseDesktopConfig(JSON.parse(readFileSync(path, 'utf8')));
}
export function requireDesktopEnabled(config: DesktopConfig) {
  if (!config.enabled) throw new Error('桌面微信通道尚未启用；当前正式通道继续保留');
}
export function desktopContact(config: DesktopConfig, peerId: string, uiLabel?: string) {
  const contact = config.contacts.find(row => row.peerId === peerId);
  // Non-owner routes require the read-only address book and isolated chat mode.
  if (!contact || (peerId !== config.ownerPeerId && !(config.database && config.multiUser && contact.username))) throw new Error('Desktop contact is not the bound owner or an identified chat');
  if (uiLabel !== undefined && uiLabel !== contact.uiLabel) throw new Error('Visible conversation does not match the bound contact');
  return contact;
}
