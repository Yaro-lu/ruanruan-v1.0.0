import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DesktopConfig} from '../src/desktop/config.js';
import type {ChatContext} from '../src/wechat/channel.js';
import type {RoomEvent} from '../src/desktop/room-context.js';

const testRoot=mkdtempSync(join(tmpdir(),'cross-conversation-'));
process.env.WCB_DATA_DIR=testRoot;
const {createCrossConversation,crossPublicContextText}=await import('../src/cross-conversation.js');
const {createIdentityStore}=await import('../src/identity.js');
const {createRoomStore}=await import('../src/desktop/room-context.js');
const {syncDesktopIdentities}=await import('../src/desktop/identity.js');
const {createConversationStore}=await import('../src/conversation.js');
const {conversationAccount}=await import('../src/conversation-scope.js');
test.after(()=>rmSync(testRoot,{recursive:true,force:true}));
const NOW=1_800_000_000_000;

function fixture(t:any) {
  const directory=mkdtempSync(join(testRoot,'fixture-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const config:DesktopConfig={version:1,enabled:true,accountId:'desktop-cross',ownerPeerId:'peer-a',multiUser:true,
    exchangeDirectory:join(directory,'exchange'),queueDirectory:join(directory,'bridge'),identityDirectory:directory,
    database:{accountDirectory:'self_1',selfUsername:'self',ownerUsername:'a'},contacts:[
      {peerId:'peer-a',username:'a',uiLabel:'小陆',identityNote:'verified friend',kind:'private'},
      {peerId:'peer-b',username:'b',uiLabel:'小李',identityNote:'verified friend',kind:'private'},
      {peerId:'peer-z',username:'z',uiLabel:'无关好友',identityNote:'verified friend',kind:'private'},
      {peerId:'room-one',username:'one@chatroom',uiLabel:'夜钓一群',identityNote:'verified room',kind:'group',rosterObservedAt:NOW,members:[
        {username:'a',name:'测试哥'},{username:'b',name:'小李'},{username:'self',name:'阮阮'}]},
      {peerId:'room-secret',username:'secret@chatroom',uiLabel:'别的群',identityNote:'verified room',kind:'group',rosterObservedAt:NOW,members:[
        {username:'z',name:'无关好友'}]},
    ]};
  const identities=syncDesktopIdentities(config);
  const account=(actorId:string)=>({platform:'wechat' as const,channelAccountId:config.accountId,actorId});
  const context=(actorId='a'):ChatContext=>({kind:'private',conversationId:actorId,conversationName:actorId,
    actorId,actorName:actorId,person:identities.view(account(actorId))});
  const store=createRoomStore(config.queueDirectory,(actorId,room)=>identities.view(account(actorId),room),directory);
  const add=(id:string,actorId:string,text:string,extra:Partial<RoomEvent>={})=>store.record({
    id,actorId,actorName:actorId,roomId:'one@chatroom',roomName:'夜钓一群',at:NOW-1000,self:false,text,kind:'text',...extra});
  const cross=createCrossConversation(config,{now:()=>NOW});
  return {directory,config,identities,account,context,store,add,cross};
}

test('same person can continue a bounded public exchange in private with original IDs and scope',t=>{
  const f=fixture(t);
  f.add('a-1','a','我周末去钓鲫鱼',{at:NOW-3000});
  f.add('b-1','b','鲫鱼可以试试蚯蚓',{at:NOW-2000});
  f.add('self-1','self','鱼钩别太大',{self:true});
  f.add('hidden','z','SECRET_OTHER_ROOM',{roomId:'secret@chatroom'});
  createConversationStore('other-private','peer-z',f.directory).record('in',{
    message_id:'secret',item_list:[{type:1,text_item:{text:'PRIVATE_SECRET'}}]},NOW,undefined,'companion');
  const result=f.cross.publicContext({context:f.context(),query:'钓鲫鱼'});
  assert.equal(result.status,'ok');assert.equal(result.rooms.length,1);
  assert.deepEqual(result.rooms[0].messages.map(row=>row.id),['a-1','b-1','self-1']);
  assert.deepEqual(result.rooms[0].scope,{kind:'group',id:JSON.stringify(['wechat','desktop-cross','one@chatroom'])});
  assert.equal(result.rooms[0].messages[0].personId,f.context().person!.id);
  assert.ok(result.rooms[0].participation.some(proof=>proof.sourceId==='a-1'));
  assert.doesNotMatch(JSON.stringify(result),/SECRET_OTHER_ROOM|PRIVATE_SECRET/);
  assert.match(crossPublicContextText(result),/公开原话/);
});

test('matching nicknames or a mention do not grant participation or reveal unrelated routes',t=>{
  const f=fixture(t);
  f.config.contacts.find(row=>row.username==='one@chatroom')!.members=[{username:'a',name:'同名'}];
  f.identities.observe(f.account('a'),[{name:'同名',kind:'nickname'}]);
  f.identities.observe(f.account('b'),[{name:'同名',kind:'nickname'}]);
  f.add('own','a','PRIVATE_GROUP_TOPIC',{mentions:['b']});
  const result=f.cross.publicContext({context:f.context('b'),query:'PRIVATE_GROUP_TOPIC',room:'夜钓一群'});
  assert.equal(result.status,'not_found');assert.deepEqual(result.rooms,[]);
  assert.deepEqual(f.cross.sharedGroups(f.context('b')),[]);
  assert.equal(f.cross.resolveTarget({context:f.context('b'),query:'one@chatroom',kind:'group'}).status,'not_found');
  assert.equal(f.cross.resolveTarget({context:f.context('b'),query:'夜钓',kind:'group'}).status,'not_found');
});

test('old participation never authorizes access after leaving a group',t=>{
  const f=fixture(t);f.config.contacts.find(row=>row.username==='one@chatroom')!.members=[];
  f.add('old','a','两年前说过我喜欢竹竿',{at:NOW-700*86_400_000});
  assert.equal(f.cross.publicContext({context:f.context(),query:'竹竿'}).rooms.length,0);
  f.add('after-leaving','b','AFTER_LEAVING_SECRET',{at:NOW-1000});
  assert.equal(f.cross.sharedGroups(f.context()).length,0);
  const recalled=f.cross.publicContext({context:f.context(),query:'竹竿',room:'one@chatroom'});
  assert.equal(recalled.status,'not_found');assert.deepEqual(recalled.rooms,[]);
  assert.doesNotMatch(JSON.stringify(recalled),/AFTER_LEAVING_SECRET/);
});

test('unknown stale or future roster observations deny cross-room access despite old speech',t=>{
  const f=fixture(t),room=f.config.contacts.find(row=>row.username==='one@chatroom')!;
  f.add('old','a','曾经在群里发言');
  for(const observed of [undefined,NOW-60_001,NOW+1,NaN,0]) {
    room.rosterObservedAt=observed;
    assert.equal(f.cross.publicContext({context:f.context(),room:'one@chatroom'}).status,'not_found');
    assert.deepEqual(f.cross.sharedGroups(f.context()),[]);
  }
  room.rosterObservedAt=NOW-60_000;
  assert.equal(f.cross.sharedGroups(f.context()).length,1);
});

test('roster observation caps retrieval before adjacency and quote expansion',t=>{
  const f=fixture(t),room=f.config.contacts.find(row=>row.username==='one@chatroom')!;
  room.rosterObservedAt=NOW-2000;
  f.add('own','a','鱼竿怎么选',{at:NOW-3000});
  f.add('after','b','SECRET_AFTER_OBSERVATION',{at:NOW-1000});
  f.add('quoted','a','鱼竿这样吗',{at:NOW-2500,replyTo:{sourceId:'after',text:'SECRET_AFTER_OBSERVATION',
    media:{kind:'image',key:'secret',localPath:'/private/image.png'}}});
  const value=f.cross.publicContext({context:f.context(),query:'鱼竿',room:'one@chatroom'});
  assert.deepEqual(value.rooms[0].messages.map(row=>row.id),['own','quoted']);
  assert.doesNotMatch(JSON.stringify(value),/SECRET_AFTER_OBSERVATION|private\/image|"key":"secret"/);
  assert.equal(f.store.snapshot('one@chatroom').messages.length,3,'the current group retains its normal public context');
});

test('a former shared member is not a cross-private contact merely because they once spoke',t=>{
  const f=fixture(t),room=f.config.contacts.find(row=>row.username==='one@chatroom')!;
  room.members=room.members!.filter(member=>member.username!=='b');
  f.add('old-b','b','曾经公开说过的话');
  assert.equal(f.cross.resolveTarget({context:f.context(),query:'小李',kind:'private'}).status,'not_found');
});

test('verified roster allows explicit relevant room lookup but not automatic unrelated group loading',t=>{
  const f=fixture(t);f.add('only-b','b','店里新到的杯子是蓝色');
  assert.equal(f.cross.publicContext({context:f.context(),query:'杯子'}).rooms.length,0);
  const explicit=f.cross.publicContext({context:f.context(),query:'杯子',room:'夜钓一群'});
  assert.equal(explicit.rooms[0].messages[0].id,'only-b');
  assert.equal(explicit.rooms[0].participation[0].kind,'verified_member');
});

test('explicitly linked accounts share identity without inferring it from display labels',t=>{
  const f=fixture(t),id=f.context().person!.id;
  f.identities.bindAccount(id,f.account('a-alt'));
  f.identities.observe(f.account('a-alt'),[{name:'另一个号',kind:'nickname'}]);
  f.config.contacts.find(row=>row.username==='one@chatroom')!.members=[{username:'a-alt',name:'另一个号'}];
  f.add('alternate','a-alt','新的鱼竿还不错');
  const result=f.cross.publicContext({context:f.context(),query:'鱼竿'});
  assert.equal(result.rooms[0].messages[0].personId,id);
  assert.equal(result.rooms[0].participation[0].actorId,'a-alt');
});

test('nonunique groups and group member names return candidates; account IDs resolve the exact person',t=>{
  const f=fixture(t),first=f.config.contacts.find(row=>row.username==='one@chatroom')!;
  f.config.contacts.push({...first,peerId:'room-two',username:'two@chatroom'});
  const ambiguous=f.cross.resolveTarget({context:f.context(),query:'夜钓一群',kind:'group'});
  assert.equal(ambiguous.status,'ambiguous');if(ambiguous.status!=='ambiguous')return;
  assert.equal(ambiguous.candidates.length,2);
  first.members=[{username:'a',name:'同名'},{username:'b',name:'同名'}];
  const member=f.cross.resolveTarget({context:f.context(),query:'one@chatroom',kind:'group',member:'同名'});
  assert.equal(member.status,'ambiguous');if(member.status==='ambiguous')assert.equal(member.candidates.length,2);
  const resolved=f.cross.resolveTarget({context:f.context(),query:'one@chatroom',kind:'group',member:'b'});
  assert.equal(resolved.status,'resolved');if(resolved.status!=='resolved')return;
  assert.deepEqual(resolved.route.mention,{username:'b',name:'同名'});
  const expected=conversationAccount({accountId:f.config.accountId,userId:f.config.ownerPeerId,transport:'desktop'},resolved.route.peerId,resolved.route.context);
  assert.equal(resolved.route.storageAccountId,expected.accountId);
  assert.equal(f.cross.resolveTarget({context:f.context(),query:'夜钓',kind:'group'}).status,'ambiguous');
});

test('groups never load private continuation and only expose their own readable public scope',t=>{
  const f=fixture(t),context={...f.context(),kind:'group' as const,conversationId:'one@chatroom'};
  f.config.contacts.find(row=>row.username==='secret@chatroom')!.members!.push({username:'a',name:'测试哥'});
  assert.deepEqual(f.cross.publicContext({context,query:'任何旧事'}),{status:'not_private',rooms:[]});
  assert.deepEqual(f.cross.sharedGroups(context).map(row=>row.roomId),['one@chatroom']);
  assert.equal(f.cross.sharedGroups(f.context()).length,2);
});

test('reset public events and their quotations do not reappear through cross-conversation retrieval',t=>{
  const f=fixture(t);f.add('old','a','OLD_DISPUTE',{at:NOW-3000});
  f.add('new','a','新的鱼竿',{at:NOW-1000});
  f.add('quote','b','这是新消息',{replyTo:{actorId:'a',sourceId:'old',text:'OLD_DISPUTE'}});
  writeFileSync(join(f.directory,'person-memory-resets.json'),JSON.stringify({resets:[{
    personId:f.context().person!.id,channelAccountId:f.config.accountId,actorId:'a',roomId:'one@chatroom',
    storageAccountId:'old',peerId:'old',before:NOW-2000,through:1,messageIds:[],roomEventIds:['old'],
  }]}));
  const result=f.cross.publicContext({context:f.context(),query:'鱼竿'});
  assert.doesNotMatch(JSON.stringify(result),/OLD_DISPUTE/);
  assert.match(JSON.stringify(result),/旧引用已重置/);
  assert.equal(f.store.recent('one@chatroom').length,3,'raw archive stays intact');
});

test('automatic public continuation is small and avoids distant unrelated exchanges',t=>{
  const f=fixture(t);f.add('distant','b','DISTANT_OTHER_TOPIC',{at:NOW-2*60*60_000});
  for(let i=0;i<30;i++)f.add('row-'+i,i%2?'a':'b','钓鱼相关'+i,{at:NOW-30_000+i*1000});
  const result=f.cross.publicContext({context:f.context(),query:'群里刚说的那个'});
  assert.ok(result.rooms[0].messages.length<=6);assert.doesNotMatch(JSON.stringify(result),/DISTANT_OTHER_TOPIC/);
});

test('requester identity is checked and private routes exclude unrelated friends',t=>{
  const f=fixture(t),forged={...f.context('z'),person:f.context().person};
  assert.equal(f.cross.publicContext({context:forged}).status,'unknown_person');
  assert.equal(f.cross.resolveTarget({context:forged,query:'夜钓一群'}).status,'unknown_person');
  assert.equal(f.cross.resolveTarget({context:f.context(),query:'无关好友',kind:'private'}).status,'not_found');
  const result=f.cross.resolveTarget({context:f.context(),query:'小李',kind:'private'});
  assert.equal(result.status,'resolved');if(result.status!=='resolved')return;
  assert.equal(result.route.personId,f.context('b').person!.id);
  assert.deepEqual(result.route.scope,{kind:'private',id:JSON.stringify(['wechat','desktop-cross',f.context('b').person!.id])});
});
