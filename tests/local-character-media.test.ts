import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { loadCatalog, catalogFile, searchMedia, recordMediaSent } from '../src/media-catalog.js';
import { createWechatTools } from '../src/wechat-tools.js';
import { createMemeClient, memeFile } from '../src/memecub.js';
import { loadSceneReferences, searchSceneReferences } from '../src/scene-references.js';
import { generateCharacterImage, type ImageTask } from '../src/generated-images.js';
import { resolveCharacterMedia } from '../src/character-media.js';

const imageConfig = { enabled: true, model: 'gpt-image-2.5-flare', size: '768x1024', quality: 'low' as const, dailyLimit: 2 };
async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'local-character-media-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const folder of ['图片','卡通形象/表情','杂货店/竖版','基础设定','providers']) mkdirSync(join(root,folder), { recursive: true });
  const png = await sharp({ create: { width: 24, height: 24, channels: 3, background: 'white' } }).png().toBuffer();
  const jpg = await sharp(png).jpeg().toBuffer();
  writeFileSync(join(root,'图片/self.jpg'),jpg); writeFileSync(join(root,'卡通形象/表情/shy.png'),png);
  for (const name of ['三视图','ruanruan_expression_sheet_16grid']) writeFileSync(join(root,'基础设定',name+'.png'),png);
  const reaction = { asset_id: 'rr_image_9001', kind: 'image', file: '卡通形象/表情/shy.png', title: '阮阮Q版·害羞',
    tags: ['害羞','Q版','表情包'], purpose: 'reaction', character_id: 'ruanruan_v1' };
  const photo = { asset_id: 'rr_image_0001', kind: 'image', file: '图片/self.jpg', title: '普通生活照', tags: ['居家'], character_id: 'ruanruan_v1' };
  const references = ['morning','afternoon'].map(time => ({ reference_id: `rr_scene_grocery_checkout_${time}_portrait`, kind: 'scene_reference',
    file: `杂货店/竖版/checkout_${time}.jpg`, title: `杂货店收银台${time}`, description: '木色柜台与小黄鸭', area: 'checkout', time_of_day: time,
    orientation: 'portrait', location_aliases: ['杂货店','收银台'], tags: ['杂货店','收银台',time === 'morning' ? '早上' : '下午'] }));
  for (const ref of references) writeFileSync(join(root,ref.file),jpg);
  writeFileSync(join(root,'素材索引.json'),JSON.stringify({ media_assets: [photo,reaction], references }));
  writeFileSync(join(root,'providers/image-generation.json'),JSON.stringify(imageConfig));
  writeFileSync(join(root,'providers/openai-embeddings.json'),JSON.stringify({ apiKey: 'synthetic-test-key', baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small' }));
  return { root, png, jpg, reaction, references };
}

test('local Q reactions use the existing meme tool without provider requests and stay outside the ordinary photo search', async t => {
  const f = await fixture(t); t.mock.method(globalThis,'fetch',async () => { throw new Error('No live provider requests in this test'); });
  const host = createWechatTools('a','owner',{ directory: f.root, memoryRoot: f.root, mediaRoot: f.root });
  assert.ok(host.specs.some(spec => spec.name === 'meme_search'));
  const result = await host.call('meme_search',{ query: '害羞' }) as any;
  assert.equal(result.source,'local_character_reactions'); assert.equal(result.candidates[0].subject.relation,'expression');
  assert.equal(result.candidates[0].purpose,'reaction'); assert.equal(result.candidates[0].file,undefined);
  const local = host.candidates[0]; assert.equal(local.repeatAllowed,true);
  assert.equal(memeFile(local,f.root,f.root),catalogFile(local,f.root));
  const client = createMemeClient(f.root,{ mediaRoot: f.root });
  try { assert.deepEqual(readFileSync(await client.download(local,join(f.root,'delivery'))),f.png); }
  finally { await client.close(); }
  assert.equal(loadCatalog(f.root).length,2);
  assert.deepEqual(searchMedia('','a',{},f.root,f.root).candidates.map(a => a.asset_id),['rr_image_0001']);
  recordMediaSent('a','sent-sticker',local.asset_id,'害羞',f.root,f.root);
  assert.equal(searchMedia('害羞','a',{ purpose:'reaction',allowRepeat:true },f.root,f.root).candidates[0].asset_id,local.asset_id);
});

test('scene references match the store area and time, remain reference-only, and survive the proposal confirmation path', async t => {
  const f = await fixture(t), id = 'rr_scene_grocery_checkout_afternoon_portrait';
  assert.equal(loadSceneReferences(f.root).length,2);
  assert.equal(searchSceneReferences('下午在杂货店收银台',{ size:'768x1024' },f.root)[0].reference_id,id);
  assert.equal(searchSceneReferences('在家里看电视',{},f.root).length,0);
  assert.equal(searchMedia('杂货店','a',{},f.root,f.root).candidates.length,0);
  const host = createWechatTools('a','owner',{ directory:f.root,memoryRoot:f.root,mediaRoot:f.root });
  const found = await host.call('character_scene',{ query:'下午杂货店收银台',allowGeneration:true,
    scene:'下午站在杂货店收银台后，穿针织衫，歪头看镜头',caption:'等下给你看' }) as any;
  assert.equal(found.status,'generation_proposed'); assert.equal(found.sceneReference.referenceId,id);
  assert.equal(host.imageRequests[0].sceneReferenceId,id); assert.equal(host.candidates.length,0);
  const confirmed = resolveCharacterMedia({ replyText:'等下给你看看',imageRequests:host.imageRequests,characterUpdate:{ imageRequestId:found.requestId } });
  assert.equal(confirmed.generation?.sceneReferenceId,id);
  await assert.rejects(host.call('character_scene',{ query:'杂货店',sceneReferenceId:'rr_scene_missing' }),/不存在/);
});

test('mocked image requests attach the chosen store image after the two identity references, while home requests keep two references', async t => {
  const f = await fixture(t), requests: FormData[] = [];
  const fakeRequest = (async (_url, init) => {
    requests.push(init!.body as FormData);
    return new Response(JSON.stringify({ data:[{ b64_json:Buffer.concat([f.jpg,Buffer.alloc(1000)]).toString('base64') }] }),{ status:200 });
  }) as typeof fetch;
  const base = { accountId:'a',peerId:'owner',modeRevision:0,inputSeq:1,at:Date.now(),status:'generating' as const };
  const storeTask: ImageTask = { ...base,id:'shop-test',proposal:{ id:'proposal',query:'下午杂货店收银台',scene:'下午在杂货店收银台后理货',caption:'',
    sceneReferenceId:'rr_scene_grocery_checkout_afternoon_portrait' } };
  const output = await generateCharacterImage(storeTask,imageConfig,{ directory:f.root,mediaRoot:f.root,request:fakeRequest });
  const images = requests[0].getAll('image[]') as File[];
  assert.equal(images.length,3); assert.deepEqual(Buffer.from(await images[2].arrayBuffer()),f.jpg);
  assert.match(String(requests[0].get('prompt')),/actual spatial layout/);
  assert.equal(output.asset.scene_reference_id,storeTask.proposal.sceneReferenceId);
  assert.equal(searchMedia('杂货店','a',{ sceneReferenceId:storeTask.proposal.sceneReferenceId },f.root,f.root).candidates[0].asset_id,output.asset.asset_id);
  await generateCharacterImage({ ...base,id:'home-test',proposal:{ id:'home',query:'居家',scene:'在家坐在沙发上看书',caption:'' } },imageConfig,
    { directory:f.root,mediaRoot:f.root,request:fakeRequest });
  assert.equal(requests[1].getAll('image[]').length,2);
});

test('reference paths outside the store directory are not usable as composition inputs', async t => {
  const f = await fixture(t), outside = join(f.root,'outside.jpg'); writeFileSync(outside,f.jpg);
  const data = JSON.parse(readFileSync(join(f.root,'素材索引.json'),'utf8'));
  data.references[0].file='outside.jpg'; writeFileSync(join(f.root,'素材索引.json'),JSON.stringify(data));
  assert.equal(loadSceneReferences(f.root).length,1);
  assert.throws(() => searchSceneReferences('杂货店',{ referenceId:f.references[0].reference_id },f.root),/不存在/);
});

test('API reactions are reachable even when local Q reactions match',async t=>{
 const f=await fixture(t);
 writeFileSync(join(f.root,'providers/memecub.json'),JSON.stringify({enabled:true,apiKey:'mb_fixture'}));
 let requests=0;
 t.mock.method(globalThis,'fetch',async()=>{requests++;return new Response(JSON.stringify({data:[
   {id:'shy-cat',url:'https://memecub.com/cat.png',title:'害羞猫猫'}]}));});
 const host=createWechatTools('a','owner',{directory:f.root,mediaRoot:f.root,memoryRoot:f.root});
 const local=await host.call('meme_search',{query:'害羞'}) as any;
 assert.equal(local.source,'local_character_reactions');assert.equal(requests,0);
 const api=await host.call('meme_search',{query:'害羞',source:'api'}) as any;
 assert.equal(requests,1);assert.equal(api.candidates[0].provenance.origin,'memecub');
 assert.equal(resolveCharacterMedia({replyText:`[[ASSET:${api.candidates[0].asset_id}]]`,mediaCandidates:host.candidates}).mediaAction.kind,'asset');
});

test('video tool recommendation survives marker resolution as a video',async t=>{
 const f=await fixture(t);mkdirSync(join(f.root,'视频'));writeFileSync(join(f.root,'视频/cat.mp4'),'fixture');
 const index=JSON.parse(readFileSync(join(f.root,'素材索引.json'),'utf8'));
 index.media_assets.push({asset_id:'rr_video_0001',kind:'video',file:'视频/cat.mp4',title:'抱猫',tags:['抱猫'],character_id:'ruanruan_v1'});
 writeFileSync(join(f.root,'素材索引.json'),JSON.stringify(index));
 const host=createWechatTools('a','owner',{directory:f.root,mediaRoot:f.root,memoryRoot:f.root});
 const result=await host.call('character_scene',{query:'随机',kind:'video',selection:'random'}) as any;
 assert.equal(result.recommendedAssetId,'rr_video_0001');assert.equal(result.candidates[0].kind,'video');
 const media=resolveCharacterMedia({replyText:`[[ASSET:${result.recommendedAssetId}]]`,mediaCandidates:host.candidates});
 assert.equal(media.mediaAction.kind,'asset');
 assert.equal(host.candidates.find(x=>x.asset_id===result.recommendedAssetId)!.kind,'video');
});
