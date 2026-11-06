import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRoomStore,ROOM_STANDBY_MS,ROOM_ACTIVE_MS,type RoomEvent} from '../src/desktop/room-context.js';
import {expressionHints} from '../src/wechat/expression.js';
import {createMemoryStore} from '../src/memory.js';
import {createRelationshipStore} from '../src/relationship.js';
test('textual @ keeps active speakers in the conversation without waking unrelated speakers',t=>{
 const dir=mkdtempSync(join(tmpdir(),'room-text-at-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const rooms=createRoomStore(dir),now=1000000;
 const event=(id:string,text:string,actorId='a'):RoomEvent=>({id,roomId:'r@chatroom',roomName:'群',actorId,actorName:actorId,self:false,at:now,text,kind:'text',mentions:[]});
 assert.equal(rooms.consider(event('start','你好'),true,now),'direct');
 const restored=createRoomStore(dir);
 for(const [i,text] of ['邮箱是 hello@example.com','@_@ 看晕了','@阮阮\u2005你看下今天晚上鱼情怎么样','复制的 @小J 只是正文'].entries()) {
  const at=now+(i+1)*60_000;
  assert.equal(restored.consider(event('other-'+i,text,'b'),false,at),undefined);
  assert.equal(restored.consider(event('text-'+i,text),false,at),'ambient',text);
 }
 assert.equal(restored.consider(event('followup','再补充一句'),false,now+5*60_000),'ambient');
 assert.equal(restored.consider(event('expired','hello@example.com'),false,now+5*60_000+ROOM_ACTIVE_MS),undefined);
});
test('native mentions preserve active speakers and recipient context for model participation decisions',t=>{
 const dir=mkdtempSync(join(tmpdir(),'room-addressee-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const rooms=createRoomStore(dir),now=1000000;
 const event=(id:string,actorId='a'):RoomEvent=>({id,roomId:'r@chatroom',roomName:'群',actorId,actorName:actorId,self:false,at:now,text:'一条消息',kind:'text'});
 rooms.consider(event('a-to-ruanruan'),true,now);
 rooms.consider(event('b-to-ruanruan','b'),true,now+1);
 const redirected={...event('a-to-b'),mentions:['b'],text:'@B 找到没'};
 rooms.record(redirected);
 assert.equal(rooms.consider(redirected,false,now+2),'ambient');
 const restored=createRoomStore(dir);
 assert.equal(restored.consider({...event('a-followup'),text:'多的一块拼图 你截图那个是多出来的'},false,now+3),'ambient');
 assert.equal(restored.consider({...event('b-answer','b'),text:'这个么'},false,now+4),'ambient');
 restored.record({...event('late-reply','self'),self:true,at:now+5,text:'上一轮的回复'});
 assert.equal(restored.consider(event('still-to-b'),false,now+6),'ambient');
 assert.deepEqual(restored.snapshot('r@chatroom').messages[0].mentions,['b']);
 assert.equal(restored.consider(event('back-to-ruanruan'),true,now+7),'direct');
 assert.equal(restored.consider(event('continue-again'),false,now+8),'ambient');
});
test('quoting oneself or another speaker keeps an active question available to the model',t=>{
 const dir=mkdtempSync(join(tmpdir(),'room-quote-target-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const rooms=createRoomStore(dir),now=1000000;
 const event:RoomEvent={id:'at',roomId:'r@chatroom',roomName:'群',actorId:'a',actorName:'A',self:false,at:now,text:'@阮阮',kind:'text'};
 rooms.consider(event,true,now);
 assert.equal(rooms.consider({...event,id:'quote-self',text:'我补充一下',replyTo:{actorId:'a',text:'我的前一句'}},false,now+1),'ambient');
 assert.equal(rooms.consider({...event,id:'quote-b',text:'他说的这个是什么意思',replyTo:{actorId:'b',text:'有'}},false,now+2),'ambient');
 assert.equal(rooms.consider({...event,id:'followup',text:'你帮我解释一下'},false,now+3),'ambient');
});
test('asking Ruanruan to add a mentioned member reaches the model without activating that member',t=>{
 const dir=mkdtempSync(join(tmpdir(),'room-mentioned-subject-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const rooms=createRoomStore(dir),now=1000000;
 const event:RoomEvent={id:'start',roomId:'r@chatroom',roomName:'群',actorId:'a',actorName:'测试哥',self:false,at:now,text:'你好',kind:'text'};
 rooms.consider(event,true,now);
 const request={...event,id:'add-friend',at:now+1000,text:'你加 @小J 他好友，他有事找你',mentions:['b']};
 rooms.record(request);
 assert.equal(rooms.consider(request,false,now+1000),'ambient');
 assert.deepEqual(rooms.snapshot('r@chatroom').messages[0].mentions,['b']);
 assert.equal(rooms.consider({...event,id:'b-follows',actorId:'b',text:'推荐用什么样的鱼漂'},false,now+2000),undefined);
 assert.equal(rooms.consider({...event,id:'a-follows',text:'加上了吗'},false,now+3000),'ambient');
});
test('standby checks only accumulated messages every thirty minutes and persists across restarts',t=>{
 const dir=mkdtempSync(join(tmpdir(),'room-standby-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const rooms=createRoomStore(dir),now=1000000;
 const event=(id:string,at:number):RoomEvent=>({id,roomId:'r@chatroom',roomName:'群',actorId:'a',actorName:'A',self:false,at,text:'聊两句',kind:'text'});
 const first=event('first',now),last=event('last',now+1000);
 rooms.record(first);rooms.record(last);
 assert.equal(rooms.consider(first,false,now),undefined);
 assert.equal(rooms.consider(last,false,now+1000),undefined);
 assert.deepEqual(rooms.due(now+ROOM_STANDBY_MS-1),[]);
 const restarted=createRoomStore(dir);
 assert.deepEqual(restarted.due(now+ROOM_STANDBY_MS),[{roomId:'r@chatroom',eventId:'last'}]);
 assert.equal(restarted.consider(last,false,now+ROOM_STANDBY_MS,true),'ambient');
 assert.equal(restarted.consider(last,false,now+ROOM_STANDBY_MS+1,true),undefined);
 assert.deepEqual(restarted.due(now+2*ROOM_STANDBY_MS),[],'No new records means no model call');
});
test('mentions open a five minute active conversation; unrelated members do not keep it awake',t=>{
 const dir=mkdtempSync(join(tmpdir(),'room-active-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const rooms=createRoomStore(dir),now=1000000;
 const event=(id:string,actorId='a'):RoomEvent=>({id,roomId:'r@chatroom',roomName:'群',actorId,actorName:actorId,self:false,at:now,text:'接着聊',kind:'text'});
 assert.equal(rooms.consider(event('at'),true,now),'direct');
 assert.equal(rooms.consider(event('continue'),false,now+60000),'ambient');
 assert.equal(rooms.consider(event('stranger','b'),false,now+60000+ROOM_ACTIVE_MS-1),undefined);
 assert.equal(rooms.consider(event('expired'),false,now+60000+ROOM_ACTIVE_MS),undefined);
 assert.equal(rooms.consider(event('quoted-self'),true,now+60000+ROOM_ACTIVE_MS+1),'direct');
 assert.equal(rooms.consider({...event('talk-to-other'),replyTo:{actorId:'b',text:'其他话题'}},false,now+60000+ROOM_ACTIVE_MS+2),'ambient');
});
test('late reference media enriches the same event and refreshes already supplied context',t=>{
 const dir=mkdtempSync(join(tmpdir(),'room-reference-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const rooms=createRoomStore(dir),event:RoomEvent={id:'quote',roomId:'r@chatroom',roomName:'群',actorId:'a',actorName:'A',self:false,at:1,text:'看看这里',kind:'text',
   replyTo:{serverId:'123',sourceId:'original',kind:'image',text:'[图片]',media:{kind:'image',key:'a'.repeat(64),status:'pending'}}};
 rooms.record(event);rooms.markSeen('thread',['quote']);
 assert.equal(rooms.unseen(rooms.snapshot('r@chatroom'),'thread').messages.length,0);
 rooms.record({...event,replyTo:{...event.replyTo,media:{kind:'image',key:'b'.repeat(64),localPath:'/actual.png',status:'available'}}});
 const delta=rooms.unseen(rooms.snapshot('r@chatroom'),'thread');
 assert.equal(rooms.recent('r@chatroom').length,1);assert.equal(delta.messages[0].replyTo?.media?.id,'original');
 assert.equal(delta.messages[0].replyTo?.media?.available,true);
});
test('public room context includes all speakers and native emoji, but not another room',t=>{
 const dir=mkdtempSync(join(tmpdir(),'room-context-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const rooms=createRoomStore(dir),now=Date.now();
 const event=(id:string,actor:string,text:string):RoomEvent=>({id,roomId:'r@chatroom',roomName:'群',actorId:actor,actorName:actor,self:false,at:now,text,kind:'text'});
 rooms.record(event('one','Alice','进群爆照[旺柴]'));rooms.record(event('two','Bob','就是啊'));
 rooms.record({...event('private-room','Alice','OTHER_ROOM_SECRET'),roomId:'other@chatroom'});
 assert.equal(rooms.recent('r@chatroom').length,2);
 const snap=JSON.stringify(rooms.snapshot('r@chatroom',{actorId:'Bob',actorName:'Bob'}));
 assert.match(snap,/Alice/);assert.match(snap,/Bob/);assert.match(snap,/调侃/);assert.doesNotMatch(snap,/OTHER_ROOM_SECRET/);
 assert.equal(rooms.consider({...event('old','A','hi'),baseline:true},true),undefined);
 assert.equal(rooms.consider({...event('delayed-ambient','A','hi'),at:now-180_000},false,now),undefined);
 assert.equal(rooms.consider({...event('delayed-direct','A','@阮阮'),at:now-180_000},true,now),'direct');
 assert.equal(rooms.consider(event('ambient','A','好香啊'),false,now+60_000),'ambient');
 assert.equal(rooms.consider(event('again','B','再说一句'),false,now+60_100),undefined);
 assert.equal(rooms.consider(event('direct','B','@阮阮'),true,now+60_101),'direct');
 assert.deepEqual(expressionHints('[这是引用]'),[]);
});
test('one person shares affinity across scenes without publishing private evidence or another person state',t=>{
 const dir=mkdtempSync(join(tmpdir(),'room-identity-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const person={accountId:'desktop-test',actorId:'Alice',audience:'private'};
 const privateMemory=createMemoryStore('private-alice',dir,person);
 privateMemory.socialObserve('private-peer','in:one','谢谢你记得',{intent:'chat',effect:'important',mode:'reply',userQuote:'谢谢你记得'},Date.now(),'嗯');
 const group=createMemoryStore('public-room',dir,{...person,audience:'r@chatroom'});
 const bob=createMemoryStore('public-room',dir,{...person,actorId:'Bob',audience:'r@chatroom'});
 assert.equal(group.socialSnapshot('room').relationship!.affection,privateMemory.socialSnapshot('private-peer').relationship!.affection);
 assert.equal(bob.socialSnapshot('room').relationship!.affection,0);
 const evidence={id:'one',at:Date.now(),day:'2026-11-04',axis:'trust' as const,topic:'private',effect:'supported' as const,meaning:'PRIVATE_SECRET',messageId:'in:1',evidence:'PRIVATE_SECRET',responseId:'out:1',responseEvidence:'嗯',audience:'private'};
 createRelationshipStore(join(dir,'evidence'),'private').commit([evidence]);
 assert.doesNotMatch(JSON.stringify(createRelationshipStore(join(dir,'evidence'),'r@chatroom').snapshot()),/PRIVATE_SECRET/);
 assert.match(JSON.stringify(createRelationshipStore(join(dir,'evidence'),'private').snapshot()),/PRIVATE_SECRET/);
});
test('bounded group windows resume incrementally and older public context remains retrievable',t=>{
 const dir=mkdtempSync(join(tmpdir(),'room-loading-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const rooms=createRoomStore(dir);
 for(let i=0;i<30;i++)rooms.record({id:'m'+i,roomId:'r@chatroom',roomName:'群',actorId:i%2?'Alice':'Bob',actorName:'同名',self:false,at:1000+i,
   text:i===3?'杯子是灰蓝色的，准备送给小林。':'其他闲聊'+i,kind:'text'});
 rooms.record({id:'private',roomId:'other@chatroom',roomName:'别的群',actorId:'Alice',actorName:'同名',self:false,at:1031,text:'杯子 PRIVATE_SECRET',kind:'text'});
 const initial=rooms.snapshot('r@chatroom');assert.equal(initial.messages.length,12);assert.equal(initial.hasEarlier,true);
 rooms.markSeen('thread-a',initial.messages.map(m=>m.id));assert.equal(rooms.unseen(initial,'thread-a').messages.length,0);
 assert.equal(rooms.unseen(initial,'thread-b').messages.length,12);
 rooms.record({id:'new',roomId:'r@chatroom',roomName:'群',actorId:'Alice',actorName:'同名',self:false,at:1040,text:'新消息',kind:'text'});
 assert.deepEqual(rooms.unseen(rooms.snapshot('r@chatroom'),'thread-a').messages.map(m=>m.id),['new']);
 const prior=rooms.history('r@chatroom','',initial.messages[0].id);
 assert.equal(prior.messages.at(-1)?.id,'m17');assert.equal(prior.messages.length,12);
 const recall=rooms.history('r@chatroom','杯子');assert.match(JSON.stringify(recall),/灰蓝色/);assert.doesNotMatch(JSON.stringify(recall),/PRIVATE_SECRET/);
 assert.equal(new Set(recall.messages.map(m=>m.speakerId)).size,2);
 assert.equal(rooms.history('r@chatroom','','private').messages.length,0);
});
