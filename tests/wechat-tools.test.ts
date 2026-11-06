import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWechatTools } from '../src/wechat-tools.js';
import { createMemoryStore } from '../src/memory.js';
import { createConversationStore } from '../src/conversation.js';
import { extractCatalogReply, catalogFile } from '../src/media-catalog.js';

test('scene selection and sourced recall survive replacing the runtime without a separate chat loop', async t => {
  const root = mkdtempSync(join(tmpdir(), 'wcb-tools-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '图片'));
  writeFileSync(join(root, '图片', 'cat.jpg'), 'synthetic');
  writeFileSync(join(root, '素材索引.json'), JSON.stringify({ media_assets: [
    { asset_id: 'rr_image_0001', kind: 'image', file: '图片/cat.jpg', title: '抱猫', tags: ['猫'], character_id: 'ruanruan_v1',
      description: '坐着抱猫', source: { video_file: '原始作者.mp4' }, has_watermark: true, sha256: 'catalog-hash',
      review: { by: 'reviewer' }, usage_notes: ['遗留的采集说明'], future_internal_field: '内部字段' }] }));
  const memory = createMemoryStore('bot', root);
  memory.save({ version: 1, recent: [], handoff: '服务器定时器排查进度：已查日志，尚未修改配置', notes: [{ id: 'fish', kind: 'fact', text: '周六钓鲫鱼，用玉米', updatedAt: new Date().toISOString() }] });
  const journal = createConversationStore('bot', 'owner', root);
  journal.record('out', { client_id: 'news', item_list: [{ type: 1, text_item: { text: '城市数字化标准体系文件发布' } }] }, Date.now(), undefined, 'companion');
  const host = createWechatTools('bot', 'owner', { directory: root, memoryRoot: root, mediaRoot: root });
  memory.record('之前讨论过咖啡店的选址', { replyText: '选在地铁旁边\n<<<WCB_MEMORY_V1>>>\n{"upsert":[],"remove":[]}', commands: [], fileChanges: [] });
  const legacy = await host.call('memory_recall', { query: '咖啡店' }) as any;
  assert.equal(legacy.history[0].delivery, 'legacy_not_verified');
  assert.match(legacy.history[0].assistant, /地铁/);
  const scene = await host.call('character_scene', { query: '抱猫' }) as any;
  assert.equal(scene.status, 'found');
  assert.equal(scene.candidates[0].file, undefined);
  assert.deepEqual(scene.candidates[0], { asset_id: 'rr_image_0001', kind: 'image', title: '抱猫', tags: ['猫'], description: '坐着抱猫',
    subject: { characterId: 'ruanruan_v1', name: '阮阮', relation: 'self' },
    provenance: { origin: 'user_provided_library', liveCapture: false, format: 'video_frame', hasWatermark: true } });
  assert.deepEqual(scene.provenance, { type: 'prepared_media', liveCapture: false });
  assert.doesNotMatch(JSON.stringify(scene), /原始作者|catalog-hash|reviewer|采集说明|内部字段/);
  const selected = extractCatalogReply('这张怎么样\n[[ASSET:rr_image_0001]]', host.candidates);
  assert.equal(selected.text, '这张怎么样');
  assert.equal(catalogFile(selected.asset!, root), join(root, '图片/cat.jpg'));
  assert.match(JSON.stringify(await host.call('memory_recall', { query: '钓鱼' })), /玉米/);
  assert.match(JSON.stringify(await host.call('memory_recall', { query: '城市数字化' })), /标准体系/);
  const handoff = await host.call('memory_recall', { query: '服务器定时器排查进度' }) as any;
  assert.match(handoff.handoff[0].text, /尚未修改配置/);
  assert.equal(handoff.handoff[0].source, 'saved_summary');
  await assert.rejects(host.call('character_scene', { query: '', kind: 'unknown' }));
  await assert.rejects(host.call('unknown', { query: '' }));
});
