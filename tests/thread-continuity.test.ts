import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Session} from '../src/session.js';
import type {CodexRunOptions} from '../src/codex/bridge.js';
const root=mkdtempSync(join(tmpdir(),'thread-continuity-'));process.env.WCB_DATA_DIR=root;
const {retainDeliveryContext,retainReviewedContext,conversationThreadTitle,isCharacterThreadTitle}=await import('../src/thread-continuity.js');
const {createMemoryStore,runWithMemory}=await import('../src/memory.js');
const {createSessionStore,acceptThread}=await import('../src/session.js');
const {retireLegacyGroupSession,conversationAccount}=await import('../src/conversation-scope.js');
test.after(()=>rmSync(root,{recursive:true,force:true}));
const initial=():Session=>({workingDirectory:root,state:'idle',threadId:'same-thread',memoryVersion:1,companionVersion:6,memoryToolsVersion:2});
const options:CodexRunOptions={cwd:root,mode:'plan',profile:'companion',prompt:'然后呢',
 personaContext:{version:'ruanruan-core-v6',fingerprint:'test',files:[],bytes:0},
 conversation:{accountId:'continuity',peerId:'owner',messageIds:[]}};

test('review corrections and incomplete sends resume the same thread without another model call',async()=>{
 const session=initial(),memory=createMemoryStore('continuity');
 const result={threadId:'same-thread',replyText:'那先不发',commands:[],fileChanges:[],characterUpdate:{}};
 assert.equal(retainReviewedContext(session,result),true);
 retainDeliveryContext(session,['先前确实发出的第一句']);
 const saved=createSessionStore(join(root,'sessions'));saved.save('continuity',session);
 const resumed=saved.load('continuity');let calls=0;
 await runWithMemory(options,resumed,memory,()=>{},async call=>{
  calls++;assert.equal(call.threadId,'same-thread');
  assert.deepEqual(call.turnFacts?.previousTurn?.reviewed?.characterUpdate,{});
  assert.deepEqual(call.turnFacts?.previousTurn?.delivery?.confirmedTexts,['先前确实发出的第一句']);
  assert.match(call.prompt,/不自动补发/);assert.equal(call.currentUser,'然后呢');
  return {threadId:'same-thread',replyText:'接着说',commands:[],fileChanges:[]};
 });
 assert.equal(calls,1);assert.equal(resumed.threadId,'same-thread');assert.equal(resumed.threadFeedback,undefined);
 const parent=initial();acceptThread(parent,resumed);assert.equal(parent.threadFeedback,undefined);
});

test('failed inference keeps feedback until recovery and never mistakes a delivery issue for inferred success',async()=>{
 const session=initial(),memory=createMemoryStore('failed-continuity');retainDeliveryContext(session,[]);
 await runWithMemory(options,session,memory,()=>{},async()=>({threadId:'same-thread',replyText:'',commands:[],fileChanges:[],error:'network'}));
 assert.equal(session.rotateBeforeNext,true);assert.equal(session.threadFeedback?.delivery?.status,'incomplete');
 assert.equal(retainReviewedContext(session,{threadId:'different',replyText:'',commands:[],fileChanges:[]}),false);
});

test('new threads do not inherit feedback belonging to retired conversations',async()=>{
 const session=initial(),memory=createMemoryStore('new-continuity');retainDeliveryContext(session,[]);session.rotateBeforeNext=true;
 await runWithMemory(options,session,memory,()=>{},async call=>{
  assert.equal(call.threadId,undefined);assert.equal(call.turnFacts?.previousTurn,undefined);
  return {threadId:'next-thread',replyText:'接着聊',commands:[],fileChanges:[]};
 });
 assert.equal(session.threadFeedback,undefined);
});

test('titles identify the routed group or private contact and remain eligible for retirement',()=>{
 const group=conversationThreadTitle({...options,conversation:{...options.conversation!,roomId:'g@chatroom',label:'钓鱼群'}});
 const person=conversationThreadTitle({...options,conversation:{...options.conversation!,label:'测试哥'}});
 assert.equal(group,'微信 · 阮阮 · 群聊：钓鱼群');assert.equal(person,'微信 · 阮阮 · 私聊：测试哥');
 for(const title of [group,person,'微信 · 阮阮','QQ · 阮阮'])assert.equal(isCharacterThreadTitle(title),true);
 for(const title of ['微信 · 助手','排查阮阮','微信 · 阮阮调查'])assert.equal(isCharacterThreadTitle(title),false);
});
test('obsolete per-member group sessions retire only after a canonical room thread exists',()=>{
 const base={accountId:'desktop',userId:'owner',transport:'desktop' as const};
 const context={kind:'group' as const,conversationId:'g@chatroom',conversationName:'群',actorId:'a',actorName:'甲'};
 const saved={...initial(),chatContext:context,jobFromUserId:'room',threadId:'old'};
 const current={...saved,threadId:'shared'};
 const canonical=conversationAccount(base,'room',context).accountId;
 const retired=retireLegacyGroupSession(base,'desktop-chat-legacy',saved,current)!;
 assert.equal(retired.threadId,undefined);assert.equal(retired.retiredThreadId,'old');
 assert.equal(retireLegacyGroupSession(base,canonical,current,current),undefined);
 assert.equal(retireLegacyGroupSession(base,'legacy',{...saved,activeJobId:'busy'},current),undefined);
 assert.equal(retireLegacyGroupSession(base,'legacy',saved,{...current,threadId:undefined}),undefined);
 assert.equal(retireLegacyGroupSession(base,'legacy',saved,{...current,chatContext:{...context,conversationId:'other@chatroom'}}),undefined);
});
