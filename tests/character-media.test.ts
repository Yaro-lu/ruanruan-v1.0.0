import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCharacterMedia } from '../src/character-media.js';
import type { CatalogCandidate } from '../src/media-catalog.js';

const asset: CatalogCandidate = { asset_id: 'rr_image_0050', kind: 'image', file: '图片/test.jpg', title: '旧照',
  tags: ['居家'], character_id: 'ruanruan_v1' };
const proposal = { id: '8bf57626-7e57-45d6-a39d-31929761d6a0', query: '窗台', scene: '日常穿着给窗台植物浇水', caption: '看看这个。' };

test('selected media carries the same self and provenance facts to review and delivery', () => {
  const resolved = resolveCharacterMedia({ replyText: `给你看看这张。[[ASSET:${asset.asset_id}]]`, mediaCandidates: [asset] });
  assert.equal(resolved.text, '给你看看这张。'); assert.equal(resolved.asset, asset);
  assert.equal(resolved.mediaAction.kind, 'asset');
  if (resolved.mediaAction.kind === 'asset') {
    assert.equal(resolved.mediaAction.asset.subject.relation, 'self');
    assert.equal(resolved.mediaAction.asset.provenance.liveCapture, false);
    assert.equal(resolved.mediaAction.phase, 'selected_not_delivered');
  }
});

test('an unconfirmed or withdrawn proposal is not a generation action', () => {
  for (const update of [undefined, {}, { imageRequestId: 'another-id' }]) {
    const resolved = resolveCharacterMedia({ replyText: '这次先不发。', imageRequests: [proposal], characterUpdate: update });
    assert.deepEqual(resolved.mediaAction, { kind: 'none' }); assert.equal(resolved.generation, undefined);
  }
});

test('only an actually confirmed proposal becomes a background action, with the original scene and caption', () => {
  const resolved = resolveCharacterMedia({ replyText: '等会儿给你看看。', imageRequests: [proposal], characterUpdate: { imageRequestId: proposal.id } });
  assert.equal(resolved.generation, proposal);
  assert.deepEqual(resolved.mediaAction, { kind: 'generation', phase: 'confirmed_for_background', proposal });
});

test('an existing selected asset takes priority over a generation proposal as delivery already requires', () => {
  const resolved = resolveCharacterMedia({ replyText: `[[ASSET:${asset.asset_id}]]`, mediaCandidates: [asset],
    imageRequests: [proposal], characterUpdate: { imageRequestId: proposal.id } });
  assert.equal(resolved.asset, asset); assert.equal(resolved.generation, undefined); assert.equal(resolved.mediaAction.kind, 'asset');
});
