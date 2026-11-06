import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadCatalog, mediaForTurn, extractCatalogReply, recordMediaSent, catalogFile, searchMedia } from '../src/media-catalog.js';

test('catalog filters missing/reference/escaped files, selects by topic/type and limits replay per owner', () => {
  const root = mkdtempSync(join(tmpdir(), 'media-catalog-'));
  try {
    mkdirSync(join(root, '图片')); mkdirSync(join(root, '视频'));
    writeFileSync(join(root, '图片', 'cat.jpg'), 'image'); writeFileSync(join(root, '视频', 'kitchen.mp4'), 'video');
    writeFileSync(join(root, 'secret.jpg'), 'private'); symlinkSync(join(root, 'secret.jpg'), join(root, '图片', 'escape.jpg'));
    const image = { asset_id: 'rr_image_0001', kind: 'image', title: '抱猫', file: '图片/cat.jpg', tags: ['猫', '宠物'] };
    const video = { asset_id: 'rr_video_0001', kind: 'video', title: '厨房', file: '视频/kitchen.mp4', tags: ['厨房', '吃饭'] };
    writeFileSync(join(root, '素材索引.json'), JSON.stringify({ media_assets: [image, video,
      { ...image, asset_id: 'rr_image_0002', file: '图片/missing.jpg' },
      { ...image, asset_id: 'rr_image_0003', file: '图片/escape.jpg' }] }));
    assert.equal(loadCatalog(root).length, 2);
    assert.equal(catalogFile({ kind: 'image', file: 'secret.jpg' }, root), undefined);
    assert.equal(mediaForTurn('我饿了', 'owner', root, root)[0].asset_id, video.asset_id);
    assert.equal(mediaForTurn('给我发张图', 'owner', root, root)[0].asset_id, image.asset_id);
    assert.equal(mediaForTurn('想看你的照片', 'owner', root, root)[0].kind, 'image');
    assert.equal(mediaForTurn('发个视频', 'owner', root, root)[0].kind, 'video');
    assert.equal(mediaForTurn('想看猫的照片', 'owner', root, root)[0].kind, 'image');
    assert.equal(mediaForTurn('发厨房视频', 'owner', root, root)[0].kind, 'video');
    assert.equal(mediaForTurn('发厨房视频', 'owner', root, root).length, 1);
    assert.equal(mediaForTurn('发一段太空视频', 'owner', root, root).length, 0);
    assert.equal(mediaForTurn('检查服务器磁盘', 'owner', root, root).length, 0);
    assert.equal(mediaForTurn('不要发图片', 'owner', root, root).length, 0);
    assert.equal(mediaForTurn('画张猫的图片', 'owner', root, root).length, 0);
    const c = loadCatalog(root);
    const result = extractCatalogReply('给你看猫\n[[ASSET:rr_image_0001]]\n[[ASSET:rr_image_9999]]', c);
    assert.equal(result.asset?.asset_id, image.asset_id); assert.equal(result.text, '给你看猫');
    assert.equal(extractCatalogReply('[[ASSET:rr_image_9999]]', c).asset, undefined);
    assert.equal(extractCatalogReply('```\n[[ASSET:rr_image_0001]]\n```', c).asset, undefined);
    recordMediaSent('owner', 'job1', image.asset_id, '猫', root);
    assert.equal(mediaForTurn('猫', 'owner', root, root).length, 0);
    assert.equal(mediaForTurn('再来一张', 'owner', root, root)[0].kind, 'image');
    assert.ok(mediaForTurn('猫', 'other-owner', root, root).some(a => a.asset_id === image.asset_id));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('explicit media tool distinguishes no match from exhaustion and returns other unused pictures', t => {
  const root = mkdtempSync(join(tmpdir(), 'media-search-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '图片'));
  const assets = ['微笑', '散步', '喝饮料'].map((title, i) => {
    writeFileSync(join(root, '图片', `${i}.jpg`), 'image');
    return { asset_id: `rr_image_000${i}`, kind: 'image', title, tags: [title], file: `图片/${i}.jpg` };
  });
  writeFileSync(join(root, '素材索引.json'), JSON.stringify({ media_assets: assets }));
  recordMediaSent('owner', 'job1', assets[0].asset_id, '看看你', root);
  const other = searchMedia('', 'owner', { kind: 'image' }, root, root);
  assert.equal(other.status, 'found');
  assert.deepEqual(other.candidates.map(a => a.asset_id).sort(), assets.slice(1).map(a => a.asset_id).sort());
  assert.equal(searchMedia('微笑', 'owner', {}, root, root).status, 'all_sent');
  assert.equal(searchMedia('太空', 'owner', {}, root, root).status, 'no_match');
  assert.equal(searchMedia('', 'owner', { kind: 'video' }, root, root).status, 'empty');
  assert.equal(searchMedia('', 'other', {}, root, root).candidates.length, 3);
});

test('random requests vary recommendations, include videos, and keep the requested topic and delivery history',t=>{
 const root=mkdtempSync(join(tmpdir(),'media-random-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'图片'));mkdirSync(join(root,'视频'));
 const assets=Array.from({length:8},(_,i)=>{
   const kind=i===7?'video':'image',file=kind==='video'?`视频/${i}.mp4`:`图片/${i}.jpg`;
   writeFileSync(join(root,file),'fixture');
   return {asset_id:`rr_${kind}_000${i}`,kind,file,title:i===6?'厨房':'抱猫',tags:i===6?['厨房']:['抱猫']};
 });
 writeFileSync(join(root,'素材索引.json'),JSON.stringify({media_assets:assets}));
 const imageFirst=searchMedia('随便发一张照片或者视频','owner',{random:()=>0.1},root,root);
 const videoFirst=searchMedia('随机照片或者视频','owner',{random:()=>0.9},root,root);
 assert.equal(imageFirst.candidates[0].kind,'image');assert.equal(videoFirst.candidates[0].kind,'video');
 assert.ok(imageFirst.candidates.some(x=>x.kind==='video'));
 const themed=searchMedia('随机抱猫','owner',{selection:'random',random:()=>0.9},root,root);
 assert.ok(themed.candidates.every(x=>x.title==='抱猫'));
 assert.equal(searchMedia('随机太空','owner',{selection:'random'},root,root).status,'no_match');
 recordMediaSent('owner','sent',videoFirst.candidates[0].asset_id,'',root,root);
 assert.ok(searchMedia('随机','owner',{},root,root).candidates.every(x=>x.kind==='image'));
 let n=1;
 const reversed=searchMedia('', 'different',{kind:'image',random:()=>n-=0.1},root,root);
 assert.notEqual(reversed.candidates[0].asset_id,imageFirst.candidates[0].asset_id);
});
