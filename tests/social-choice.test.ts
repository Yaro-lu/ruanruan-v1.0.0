import test from 'node:test';import assert from 'node:assert/strict';
import{mkdtempSync,rmSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
const root=mkdtempSync(join(tmpdir(),'social-turn-'));process.env.WCB_DATA_DIR=root;
test.after(()=>rmSync(root,{recursive:true,force:true}));
const {createMemoryStore}=await import('../src/memory.js');const {createConversationStore}=await import('../src/conversation.js');
const {runConversationTurn}=await import('../src/chat-retry.js');const {hasCharacterApproval}=await import('../src/character-review.js');
const {CHARACTER_TURN_INSTRUCTIONS}=await import('../src/character-turn.js');
const persona={version:'ruanruan-core-v6',fingerprint:'test',files:[],bytes:0};
test('reviewed quiet decision suppresses sending without a fabricated outbound message',async()=>{
 const memory=createMemoryStore('quiet'),journal=createConversationStore('quiet','p');
 const id=journal.record('in',{message_id:'m',item_list:[{type:1,text_item:{text:'嗯'}}]},Date.now(),undefined,'companion');
 let calls=0;
 const r=await runConversationTurn({profile:'companion',personaContext:persona,cwd:root,mode:'plan',prompt:'嗯',developerInstructions:CHARACTER_TURN_INSTRUCTIONS,
  conversation:{accountId:'quiet',peerId:'p',messageIds:[id]}},{state:'idle',workingDirectory:root},memory,()=>{},async o=>{
   calls++;return{replyText:o.profile==='companion'?'<<<RUANRUAN_STATE>>>\n{"social":{"intent":"closing","effect":"none","mode":"quiet","userQuote":"嗯"}}':'{"verdict":"pass","issues":[]}',commands:[],fileChanges:[]};
  });
 assert.equal(calls,2);assert.equal(r.replyDisposition,'no_reply');assert.equal(r.replyText,'');assert.equal(hasCharacterApproval(r),true);
 assert.equal(journal.recent(10,'companion').filter(x=>x.direction==='out').length,0);
 assert.equal(hasCharacterApproval({...r,characterUpdate:{social:{...r.characterUpdate!.social!,effect:'harassment'}}}),false);
});
test('active personal cooldown skips the model while work mode keeps functioning',async()=>{
 const memory=createMemoryStore('paused');memory.socialObserve('p','m','别理我',{intent:'conflict',effect:'harassment',mode:'pause',minutes:15,userQuote:'别理我'});
 let calls=0;const runner=async()=>{calls++;return{replyText:'工作入口正常\n<<<WCB_MEMORY_V1>>>\n{"upsert":[],"remove":[]}',commands:[],fileChanges:[]};};
 const base={cwd:root,mode:'plan' as const,prompt:'喂',conversation:{accountId:'paused',peerId:'p'}};
 const r=await runConversationTurn({...base,profile:'companion',personaContext:persona},{state:'idle',workingDirectory:root},memory,()=>{},runner);
 assert.equal(calls,0);assert.equal(r.replyDisposition,'no_reply');assert.equal(hasCharacterApproval(r),true);
 const work=await runConversationTurn({...base,profile:'work'},{state:'idle',workingDirectory:root},memory,()=>{},runner);
 assert.equal(calls,1);assert.equal(work.replyText,'工作入口正常');
});
