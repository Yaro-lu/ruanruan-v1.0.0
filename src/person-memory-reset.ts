import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './constants.js';

export interface PersonMemoryReset {
  personId: string; channelAccountId: string; actorId: string; roomId: string;
  storageAccountId: string; peerId: string; before: number; through: number;
  messageIds: string[]; roomEventIds: string[];
}
export function readPersonMemoryResets(directory = DATA_DIR): PersonMemoryReset[] {
  try { return JSON.parse(readFileSync(join(directory, 'person-memory-resets.json'), 'utf8')).resets ?? []; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
interface RoomMessage {
  id: string; at: number; actorId?: string; speakerId?: string; mentions?: string[];
  replyTo?: { actorId?: string; actorName?: string; sourceId?: string; text?: string };
}
// This is a model-context projection only; the immutable room archive remains
// available to the operator. New interactions are accepted after the reset.
export function filterRoomMessagesForMemoryReset<T extends RoomMessage>(roomId: string, rows: T[], directory = DATA_DIR): T[] {
  const resets = readPersonMemoryResets(directory).filter(reset => reset.roomId === roomId);
  if (!resets.length) return rows;
  return rows.flatMap(row => {
    if (resets.some(reset => row.at <= reset.before && (reset.roomEventIds.includes(row.id)
      || (row.actorId ?? row.speakerId) === reset.actorId || row.mentions?.includes(reset.actorId)
      || row.replyTo?.actorId === reset.actorId))) return [];
    if (row.replyTo?.sourceId && resets.some(reset => reset.roomEventIds.includes(row.replyTo!.sourceId!))) {
      return [{ ...row, replyTo: { actorId: row.replyTo.actorId, actorName: row.replyTo.actorName, text: '[旧引用已重置]' } }];
    }
    return [row];
  });
}
