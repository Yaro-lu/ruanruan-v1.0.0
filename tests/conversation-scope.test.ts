import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { conversationAccount, applyEntryRole, entryProfile, conversationScene } from '../src/conversation-scope.js';
import type { Session } from '../src/session.js';
import type { ChannelAccount, ChatContext } from '../src/wechat/channel.js';
const root=mkdtempSync(join(tmpdir(),'wechat-scope-'));
process.env.WCB_DATA_DIR=root;
const {characterDialogueInput}=await import('../src/companion-profile.js');
const {handleMessage}=await import('../src/main.js');
const {createSessionStore}=await import('../src/session.js');
const {memoryDirectory}=await import('../src/memory.js');
test.after(()=>rmSync(root,{recursive:true,force:true}));
const base:ChannelAccount={accountId:'desktop-role',userId:'owner',transport:'desktop',entryRole:'character'};
const scene=(actor:string,room='room@chatroom'):ChatContext=>({kind:'group',conversationId:room,conversationName:'群',actorId:actor,actorName:actor});
test('group turn and running-turn supplements preserve the real speaker instead of implying a private addressee',()=>{
 for(const supplement of [false,true]) {
  const text=characterDialogueInput('有',supplement,{actorId:'alice',actorName:'同名'});
  const value=JSON.parse(text.split('\n')[1]);
  assert.equal(value.speakerId,'alice');assert.equal(value.speaker,'同名');assert.equal(value.text,'有');
  assert.match(text,/不默认对阮阮说/);assert.match(text,/quiet/);
 }
 assert.equal(JSON.parse(characterDialogueInput('你好').split('\n')[1]).speaker,'对方');
});
test('a group has one public session while private and other-room histories stay isolated',()=>{
 const owner=conversationAccount(base,'owner',{...scene('wxid_owner','wxid_owner'),kind:'private'});
 assert.equal(owner.accountId,base.accountId);
 const alice=conversationAccount(base,'room',scene('alice')),bob=conversationAccount(base,'room',scene('bob'));
 assert.equal(alice.accountId,bob.accountId);assert.notEqual(alice.person?.actorId,bob.person?.actorId);
 const privateAlice=conversationAccount(base,'alice',{...scene('alice','alice'),kind:'private'});
 assert.notEqual(privateAlice.accountId,alice.accountId);
 assert.equal(privateAlice.person?.actorId,alice.person?.actorId);
 assert.notEqual(conversationAccount(base,'other',scene('alice','other@chatroom')).accountId,alice.accountId);
 const store=createSessionStore(join(root,'scope-sessions'));
 store.save(alice.accountId,{workingDirectory:root,state:'idle',threadId:'public-group',chatContext:scene('alice')});
 assert.equal(store.load(bob.accountId).threadId,'public-group');
 assert.equal(store.clear(alice.accountId,store.load(alice.accountId)).chatContext?.actorId,'alice');
 assert.match(conversationScene(scene('alice')),/公开对话/);
 assert.equal(conversationScene(scene('alice')),conversationScene(scene('bob')),'fixed instructions do not churn when the speaker changes');
});
test('the personal WeChat entry ignores control commands even for its owner and cannot select work',async()=>{
 const session:Session={workingDirectory:root,state:'idle',chatMode:'assistant',mode:'danger'};
 const store=createSessionStore(join(root,'locked-sessions'));
 const sender={sendText:async()=>{throw Error('must not execute or acknowledge management commands');}} as any;
 for (const text of ['/Q','/skill restart-server','/approve','/model gpt-6.1-sol','/stop']) {
  await handleMessage({message_type:1,from_user_id:'owner',item_list:[{type:1,text_item:{text}}]},base,session,store,sender,{workingDirectory:root});
 }
 assert.equal(session.chatMode,'companion');assert.equal(session.mode,'plan');
 assert.equal(entryProfile(base,'work'),'companion');
 assert.equal(session.model,'gpt-5.6-luna');
 assert.ok(!existsSync(join(root,'jobs'))||!readdirSync(join(root,'jobs')).length);
});
test('the owner-only official control entry stays assistant when /Q is sent',async()=>{
 const account:ChannelAccount={accountId:'official',userId:'owner',transport:'ilink',entryRole:'control'};
 const session:Session={workingDirectory:root,state:'idle',chatMode:'companion',mode:'danger'};
 applyEntryRole(account,session);assert.equal(entryProfile(account,'companion'),'work');
 const replies:string[]=[];
 await handleMessage({message_type:1,from_user_id:'owner',item_list:[{type:1,text_item:{text:'/Q'}}]},account,session,
 createSessionStore(join(root,'control-sessions')),{sendText:async(_p:string,_c:string,t:string)=>{replies.push(t);return {};}} as any,{workingDirectory:root});
 assert.equal(session.chatMode,'assistant');assert.equal(session.mode,'danger');assert.equal(replies.length,1);
 await handleMessage({message_type:1,from_user_id:'stranger',item_list:[{type:1,text_item:{text:'/Q'}}]},account,session,
 {} as any,{sendText:async()=>{throw Error('stranger must be rejected');}} as any,{workingDirectory:root});
 assert.equal(replies.length,1);
});
