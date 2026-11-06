import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createDesktopStore } from '../src/desktop/store.js';
import { databaseSourceId, outgoingTextMatches,desktopReplyContext, type DatabaseMessageProof } from '../src/desktop/database-proof.js';
import type { DesktopConfig } from '../src/desktop/config.js';
import { createRoomStore } from '../src/desktop/room-context.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
test('late media is recovered on the original occurrence without replay or cross-room access',t=>{
 const f=fixture(t);f.config.multiUser=true;
 f.config.contacts.push({peerId:'room',uiLabel:'群',identityNote:'fixture',kind:'group',username:'123@chatroom',members:[{username:'alice',name:'A'}]});
 const p={...f.proof('in'),conversationUsername:'123@chatroom',senderUsername:'alice',messageType:49,text:'<appmsg/>'};
 const id=databaseSourceId(p),reference='db:wxid_self_abcd:123@chatroom:message/message_0.db:100';
 const value={peerId:'room',uiLabel:'群',sourceMessageId:id,text:'看看这张',database:p,
   replyTo:{actorId:'alice',serverId:'12345',sourceId:reference,kind:'image',text:'[图片]',media:{kind:'image' as const,key:'a'.repeat(64),status:'pending' as const}}};
 // App-message titles are supplied separately from their raw database XML.
 const input={...value,database:{...p,displayText:value.text}};
 f.store.incoming(input);const received=f.store.takeIncoming()!;f.store.finishIncoming(received.seq);
 assert.equal(f.store.mediaInfo('other@chatroom',reference),undefined);
 f.store.requestMedia('123@chatroom',reference);assert.deepEqual(f.store.mediaRequests(),[id]);
 assert.equal(f.store.incoming({...input,contextOnly:true,replyTo:{...value.replyTo,media:{kind:'image',key:'b'.repeat(64),status:'available',localPath:f.screen}}}).duplicate,true);
 assert.equal(f.store.takeIncoming(),undefined);
 assert.equal(f.store.storedIncoming(id)?.replyTo?.media?.status,'available');
 assert.equal(f.store.mediaInfo('123@chatroom',reference)?.media?.localPath,f.screen);
 assert.equal(createRoomStore(f.config.queueDirectory).recent('123@chatroom').length,1);
 f.store.finishMediaRequest(id);assert.deepEqual(f.store.mediaRequests(),[]);
});
function fixture(t: TestContext) {
  const root=mkdtempSync(join(tmpdir(),'wechat-database-contract-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const config:DesktopConfig={version:1,enabled:true,accountId:'desktop-test',ownerPeerId:'owner',
    contacts:[{peerId:'owner',uiLabel:'管理者',identityNote:'synthetic verified contact'}],
    exchangeDirectory:join(root,'exchange'),queueDirectory:join(root,'queue'),
    database:{accountDirectory:'wxid_self_abcd',selfUsername:'wxid_self',ownerUsername:'wxid_owner'}};
  mkdirSync(config.exchangeDirectory);const screen=join(config.exchangeDirectory,'screen.png');writeFileSync(screen,png);
  let at=1700000000000;
  const store=createDesktopStore(config,()=>at);
  const proof=(direction:'in'|'out',localId=1,text='你好'):DatabaseMessageProof=>({
    ...config.database!,senderUsername:direction==='in'?'wxid_owner':'wxid_self',
    shard:'message/message_0.db',localId,serverId:String(1000+localId),createdAt:at,messageType:1,text});
  const incoming=(p:DatabaseMessageProof)=>store.incoming({peerId:'owner',uiLabel:'管理者',
    sourceMessageId:databaseSourceId(p),text:p.text,database:p});
  return {config,store,proof,incoming,screen,advance:()=>{at+=2000;}};
}

test('database input preserves timestamps and identical occurrences without requiring screenshot recognition',t=>{
  const f=fixture(t),a=f.proof('in'),b=f.proof('in',2);
  assert.equal(f.incoming(a).duplicate,false);assert.equal(f.incoming(a).duplicate,true);
  assert.equal(f.incoming(b).duplicate,false);
  const first=f.store.takeIncoming()!,second=f.store.takeIncoming()!;
  assert.notEqual(first.seq,second.seq);assert.equal(first.message.create_time_ms,a.createdAt);
  assert.equal(f.store.takeIncoming(),undefined);
});

test('native payment metadata survives ingress and enrichment without replaying a previously processed card',t=>{
  const f=fixture(t);
  const old={...f.proof('in'),messageType:49,text:'<msg><appmsg><type>2001</type><wcpayinfo/></appmsg></msg>',displayText:'微信红包'};
  const input={peerId:'owner',uiLabel:'管理者',sourceMessageId:databaseSourceId(old),text:old.displayText,database:old};
  f.store.incoming(input);const first=f.store.takeIncoming()!;f.store.finishIncoming(first.seq);
  const payment={kind:'red_packet' as const,receipt:'unconfirmed' as const,amountText:null,description:'恭喜发财'};
  const displayText='[微信红包消息] 祝福语："恭喜发财"（领取结果未确认，金额未知）';
  assert.equal(f.store.incoming({...input,text:displayText,database:{...old,payment,displayText}}).duplicate,true);
  assert.equal(f.store.takeIncoming(),undefined);
  const next={...old,localId:2,serverId:'1002',payment,displayText};
  f.store.incoming({...input,sourceMessageId:databaseSourceId(next),text:displayText,database:next});
  const received=f.store.takeIncoming()!.message;
  assert.deepEqual(received.desktopPayment,payment);
  assert.equal(received.item_list?.[0].text_item?.text,displayText);
});

test('database input rejects another account, sender, shard, forged occurrence or changed content',t=>{
  const f=fixture(t),p=f.proof('in');
  for(const wrong of [{...p,ownerUsername:'someone_else'},{...p,senderUsername:'wxid_self'},
    {...p,shard:'../message_0.db'},{...p,serverId:'0'}]) assert.throws(()=>f.incoming(wrong),/Database proof/);
  assert.throws(()=>f.store.incoming({peerId:'owner',uiLabel:'管理者',sourceMessageId:'arbitrary',text:p.text,database:p}),/content/);
  assert.throws(()=>f.store.incoming({peerId:'owner',uiLabel:'管理者',sourceMessageId:databaseSourceId(p),text:'伪造正文',database:p}),/content/);
  assert.equal(f.store.takeIncoming(),undefined);
});

test('database delivery needs a new matching server-confirmed row and cannot reuse it for identical replies',t=>{
  const f=fixture(t),task=f.store.enqueue({peerId:'owner',clientId:'one',kind:'text',text:'你好',context:'',profile:'control'});
  const active=f.store.claimDelivery()!;f.store.authorizeDelivery(task.id);
  const receipt={id:task.id,leaseId:active.leaseId!,status:'sent' as const,uiLabel:'管理者'};
  assert.throws(()=>f.store.receipt(receipt),/requires a verified/);
  assert.throws(()=>f.store.receipt({...receipt,database:f.proof('out',1,'别的内容')}),/content/);
  assert.throws(()=>f.store.receipt({...receipt,database:{...f.proof('out'),createdAt:1}}),/old/);
  f.store.receipt({...receipt,database:f.proof('out')});
  assert.equal(f.store.getDelivery(task.id).evidence!.database!.serverId,'1001');
  assert.equal(f.store.getDelivery(task.id).evidence!.screenshotPath,undefined);
  assert.equal(existsSync(join(f.config.queueDirectory,'evidence')),false,'database success must not archive a screenshot');
  f.store.assertUiAccess();
  f.advance();
  const next=f.store.enqueue({peerId:'owner',clientId:'two',kind:'text',text:'你好',context:'',profile:'control'});
  const claim=f.store.claimDelivery()!;f.store.authorizeDelivery(next.id);
  assert.throws(()=>f.store.receipt({...receipt,id:next.id,leaseId:claim.leaseId!,database:f.proof('out')}),/already acknowledged/);
  assert.equal(f.store.getDelivery(next.id).status,'ready');
});

test('database media receipts require the actual file hash without a screenshot or visual flag',t=>{
  const f=fixture(t);
  const task=f.store.enqueue({peerId:'owner',clientId:'photo',kind:'image',file:f.screen,context:'',profile:'control'});
  const active=f.store.claimDelivery()!;f.store.authorizeDelivery(task.id);
  const receipt={id:task.id,leaseId:active.leaseId!,status:'sent' as const,uiLabel:'管理者'};
  const proof={...f.proof('out'),messageType:3,text:'[图片]',fileMd5:createHash('md5').update(png).digest('hex')};
  assert.throws(()=>f.store.receipt({...receipt,database:{...proof,fileMd5:'0'.repeat(32)}}),/content/);
  const sent=f.store.receipt({...receipt,database:proof,screenshotPath:join(f.config.exchangeDirectory,'not-captured.png')});
  assert.equal(sent.status,'sent');
  assert.equal(sent.evidence!.screenshotPath,undefined);
  assert.equal(existsSync(join(f.config.queueDirectory,'evidence')),false);
});


test('group observations include unmentioned messages and preserve actor identity',t=>{
  const f=fixture(t);f.config.multiUser=true;
  f.config.contacts.push({peerId:'room',uiLabel:'群',identityNote:'synthetic public room',kind:'group',username:'123@chatroom',members:[{username:'wxid_alice',name:'Alice'},{username:'wxid_bob',name:'Bob'}]});
  const p={...f.proof('in'),conversationUsername:'123@chatroom',senderUsername:'wxid_alice',text:'你们看看这个',atUsernames:[]};
  const put=(proof:DatabaseMessageProof)=>f.store.incoming({peerId:'room',uiLabel:'群',sourceMessageId:databaseSourceId(proof),text:proof.text,database:proof});
  assert.throws(()=>put({...p,senderUsername:'stranger'}),/Database proof/);
  assert.throws(()=>put({...p,conversationUsername:'456@chatroom'}),/Database proof/);
  put(p);put({...p,localId:2,serverId:'1002',senderUsername:'wxid_bob',atUsernames:['wxid_self']});
  const a=f.store.takeIncoming()!.message,b=f.store.takeIncoming()!.message;
  assert.equal(a.addressed,false);assert.equal(b.addressed,true);
  assert.equal(a.chatContext?.actorId,'wxid_alice');assert.equal(b.chatContext?.actorId,'wxid_bob');
  assert.deepEqual(createRoomStore(f.config.queueDirectory).recent('123@chatroom').at(-1)?.mentions,['wxid_self']);
});

test('an explicit mention identifies the addressee even when quoting someone else',t=>{
 const f=fixture(t);f.config.multiUser=true;
 f.config.contacts.push({peerId:'room',uiLabel:'群',identityNote:'fixture',kind:'group',username:'123@chatroom',members:[{username:'alice',name:'A'},{username:'bob',name:'B'}]});
 const put=(id:number,mentions:string[],quoted:string)=>{
  const p={...f.proof('in',id),conversationUsername:'123@chatroom',senderUsername:'alice',atUsernames:mentions};
  return f.store.incoming({peerId:'room',uiLabel:'群',sourceMessageId:databaseSourceId(p),text:p.text,database:p,replyTo:{actorId:quoted,text:'原话'}});
 };
 put(1,['bob'],'wxid_self');
 assert.equal(f.store.takeIncoming()!.message.addressed,false,'Quoting Ruanruan is not addressing her if @ explicitly selects Bob');
 put(2,['wxid_self'],'bob');
 assert.equal(f.store.takeIncoming()!.message.addressed,true,'A quote of Bob can be material for a question to Ruanruan');
 put(3,[],'wxid_self');assert.equal(f.store.takeIncoming()!.message.addressed,true);
});

test('group reply receipts require the actual addressed member and unchanged reply body',t=>{
  const f=fixture(t);f.config.multiUser=true;
  f.config.contacts.push({peerId:'group-alice',uiLabel:'群',identityNote:'synthetic member',kind:'group',
    username:'123@chatroom',actorUsername:'wxid_alice',actorName:'Alice',members:[{username:'wxid_alice',name:'Alice',mentionNames:['Alice','小艾']}]});
  const incomingProof={...f.proof('in'),conversationUsername:'123@chatroom',senderUsername:'wxid_alice',atUsernames:['wxid_self']};
  const incoming=f.store.incoming({peerId:'group-alice',uiLabel:'群',sourceMessageId:databaseSourceId(incomingProof),text:incomingProof.text,database:incomingProof});
  const task=f.store.enqueue({peerId:'group-alice',clientId:'group-reply',kind:'text',text:'你好',context:`desktop:${incoming.seq}`,profile:'companion'});
  assert.deepEqual(task.mention,{username:'wxid_alice',name:'Alice'});
  const active=f.store.claimDelivery()!;f.store.authorizeDelivery(task.id);
  const receipt={id:task.id,leaseId:active.leaseId!,status:'sent' as const,uiLabel:'群',screenshotPath:f.screen,observedText:'你好'};
  const proof={...f.proof('out'),conversationUsername:'123@chatroom',text:'@小艾\u2005你好',atUsernames:['wxid_alice']};
  for(const wrong of [{...proof,atUsernames:[]},{...proof,atUsernames:['wxid_bob']},
    {...proof,atUsernames:['wxid_alice','wxid_bob']},{...proof,text:'@Bob\u2005你好'},
    {...proof,text:'@Alice\u2005改了正文'},{...proof,text:'你好'}]) {
    assert.throws(()=>f.store.receipt({...receipt,database:wrong}));
  }
  assert.equal(f.store.receipt({...receipt,database:proof}).status,'sent');
});

test('a different group member cannot invalidate a pending reply to Alice',t=>{
 for(const actor of ['alice','bob']) {
  const f=fixture(t);f.config.multiUser=true;
  f.config.contacts.push({peerId:'room',uiLabel:'群',identityNote:'fixture',kind:'group',username:'123@chatroom',
   members:[{username:'alice',name:'A'},{username:'bob',name:'B'}]});
  const put=(sender:string,id:number)=>{
   const p={...f.proof('in',id),conversationUsername:'123@chatroom',senderUsername:sender,atUsernames:['wxid_self']};
   return f.store.incoming({peerId:'room',uiLabel:'群',sourceMessageId:databaseSourceId(p),text:p.text,database:p});
  };
  const first=put('alice',1);
  const task=f.store.enqueue({peerId:'room',clientId:'answer-a',kind:'text',text:'答复A',context:`desktop:${first.seq}`,
   profile:'companion',mention:{username:'alice',name:'A'}});
  put(actor,2);f.store.claimDelivery();f.store.authorizeDelivery(task.id);
  assert.equal(f.store.getDelivery(task.id).status,actor==='bob'?'ready':'cancelled');
 }
});

test('a reply advances only to consumed input, not a later unaccepted message token',()=>{
 assert.equal(desktopReplyContext('desktop:20',['in:21','in:23']),'desktop:23');
 assert.equal(desktopReplyContext('desktop:20',[]),'desktop:20');
 assert.equal(desktopReplyContext('opaque-token',['in:23']),'opaque-token');
});

test('native mention separators are accepted without confusing similar names or stripping body spaces',()=>{
  assert.ok(outgoingTextMatches('\u2005@Alice\u2005  hi\r\nthere','  hi\nthere','Alice'));
  assert.ok(outgoingTextMatches('@Alice\u2005','','Alice'));
  assert.ok(outgoingTextMatches('@Alice','','Alice'));
  assert.ok(outgoingTextMatches('\u2005@Alice\u2005 ','','Alice'));
  assert.equal(outgoingTextMatches('@Alice2','','Alice'),false);
  assert.equal(outgoingTextMatches('@Alice hi','','Alice'),false);
  assert.equal(outgoingTextMatches('@Alice2\u2005hi','hi','Alice'),false);
  assert.equal(outgoingTextMatches('@Alicehi','hi','Alice'),false);
  assert.equal(outgoingTextMatches('@Alice\u2005 hi','hi','Alice'),false);
});

test('standalone member mentions are reserved for group attachment notifications',t=>{
  const f=fixture(t);f.config.multiUser=true;
  f.config.contacts.push({peerId:'group-alice',uiLabel:'群',identityNote:'synthetic member',kind:'group',
    username:'123@chatroom',actorUsername:'wxid_alice',actorName:'Alice'});
  const input={peerId:'group-alice',clientId:'mention',kind:'text' as const,text:'',context:'',profile:'companion' as const};
  assert.throws(()=>f.store.enqueue(input));
  assert.throws(()=>f.store.enqueue({...input,peerId:'owner',mentionOnly:true}));
  const task=f.store.enqueue({...input,profile:'control' as const,mentionOnly:true});
  assert.deepEqual(task.mention,{username:'wxid_alice',name:'Alice'});
  const active=f.store.claimDelivery()!;f.store.authorizeDelivery(task.id);
  const proof={...f.proof('out'),conversationUsername:'123@chatroom',text:'@Alice',atUsernames:['wxid_alice']};
  const receipt={id:task.id,leaseId:active.leaseId!,status:'sent' as const,uiLabel:'群',screenshotPath:f.screen,observedText:''};
  assert.throws(()=>f.store.receipt({...receipt,database:{...proof,atUsernames:['wxid_bob']}}),/Database proof/);
  assert.equal(f.store.receipt({...receipt,database:proof}).status,'sent');
});


test('missing local media remains an explicit media error and does not prevent the next text event',t=>{
  const f=fixture(t),p={...f.proof('in'),messageType:3,text:'<image/>'};
  f.store.incoming({peerId:'owner',uiLabel:'管理者',sourceMessageId:databaseSourceId(p),text:'',database:p,unavailableMedia:'image'});
  f.incoming(f.proof('in',2));
  const missing=f.store.takeIncoming()!.message;
  assert.equal(missing.unavailableMedia,'image');assert.equal(missing.localMedia,undefined);assert.deepEqual(missing.item_list,[]);
  assert.ok(f.store.takeIncoming());
  assert.throws(()=>f.store.incoming({peerId:'owner',uiLabel:'管理者',sourceMessageId:'forged',text:'',database:p,unavailableMedia:'audio'}),/actual database/);
});

test('uncertain sends retain incoming events across restart and resume only after a matching original receipt',t=>{
  const f=fixture(t),task=f.store.enqueue({peerId:'owner',clientId:'recover',kind:'text',text:'你好',context:'',profile:'control'});
  const active=f.store.claimDelivery()!;f.store.authorizeDelivery(task.id);
  f.store.receipt({id:task.id,leaseId:active.leaseId!,status:'uncertain',uiLabel:'管理者',error:'receipt unavailable'});
  const restarted=createDesktopStore(f.config);
  assert.equal(restarted.status().receivePaused,false);
  assert.equal(restarted.status().sendPaused,true);
  const incoming=f.incoming(f.proof('in',2));
  assert.equal(restarted.takeIncoming(),undefined,'hold retains input without paying for unusable generation');
  assert.equal(restarted.claimDelivery(),undefined);
  const recovery={id:task.id,leaseId:active.leaseId!,status:'sent' as const,uiLabel:'管理者',database:f.proof('out')};
  for (const wrong of [{...recovery,leaseId:'wrong'},{...recovery,database:f.proof('out',1,'不同正文')},
    {...recovery,database:{...f.proof('out'),serverId:'0'}}]) assert.throws(()=>restarted.reconcileReceipt(wrong));
  assert.equal(restarted.status().sendPaused,true);
  assert.equal(restarted.reconcileReceipt(recovery).status,'sent');
  assert.equal(restarted.status().sendPaused,false);
  assert.equal(restarted.takeIncoming()?.seq,incoming.seq);
  assert.equal(restarted.pendingReconciliation().length,0);
  assert.equal(restarted.reconcileReceipt(recovery).status,'sent','repeated proof is idempotent');
  assert.equal(restarted.claimDelivery(),undefined,'reconciliation never requeues the original send');
});

test('receipt recovery never clears an independent account security pause',t=>{
  const f=fixture(t),task=f.store.enqueue({peerId:'owner',clientId:'security',kind:'text',text:'你好',context:'',profile:'control'});
  const active=f.store.claimDelivery()!;f.store.authorizeDelivery(task.id);
  f.store.receipt({id:task.id,leaseId:active.leaseId!,status:'uncertain',uiLabel:'管理者',error:'timeout'});
  f.store.pause('account verification',f.screen,'security');
  f.store.reconcileReceipt({id:task.id,leaseId:active.leaseId!,status:'sent',uiLabel:'管理者',database:f.proof('out')});
  assert.equal(f.store.status().receivePaused,true);
  assert.equal(f.store.status().sendPaused,true);
  assert.equal(f.store.status().alert.kind,'security');
  assert.throws(()=>f.incoming(f.proof('in',2)),/暂停/);
});

test('crash after send authorization freezes sending and does not replay an expired delivery',t=>{
  const f=fixture(t),task=f.store.enqueue({peerId:'owner',clientId:'crash',kind:'text',text:'你好',context:'',profile:'control'});
  f.store.claimDelivery(1000);f.store.authorizeDelivery(task.id);f.advance();
  const status=f.store.status();
  assert.equal(status.sendPaused,true);assert.equal(status.receivePaused,false);
  assert.equal(f.store.pendingReconciliation()[0].id,task.id);
  f.incoming(f.proof('in',2));
  assert.equal(f.store.claimDelivery(),undefined);
  assert.equal(f.store.getDelivery(task.id).status,'uncertain');
});

test('an unrelated recovered receipt cannot clear the current sending hold',t=>{
  const f=fixture(t);
  const old=f.store.enqueue({peerId:'owner',clientId:'older',kind:'text',text:'你好',context:'',profile:'control'});
  const a=f.store.claimDelivery()!;f.store.authorizeDelivery(old.id);
  f.store.receipt({id:old.id,leaseId:a.leaseId!,status:'uncertain',uiLabel:'管理者',error:'old timeout'});
  f.store.resume();
  const current=f.store.enqueue({peerId:'owner',clientId:'newer',kind:'text',text:'其他消息',context:'',profile:'control'});
  const b=f.store.claimDelivery()!;f.store.authorizeDelivery(current.id);
  f.store.receipt({id:current.id,leaseId:b.leaseId!,status:'uncertain',uiLabel:'管理者',error:'new timeout'});
  f.store.reconcileReceipt({id:old.id,leaseId:a.leaseId!,status:'sent',uiLabel:'管理者',database:f.proof('out')});
  assert.equal(f.store.status().sendHold.deliveryId,current.id);
  assert.equal(f.store.status().sendPaused,true);
});

test('voice waits for its original media without blocking other people and keeps following text ordered',t=>{
  const f=fixture(t);f.config.multiUser=true;
  f.config.contacts.push({peerId:'other',uiLabel:'其他人',identityNote:'fixture',kind:'private',username:'other'});
  const p={...f.proof('in'),messageType:34,text:'<voicemsg/>',displayText:'[语音]'};
  const input={peerId:'owner',uiLabel:'管理者',sourceMessageId:databaseSourceId(p),text:'[语音]',database:p,
    unavailableMedia:'audio' as const,media:{kind:'audio' as const,key:'voice-1',status:'pending' as const}};
  f.store.incoming(input);f.incoming(f.proof('in',2,'后面那句补充'));
  const other={...f.proof('in',3,'其他人照常聊天'),conversationUsername:'other',senderUsername:'other'};
  f.store.incoming({peerId:'other',uiLabel:'其他人',sourceMessageId:databaseSourceId(other),text:other.text,database:other});
  assert.equal(f.store.takeIncoming()?.message.from_user_id,'other');
  assert.equal(f.store.takeIncoming(),undefined,'same speaker text waits behind their pending voice');
  const transcript={text:'明天下午三点',rawText:'明天下午三点',source:'wechat' as const,sourceId:input.sourceMessageId,confidence:null};
  f.store.incoming({...input,media:{...input.media,status:'available',transcript},database:{...p,text:'<voicemsg transcript="明天下午三点"/>'}});
  const voice=f.store.takeIncoming()!;
  assert.equal(voice.message.localMedia?.kind,'voice');
  assert.equal(voice.message.localMedia?.transcript?.rawText,'明天下午三点');
  assert.equal(voice.message.unavailableMedia,undefined);
  assert.equal(f.store.takeIncoming()?.message.item_list?.[0].text_item?.text,'后面那句补充');
  assert.throws(()=>f.store.incoming({...input,database:{...p,createdAt:p.createdAt+1000}}),/reused/);
});

test('voice waiting has a deadline and late transcription enriches the same occurrence without replay',t=>{
  const f=fixture(t),p={...f.proof('in'),messageType:34,text:'<voicemsg/>',displayText:'[语音]'};
  const input={peerId:'owner',uiLabel:'管理者',sourceMessageId:databaseSourceId(p),text:'[语音]',database:p,
    unavailableMedia:'audio' as const,media:{kind:'audio' as const,key:'voice-timeout',status:'pending' as const}};
  f.store.incoming(input);assert.equal(f.store.takeIncoming(),undefined);
  for(let i=0;i<31;i++)f.advance();
  const expired=f.store.takeIncoming()!;assert.equal(expired.message.unavailableMedia,'audio');f.store.finishIncoming(expired.seq);
  const transcript={text:'晚到的转写',rawText:'晚到的转写',source:'wechat' as const,sourceId:input.sourceMessageId,confidence:null};
  f.store.incoming({...input,media:{...input.media,status:'available',transcript}});
  assert.equal(f.store.takeIncoming(),undefined);
  assert.equal(f.store.storedIncoming(input.sourceMessageId)?.localMedia?.transcript?.text,transcript.text);
});
