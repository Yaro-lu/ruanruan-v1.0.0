import type { DesktopConfig } from './config.js';

// Produced by the private read-only worker. Not exposed as a model tool.
export interface DatabaseMessageProof {
  accountDirectory: string; selfUsername: string; ownerUsername: string;
  senderUsername: string; shard: string; localId: number; serverId: string;
  createdAt: number; messageType: number; text: string; fileMd5?: string;
  conversationUsername?: string; atUsernames?: string[]; displayText?: string;
  payment?: { kind: 'red_packet' | 'transfer'; receipt: 'unconfirmed'; amountText: string | null; description?: string };
}
export function databaseSourceId(proof: DatabaseMessageProof): string {
  return `db:${proof.accountDirectory}:${proof.conversationUsername ?? proof.ownerUsername}:${proof.shard}:${proof.localId}`;
}
export function desktopReplyContext(original:string,acceptedIds:string[]=[]) {
  const originalSeq=/^desktop:(\d+)$/.exec(original);
  if(!originalSeq)return original;
  const consumed=acceptedIds.map(id=>/^in:(\d+)$/.exec(id)).filter(Boolean).map(m=>Number(m![1]));
  return 'desktop:'+Math.max(Number(originalSeq[1]),...consumed);
}
export function outgoingTextMatches(actual: string, expected: string, mentionName?: string|string[]): boolean {
  if (mentionName !== undefined) {
    actual = actual.replace(/^\u2005/, '');
    const names=Array.isArray(mentionName)?mentionName:[mentionName];
    // WeChat strips the trailing separator from a standalone native mention.
    // Identity is checked separately against msgsource.atuserlist.
    return names.some(name=>{
      const prefix='@'+name;
      if(!actual.startsWith(prefix))return false;
      const rest=actual.slice(prefix.length);
      if(expected==='')return /^[\u2005 \t]*$/.test(rest);
      return ['\u2005',' ','\t'].includes(rest[0]) && rest.slice(1).replace(/\r\n/g,'\n')===expected.replace(/\r\n/g,'\n');
    });
  }
  return actual.replace(/\r\n/g, '\n') === expected.replace(/\r\n/g, '\n');
}
export function validateDatabaseProof(config: DesktopConfig, proof: DatabaseMessageProof, direction: 'in'|'out', peerId=config.ownerPeerId) {
  const binding = config.database;
  const contact=config.contacts.find(c=>c.peerId===peerId);
  const target=contact?.username??binding?.ownerUsername;
  const sender=contact?.actorUsername??target;
  if (!binding || !proof || Object.entries(binding).some(([key,value]) => proof[key as keyof DatabaseMessageProof] !== value)
    || !contact || (proof.conversationUsername??binding.ownerUsername)!==target
    || (direction==='in' && contact.kind==='group' && contact.members
      ? ![binding.selfUsername,...contact.members.map(m=>m.username)].includes(proof.senderUsername)
      : proof.senderUsername !== (direction === 'in' ? sender : binding.selfUsername))
    || typeof proof.shard !== 'string' || !/^message\/message_[A-Za-z0-9_-]+\.db$/.test(proof.shard)
    || !Number.isSafeInteger(proof.localId) || proof.localId <= 0
    || typeof proof.serverId !== 'string' || !/^\d+$/.test(proof.serverId) || !/[1-9]/.test(proof.serverId)
    || !Number.isSafeInteger(proof.createdAt) || proof.createdAt <= 0
    || !Number.isSafeInteger(proof.messageType) || typeof proof.text !== 'string') {
    throw new Error('Database proof does not match the bound account, owner or message');
  }
  return proof;
}
