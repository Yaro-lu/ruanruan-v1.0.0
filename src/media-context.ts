import type { ConversationMessage } from './conversation.js';

// Delivery order and the character's actual words are the scene's continuity.
// Catalog metadata supplies visible details; it is not an invented life story.
export function deliveredSceneContext(media: any[], messages: ConversationMessage[], currentIds: string[] = []) {
  messages = messages.filter(row => row.profile === 'companion');
  const reactions = media.filter(item => item.purpose === 'reaction');
  media = media.filter(item => item.purpose !== 'reaction');
  const current = messages.filter(row => currentIds.includes(row.id));
  const boundary = current.length ? Math.min(...current.map(row => row.seq)) : Infinity;
  const previousInput = [...messages].reverse().find(row => row.direction === 'in' && row.seq < boundary);
  const moments = media.map(item => {
    const inWindow = messages.some(row => row.id === item.id);
    const next = messages.find(row => row.seq > item.seq && row.direction === 'out' && (row.payload as any)?.local_media);
    const established = messages.filter(row => inWindow && row.direction === 'out'
      && row.seq > item.seq && (!next || row.seq < next.seq) && !(row.payload as any)?.local_media)
      .slice(0, 4).map(row => ({ messageId: row.id, at: row.at, text: row.text.slice(0, 400) }));
    return { ...item, established };
  });
  return { latestImageId: [...media].reverse().find(item => item.kind === 'image')?.asset_id,
    latestVideoId: [...media].reverse().find(item => item.kind === 'video')?.asset_id,
    latestReactionId: reactions.at(-1)?.asset_id,
    mediaSentSincePreviousInput: !!previousInput && media.some(item => item.seq > previousInput.seq && item.seq < boundary),
    moments, reactions };
}
