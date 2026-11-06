import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createIdentityStore} from '../src/identity.js';
import {createMemoryStore} from '../src/memory.js';
import {createCharacterMetrics} from '../src/character-metrics.js';
import {createRoomStore} from '../src/desktop/room-context.js';

const account=(actorId:string)=>({platform:'wechat' as const,channelAccountId:'desktop-test',actorId});
const fixture=(t:any)=>{const root=mkdtempSync(join(tmpdir(),'person-identity-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;};

test('different people may share every visible name; only verified account mapping identifies them',t=>{
  const identities=createIdentityStore(fixture(t));
  const a=identities.observe(account('wxid_a'),[{name:'测试用户甲',kind:'nickname'}],'测试用户甲');
  const b=identities.observe(account('wxid_b'),[{name:'测试用户甲',kind:'nickname'},{name:'管理员',kind:'observed'}],'测试用户甲');
  identities.setName(a.id,'管理员');identities.setName(b.id,'管理员');
  assert.notEqual(a.id,b.id);assert.equal(identities.lookupName('测试用户甲').length,2);assert.equal(identities.lookupName('管理员').length,2);
  assert.throws(()=>identities.bindAccount(a.id,account('wxid_b')),/different person/);
  assert.equal(identities.get(account('wxid_b'))?.id,b.id);
});

test('nickname changes preserve person, operator label, old aliases and existing affection',t=>{
  const root=fixture(t),identities=createIdentityStore(root),metrics=createCharacterMetrics(join(root,'character-life'));
  const key=JSON.stringify(['desktop-test','wxid_a']),quote='谢谢你记得';
  metrics.observe(key,'before-identity',quote,{intent:'chat',effect:'important',mode:'reply',userQuote:quote},Date.now(),'嗯');
  const before=metrics.snapshot(key).relationship!.affection;
  const first=identities.observe(account('wxid_a'),[{name:'测试用户甲',kind:'nickname'},{name:'管理者_fixture_owner',kind:'remark'}],'测试用户甲');
  identities.setName(first.id,'管理员');
  identities.setPreferredName(first.id,'测试哥');
  const renamed=identities.observe(account('wxid_a'),[{name:'新昵称',kind:'nickname'}],'新昵称');
  assert.equal(first.id,renamed.id);assert.equal(renamed.name,'管理员');assert.equal(renamed.storageKey,key);
  const memory=createMemoryStore('private-chat',root,{accountId:'desktop-test',actorId:'wxid_a',audience:'private'});
  assert.equal(memory.socialSnapshot('peer').relationship!.affection,before);
  const person=memory.relationshipContext('peer').person!;
  assert.equal(person.id,first.id);assert.equal(person.name,'管理员');
  assert.equal(person.preferredName,'测试哥');assert.equal(identities.lookupName('测试哥')[0].id,first.id);
  for(const name of ['测试用户甲','管理者_fixture_owner','新昵称'])assert.ok(person.aliases.some(a=>a.name===name));
});

test('explicitly binding a second verified account shares its person without rewriting conversation history',t=>{
  const root=fixture(t),identities=createIdentityStore(root),a=identities.observe(account('wxid_a'));
  const qq={platform:'qq' as const,channelAccountId:'qq-test',actorId:'12345'};
  identities.bindAccount(a.id,qq);assert.equal(identities.observe(qq).id,a.id);
  const wechat=createMemoryStore('wechat-private',root,{accountId:'desktop-test',actorId:'wxid_a',audience:'private'});
  wechat.socialObserve('peer','turn','谢谢',{intent:'chat',effect:'important',mode:'reply',userQuote:'谢谢'},Date.now(),'嗯');
  const other=createMemoryStore('qq-private',root,{accountId:'qq-test',actorId:'12345',platform:'qq',audience:'private'});
  assert.equal(wechat.socialSnapshot('peer').relationship!.affection,other.socialSnapshot('peer2').relationship!.affection);
  assert.notEqual(wechat.dir,other.dir);
});

test('room snapshots identify old and new names by one person ID; other rooms names stay private',t=>{
  const root=fixture(t),identities=createIdentityStore(root),a=identities.observe(account('wxid_a'),[
    {name:'旧昵称',kind:'nickname'},{name:'本群昵称',kind:'room_nickname',scope:'r@chatroom'},
    {name:'OTHER_ROOM_SECRET',kind:'room_nickname',scope:'other@chatroom'}]);
  identities.setName(a.id,'管理员');
  const rooms=createRoomStore(join(root,'rooms'),(actorId,room)=>identities.view(account(actorId),room));
  for(const [id,name] of [['one','旧昵称'],['two','新昵称']])rooms.record({id,roomId:'r@chatroom',roomName:'群',actorId:'wxid_a',actorName:name,self:false,at:Date.now(),text:'hello',kind:'text'});
  const snap=rooms.snapshot('r@chatroom');
  assert.equal(snap.participants.length,1);assert.equal(snap.participants[0].name,'管理员');
  assert.equal(snap.messages[0].personId,snap.messages[1].personId);assert.equal(snap.messages[0].personId,a.id);
  assert.doesNotMatch(JSON.stringify(snap),/OTHER_ROOM_SECRET/);
});
