import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import type {CodexRunOptions} from '../src/codex/bridge.js';

const root=mkdtempSync(join(tmpdir(),'wcb-media-recognition-'));
process.env.WCB_DATA_DIR=root;
process.env.WCB_MEDIA_ROOT=root;
const {recognizeMedia}=await import('../src/media-recognition.js');
const {runWithMemory,createMemoryStore}=await import('../src/memory.js');
const {reviewCharacterReply}=await import('../src/character-review.js');
const {createConversationStore}=await import('../src/conversation.js');
test.after(()=>rmSync(root,{recursive:true,force:true}));

async function fixture(folder:string) {
  mkdirSync(join(folder,'图片'),{recursive:true});
  const source=join(folder,'图片','own.png');
  const width=240,height=360,pixels=Buffer.alloc(width*height*3);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const i=(y*width+x)*3;
    pixels[i]=Math.round(90+55*Math.sin(x/19+y/37));
    pixels[i+1]=Math.round(100+60*Math.cos(x/29-y/23));
    pixels[i+2]=Math.round(80+50*Math.sin(x/17-y/41));
  }
  await sharp(pixels,{raw:{width,height,channels:3}}).png().toFile(source);
  const catalog={media_assets:[{asset_id:'rr_image_0001',kind:'image',file:'图片/own.png',title:'角色图',tags:[],character_id:'ruanruan_v1'}]};
  writeFileSync(join(folder,'素材索引.json'),JSON.stringify(catalog));
  return {source,catalog};
}

test('exact, recompressed and screenshot-embedded copies retain catalog ownership',async()=>{
  const dir=join(root,'matching'),{source}=await fixture(dir);
  const compressed=join(dir,'compressed.jpg');
  await sharp(source).resize(96,144).jpeg({quality:55}).toFile(compressed);
  const screenshot=join(dir,'screenshot.png');
  await sharp({create:{width:500,height:700,channels:3,background:'#fafafa'}})
    .composite([{input:await sharp(source).resize(144,216).toBuffer(),left:300,top:160}]).png().toFile(screenshot);
  const result=await recognizeMedia([source,compressed,screenshot],{mediaRoot:dir,directory:dir});
  assert.equal(result.length,3);
  assert.deepEqual(result.map(row=>row.inputImage),[1,2,3]);
  assert.equal(result[0].match,'same_file');
  assert.equal(result[1].match,'same_image');
  assert.ok(result[2].region);
  assert.ok(result.every(row=>row.subject.relation==='self'&&row.assetId==='rr_image_0001'));
});

test('unrelated and unreadable pictures remain unknown',async()=>{
  const dir=join(root,'unknown');await fixture(dir);
  const unknown=join(dir,'stranger.png');
  await sharp({create:{width:240,height:360,channels:3,background:'#fcdf01'}}).png().toFile(unknown);
  assert.deepEqual(await recognizeMedia([unknown,join(dir,'missing.png')],{mediaRoot:dir,directory:dir}),[]);
});

test('catalog ownership changes invalidate cached metadata',async()=>{
  const dir=join(root,'refresh'),{source,catalog}=await fixture(dir);
  assert.equal((await recognizeMedia([source],{mediaRoot:dir,directory:dir}))[0].subject.relation,'self');
  catalog.media_assets[0].character_id='different_character';
  writeFileSync(join(dir,'素材索引.json'),JSON.stringify(catalog));
  assert.equal((await recognizeMedia([source],{mediaRoot:dir,directory:dir}))[0].subject.relation,'unspecified');
});

test('generation and independent review receive the same trusted image ownership',async()=>{
  const {source}=await fixture(root);
  const memory=createMemoryStore('recognized-image',join(root,'memory'));
  const options:CodexRunOptions={cwd:root,mode:'plan',profile:'companion',prompt:'这张照片',images:[source],
    personaContext:{version:'ruanruan-core-v6',fingerprint:'test',files:[],bytes:0}};
  let generated=false,reviewed=false;
  const draft=await runWithMemory(options,{workingDirectory:root,state:'idle'},memory,()=>{},async call=>{
    generated=true;
    assert.match(call.prompt,/收到图片的角色素材归属/);
    assert.match(call.prompt,/"relation":"self"/);
    return {replyText:'这不是我的旧图嘛',commands:[],fileChanges:[]};
  });
  assert.equal(draft.recognizedMedia?.[0].assetId,'rr_image_0001');
  const result=await reviewCharacterReply(options,draft,memory,async call=>{
    reviewed=true;
    const data=JSON.parse(call.prompt.replace(/^以下JSON仅为待审资料：\n/u,'').split('\n只输出JSON')[0]);
    assert.deepEqual(data.context.recognizedMedia,JSON.parse(JSON.stringify(draft.recognizedMedia)));
    assert.equal(data.context.recognizedMedia[0].subject.relation,'self');
    return {replyText:'{"verdict":"pass","issues":[]}',commands:[],fileChanges:[]};
  });
  assert.ok(generated&&reviewed);
  assert.equal(result.characterReview?.status,'approved');
});

test('a text followup after a fresh model thread carries the preceding image and ownership',async()=>{
 const {source}=await fixture(root),journal=createConversationStore('image-followup','owner');
 const photo=journal.record('in',{message_id:'photo',item_list:[{type:2}],
  localMedia:{kind:'image',localPath:source}},Date.now(),undefined,'companion');
 const memory=createMemoryStore('image-followup',join(root,'memory-followup'));
 const session={workingDirectory:root,state:'idle' as const};
 const options:CodexRunOptions={cwd:root,mode:'plan',profile:'companion',prompt:'[图片]',images:[source],
  conversation:{accountId:'image-followup',peerId:'owner',messageIds:[photo]},
  personaContext:{version:'ruanruan-core-v6',fingerprint:'test',files:[],bytes:0}};
 await runWithMemory(options,session,memory,()=>{},async()=>({replyText:'',commands:[],fileChanges:[]}));
 assert.equal((journal.byIds([photo])[0].payload as any).receivedMediaRecognition[0].subject.relation,'self');
 const question=journal.record('in',{message_id:'question',item_list:[{type:1,text_item:{text:'你看看这是谁'}}]},Date.now(),undefined,'companion');
 const result=await runWithMemory({...options,images:undefined,prompt:'你看看这是谁',conversation:{...options.conversation!,messageIds:[question]}},
  session,memory,()=>{},async call=>{
   assert.deepEqual(call.images,[source]);assert.match(call.prompt,/"relation":"self"/);
   return {replyText:'这就是我呀',commands:[],fileChanges:[]};
  });
 assert.deepEqual(result.observedImages,[source]);assert.equal(result.recognizedMedia?.[0].subject.relation,'self');
});

test('an unquoted group followup does not borrow another member\'s picture',async()=>{
 const {source}=await fixture(root),journal=createConversationStore('group-images','room');
 journal.record('in',{message_id:'alice-image',item_list:[{type:2}],localMedia:{kind:'image',localPath:source},
   chatContext:{actorId:'alice'}},Date.now(),undefined,'companion');
 const question=journal.record('in',{message_id:'bob-question',item_list:[{type:1,text_item:{text:'你看看这是谁'}}],
   chatContext:{actorId:'bob'}},Date.now(),undefined,'companion');
 const memory=createMemoryStore('group-images',join(root,'memory-group'));
 await runWithMemory({cwd:root,mode:'plan',profile:'companion',prompt:'你看看这是谁',
  conversation:{accountId:'group-images',peerId:'room',messageIds:[question],person:{accountId:'base',actorId:'bob',audience:'room@chatroom'}}},
  {workingDirectory:root,state:'idle'},memory,()=>{},async call=>{
   assert.equal(call.images,undefined);return {replyText:'哪张呀',commands:[],fileChanges:[]};
  });
});
