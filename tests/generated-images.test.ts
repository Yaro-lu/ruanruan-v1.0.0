import test from 'node:test';import assert from 'node:assert/strict';
import{mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync,statSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
import{createGeneratedImageQueue,prepareImageReferences,pendingImageContext,imageGenerationAvailable}from'../src/generated-images.js';
const config={enabled:true,model:'gpt-image-2.5-flare',size:'768x1024',quality:'low' as const,dailyLimit:2};
function fixture(t:any){const dir=mkdtempSync(join(tmpdir(),'image-queue-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return{dir,q:createGeneratedImageQueue(dir)};}
const task=(id:string)=>({id,accountId:'a',peerId:'p',modeRevision:1,inputSeq:3,at:Date.now(),proposal:{id:'r',query:'居家',scene:'穿针织开衫坐着',caption:'歇会儿。'}});
const asset={asset_id:'rr_image_123',kind:'image' as const,file:'图片/example.jpg',title:'测试',tags:['居家']};
test('generation runs once, enqueue is idempotent and daily budget is persisted',async t=>{
 const {q}=fixture(t);assert.equal(q.enqueue(task('1'),config),true);assert.equal(q.enqueue(task('1'),config),true);
 assert.equal(q.enqueue(task('2'),config),true);assert.equal(q.enqueue(task('3'),config),false);
 let calls=0,sends=0;const callbacks={canSend:()=>true,generate:async()=>{calls++;return{asset,elapsedMs:1};},deliver:async()=>{sends++;return true;}};
 await Promise.all([q.processOne(callbacks),q.processOne(callbacks)]);assert.equal(calls,1);assert.equal(sends,1);
 assert.equal(q.list().find(r=>r.id==='1')?.status,'sent');
});
test('a mode switch during generation suppresses late delivery',async t=>{
 const {q}=fixture(t);q.enqueue(task('1'),config);let current=true,sends=0;
 const result=await q.processOne({canSend:()=>current,generate:async()=>{current=false;return{asset,elapsedMs:1};},deliver:async()=>{sends++;return true;}});
 assert.equal(sends,0);assert.equal(result?.status,'cancelled');assert.ok(result?.asset,'completed image stays available for later library search');
});
test('a failed image does not retry charges or block a later text/task',async t=>{
 const {q}=fixture(t);q.enqueue(task('1'),config);let calls=0;
 const callbacks={canSend:()=>true,generate:async()=>{calls++;throw Error('Image API HTTP 403');},deliver:async()=>{throw Error('must not send');}};
 await q.processOne(callbacks);await q.processOne(callbacks);assert.equal(calls,1);assert.equal(q.list()[0].status,'failed');
});
test('ordinary new text waits for the turn while explicit cancellation prevents delivery',async t=>{
 const {dir,q}=fixture(t);q.enqueue(task('1'),config);let idle=false,calls=0,sends=0;
 const callbacks={canSend:()=>true,canDeliver:()=>idle,generate:async()=>{calls++;return{asset,elapsedMs:1};},deliver:async()=>{sends++;return true;}};
 assert.equal((await q.processOne(callbacks))?.status,'ready');
 assert.equal(calls,1);assert.equal(sends,0);
 assert.equal(pendingImageContext('a','p',dir)[0].status,'ready');assert.equal(pendingImageContext('a','other',dir).length,0);
 idle=true;assert.equal((await q.processOne(callbacks))?.status,'sent');assert.equal(calls,1);assert.equal(sends,1);
 q.enqueue(task('2'),config);
 assert.equal(imageGenerationAvailable(config,dir),false);
 const cancelled=await q.processOne({...callbacks,generate:async()=>{assert.equal(q.cancel('2','a','wrong-peer'),false);q.cancel('2','a','p');return{asset,elapsedMs:1};}});
 assert.equal(cancelled?.status,'cancelled');assert.equal(sends,1);
});
test('a cancelled transport does not claim the photograph was sent',async t=>{
 const {q}=fixture(t);q.enqueue(task('1'),config);
 const result=await q.processOne({canSend:()=>true,generate:async()=>({asset,elapsedMs:1}),deliver:async()=>false});
 assert.equal(result?.status,'cancelled');
});
test('reference preparation preserves originals, reuses cache and refreshes changed input',async t=>{
 const {dir}=fixture(t),sharp=(await import('sharp')).default;mkdirSync(join(dir,'基础设定'));
 const original=await sharp({create:{width:1600,height:1000,channels:3,background:'white'}}).png().toBuffer();
 const names=['三视图','ruanruan_expression_sheet_16grid'];
 for(const name of names)writeFileSync(join(dir,'基础设定',`${name}.png`),original);
 const [first]=await prepareImageReferences(dir),timestamp=statSync(first).mtimeMs;
 assert.equal((await sharp(first).metadata()).width,1280);
 await prepareImageReferences(dir);assert.equal(statSync(first).mtimeMs,timestamp);
 assert.deepEqual(readFileSync(join(dir,'基础设定','三视图.png')),original);
 writeFileSync(join(dir,'基础设定','三视图.png'),await sharp({create:{width:1600,height:1000,channels:3,background:'blue'}}).png().toBuffer());
 await prepareImageReferences(dir);assert.notEqual(statSync(first).mtimeMs,timestamp);
});
