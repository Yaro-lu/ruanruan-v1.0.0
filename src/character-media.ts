import { describeMedia, extractCatalogReply, type CatalogCandidate } from './media-catalog.js';
import type { ImageProposal } from './generated-images.js';

export const CHARACTER_MEDIA_CONTRACT = 'mediaAction为程序计算的只读动作：asset表示选中素材，generation表示已确认的后台生成，none表示无动作；未确认提案不执行，是否送达以回执为准。';

interface MediaSource {
  replyText: string;
  mediaCandidates?: CatalogCandidate[];
  imageRequests?: ImageProposal[];
  characterUpdate?: { imageRequestId?: string };
}

// One interpretation for review, editing and delivery. A tool's proposal is
// not an action until the character actually selects/confirms it.
export function resolveCharacterMedia(source: MediaSource, additional: CatalogCandidate[] = []) {
  const selected = extractCatalogReply(source.replyText, [...additional, ...(source.mediaCandidates ?? [])]);
  const generation = selected.asset ? undefined : source.imageRequests?.find(item => item.id === source.characterUpdate?.imageRequestId);
  const mediaAction = selected.asset
    ? { kind: 'asset' as const, phase: 'selected_not_delivered' as const, asset: describeMedia(selected.asset) }
    : generation ? { kind: 'generation' as const, phase: 'confirmed_for_background' as const, proposal: generation }
      : { kind: 'none' as const };
  return { ...selected, generation, mediaAction };
}
