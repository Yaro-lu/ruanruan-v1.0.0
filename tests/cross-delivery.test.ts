import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {DesktopConfig} from '../src/desktop/config.js';
import type {ChatContext,WechatSender,SendMediaOptions} from '../src/wechat/channel.js';
import type {CatalogCandidate} from '../src/media-catalog.js';

const root=mkdtempSync(join(tmpdir(),'cross-delivery-'));process.env.WCB_DATA_DIR=root;
const {createCrossDeliveryPlans,deliverCrossConversation}=await import('../src/cross-delivery.js');
const {syncDesktopIdentities}=await import('../src/desktop/identity.js');
const {createConversationStore}=await import('../src/conversation.js');
const {SendRejected}=await import('../src/wechat/receipt.js');
test.after(()=>rmSync(root,{recursive:true,force:true}));

function fixture(t:any) {
  const directory=mkdtempSync(join(root,'fixture-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const config:DesktopConfig={version:1,enabled:true,accountId:'desktop-delivery',ownerPeerId:'owner',multiUser:true,
    exchangeDirectory:join(directory,'exchange'),queueDirectory:join(directory,'bridge'),identityDirectory:directory,
    database:{accountDirectory:'self_1',selfUsername:'self',ownerUsername:'owner'},contacts:[
      {peerId:'owner',username:'owner',uiLabel:'测试哥',identityNote:'verified',kind:'private'},
      ...Array.from({length:4},(_,i)=>({peerId:'room-'+i,username:`${i}@chatroom`,uiLabel:'群'+i,identityNote:'verified',kind:'group' as const,rosterObservedAt:Date.now(),
        members:[{username:'owner',name:'测试哥'},{username:'friend',name:'小李'}]})),
    ]};
  const identities=syncDesktopIdentities(config);
  const context:ChatContext={kind:'private',conversationId:'owner',conversationName:'测试哥',actorId:'owner',actorName:'测试哥',
    person:identities.view({platform:'wechat',channelAccountId:config.accountId,actorId:'owner'})};
  const media=join(directory,'media');for(const folder of ['图片','视频','卡通形象'])mkdirSync(join(media,folder),{recursive:true});
  const candidates:CatalogCandidate[]=[{asset_id:'rr_image_1',kind:'image',file:'图片/one.jpg',title:'照片',tags:[],character_id:'ruanruan_v1'},
    {asset_id:'rr_image_2',kind:'image',file:'卡通形象/wave.png',title:'招手表情',tags:[],purpose:'reaction',repeatAllowed:true},
    {asset_id:'rr_video_3',kind:'video',file:'视频/three.mp4',title:'视频',tags:[]}];
  for(const asset of candidates)writeFileSync(join(media,asset.file),'offline synthetic asset');
  let current='帮我去群0找小李打个招呼，发张照片给他';
  const tools=createCrossDeliveryPlans(config,context,()=>current,candidates,{mediaRoot:media});
  const target=(query='群0',member?:string)=>(tools.call('conversation_target',{query,kind:'group',member}) as any).targetId as string;
  const stage=(text='你好',targetId=target('群0','小李'))=>tools.call('conversation_send',{
    operation:'stage',targetId,text,requestEvidence:current}) as any;
  const records:{kind:string;clientId?:string;peer:string;value:string;notify?:boolean}[]=[];
  const routes:{accountId:string;mention:unknown}[]=[];let failure:'rejected'|'uncertain'|undefined;
  const sender:WechatSender={sendText:async()=>{throw Error('unscoped send');},sendImage:async()=>{throw Error('unscoped send');},
    sendVideo:async()=>{throw Error('unscoped send');},inThread:async(_thread,action)=>action(),startTyping:()=>({stop:async()=>{}}),
    forConversation(accountId,mention){
      routes.push({accountId,mention});
      const send=async(kind:string,peer:string,value:string,clientId?:string,opts?:SendMediaOptions)=>{
        opts?.beforeSend?.();records.push({kind,peer,value,clientId,notify:opts?.notifyRecipient});
        if(kind==='text'&&failure) {
          const selected=failure;failure=undefined;
          throw selected==='rejected'?new SendRejected('offline rejected'):Error('offline uncertain');
        }
        createConversationStore(accountId,peer,directory).record('out',{client_id:clientId,
          item_list:[kind==='text'?{type:1,text_item:{text:value}}:{type:kind==='video'?5:2}]},Date.now(),undefined,'companion');
        return {messageIdPresent:true};
      };
      return {...sender,sendText:(peer,_token,text,client)=>send('text',peer,text,client),
        sendImage:(peer,_token,path,opts)=>send('image',peer,path,opts?.clientId,opts),
        sendVideo:(peer,_token,path,opts)=>send('video',peer,path,opts?.clientId,opts)};
    }};
  const options={sender,jobDirectory:join(directory,'job'),sourceJobId:'source-job',dataDirectory:directory,mediaRoot:media};
  return {directory,config,context,candidates,tools,target,stage,records,routes,options,
    setCurrent:(value:string)=>{current=value;},fail:(value:'rejected'|'uncertain')=>{failure=value;}};
}

test('target lookup stages nothing; genuine current request can replace and cancel one reviewed plan',t=>{
  const f=fixture(t),targetId=f.target('群0','小李');assert.equal(f.tools.plans.length,0);
  assert.throws(()=>f.tools.call('conversation_send',{operation:'stage',targetId:'invented',text:'你好',requestEvidence:'帮我去群0'}),/本轮唯一解析/);
  assert.throws(()=>f.tools.call('conversation_send',{operation:'stage',targetId,text:'你好',requestEvidence:'并不存在的请求'}),/真实原话/);
  const first=f.stage('你好',targetId);assert.equal(first.status,'staged_pending_review');assert.equal(first.delivered,false);
  const second=f.stage('来打个招呼',targetId);assert.equal(first.planId,second.planId);assert.equal(f.tools.plans.length,1);
  assert.equal(f.tools.plans[0].text,'来打个招呼');assert.deepEqual(f.records,[]);
  f.tools.call('conversation_send',{operation:'cancel',planId:first.planId});assert.equal(f.tools.plans.length,0);
});

test('intent is left to the normal review and conditional requests are not rejected by phrase rules',t=>{
  const f=fixture(t),target=f.target();
  for(const current of ['如果你愿意，去群0发张图','不要发表情，给群0发照片','群0今天在聊钓鱼']) {
    f.setCurrent(current);const result=f.stage('你好',target);
    assert.equal(result.status,'staged_pending_review');assert.equal(result.delivered,false);
    assert.equal(f.tools.plans[0].requestEvidence,current);
  }
  assert.deepEqual(f.records,[],'only main may deliver an approved plan');
  f.tools.call('conversation_send',{operation:'cancel',targetId:target});assert.equal(f.tools.plans.length,0);
});

test('only returned real media IDs are accepted and no filesystem path becomes a forwarded image',t=>{
  const f=fixture(t);
  assert.throws(()=>f.stage('[[ASSET:unknown]]'),/素材编号/);
  assert.throws(()=>f.stage('[[ASSET:rr_image_1]] [[ASSET:rr_image_2]]'),/素材编号/);
  assert.throws(()=>f.stage('![秘密](/home/test-user/secret.png)'),/本地路径/);
  assert.throws(()=>f.stage('/tmp/secret.png'),/本地路径/);
  const result=f.stage('看看这张 [[ASSET:rr_image_1]]');assert.equal(result.asset.asset_id,'rr_image_1');
  assert.equal(f.tools.plans[0].text,'看看这张');assert.equal(f.tools.plans[0].asset?.file,'图片/one.jpg');
  f.candidates.push({asset_id:'rr_image_9',kind:'image',file:'图片/missing.jpg',title:'missing',tags:[]});
  assert.throws(()=>f.stage('[[ASSET:rr_image_9]]'),/文件不存在/);
});

test('at most three distinct destinations and tokens belong to the target conversation',t=>{
  const f=fixture(t);mkdirSync(f.config.queueDirectory,{recursive:true});
  const db=new DatabaseSync(join(f.config.queueDirectory,'channel.sqlite3'));
  db.exec('CREATE TABLE incoming(seq INTEGER,account TEXT,peer TEXT)');
  db.prepare('INSERT INTO incoming VALUES(?,?,?)').run(7,f.config.accountId,'room-0');
  db.prepare('INSERT INTO incoming VALUES(?,?,?)').run(99,f.config.accountId,'owner');db.close();
  for(let i=0;i<3;i++){f.setCurrent(`帮我给群${i}发一句你好`);f.stage('你好',f.target('群'+i));}
  assert.equal(f.tools.plans[0].contextToken,'desktop:7');
  f.setCurrent('帮我给群3发一句你好');assert.throws(()=>f.stage('你好',f.target('群3')),/最多暂存3个/);
  assert.equal(f.tools.plans.length,3);
});

test('media precedes caption with native mention routing; retry never repeats the accepted image',async t=>{
  const f=fixture(t);f.stage('给你看看 [[ASSET:rr_image_1]]');const plan=f.tools.plans[0];
  f.fail('rejected');await assert.rejects(deliverCrossConversation(plan,f.options),/offline rejected/);
  assert.deepEqual(f.records.map(row=>row.kind),['image','text']);
  const result=await deliverCrossConversation(plan,f.options);assert.ok(result.parts.every(part=>part.status==='sent'));
  assert.deepEqual(f.records.map(row=>row.kind),['image','text','text']);
  assert.equal(f.records[0].notify,false,'following caption carries native @ after image');
  assert.equal(f.records[1].clientId,f.records[2].clientId,'retry reuses the same stable client ID');
  assert.deepEqual(f.routes[0],{accountId:plan.route.storageAccountId,mention:{username:'friend',name:'小李'}});
  const journal=createConversationStore(plan.route.storageAccountId,plan.route.peerId,f.directory).recent(20,'companion');
  assert.equal(journal.length,2);assert.match(JSON.stringify(journal),/rr_image_1/);
  await deliverCrossConversation(plan,f.options);assert.equal(f.records.length,3,'completed plan replay is a no-op');
});

test('uncertain text delivery is not retried and changed content cannot reuse its receipts',async t=>{
  const f=fixture(t);f.stage('你好');const plan=f.tools.plans[0];f.fail('uncertain');
  await assert.rejects(deliverCrossConversation(plan,f.options),/offline uncertain/);
  await assert.rejects(deliverCrossConversation(plan,f.options),/投递结果不确定/);
  assert.equal(f.records.length,1);
  await assert.rejects(deliverCrossConversation({...plan,text:'changed'},f.options),/已有回执/);
  assert.equal(f.records.length,1);
});

test('standalone local reaction and video use existing media transport and cancellation keeps unsent parts unsent',async t=>{
  const f=fixture(t);f.stage('[[ASSET:rr_image_2]]');
  await deliverCrossConversation(f.tools.plans[0],f.options);
  assert.equal(f.records[0].kind,'image');assert.equal(f.records[0].notify,true);
  f.tools.call('conversation_send',{operation:'cancel',planId:f.tools.plans[0].id});
  f.setCurrent('帮我去群1找小李发一段视频');f.stage('[[ASSET:rr_video_3]]',f.target('群1','小李'));
  await deliverCrossConversation(f.tools.plans[0],f.options);assert.equal(f.records.at(-1)!.kind,'video');
  f.setCurrent('帮我给群2发一句你好');f.stage('你好',f.target('群2'));
  const result=await deliverCrossConversation(f.tools.plans.at(-1)!,{...f.options,shouldContinue:()=>false});
  assert.equal(result.cancelled,true);assert.equal(f.records.length,2);
});
