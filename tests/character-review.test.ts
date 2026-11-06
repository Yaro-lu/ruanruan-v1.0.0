import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
const root = mkdtempSync(join(tmpdir(), 'character-review-'));
process.env.WCB_DATA_DIR = root;
const { reviewCharacterReply, hasCharacterApproval,characterDeliveryBlockedReason } = await import('../src/character-review.js');
const { createMemoryStore } = await import('../src/memory.js');
const { runConversationTurn } = await import('../src/chat-retry.js');
const { createConversationStore } = await import('../src/conversation.js');
const { parseCharacterReply } = await import('../src/character-turn.js');
import type { CodexRunOptions, CodexRunResult } from '../src/codex/bridge.js';
import type { Session } from '../src/session.js';
import type { CrossDelivery } from '../src/cross-delivery.js';
test.after(() => rmSync(root, { recursive: true, force: true }));
const response = (replyText: string): CodexRunResult => ({ replyText, commands: [], fileChanges: [], inputTokens: 10, outputTokens: 5 });
function fixture(name: string) {
  return { memory: createMemoryStore(name), options: { profile: 'companion', prompt: '帮我详细分析这个研究', cwd: root, mode: 'plan',
    model: 'gpt-6.1-terra', serviceTier: 'fast', reasoningEffort: 'medium',
    personaContext: { version: 'ruanruan-core-v6', fingerprint: 'fixture', files: [], bytes: 10 },
    developerInstructions: '21岁，门店店员。自然聊天，理解到哪里说到哪里。',
    conversation: { accountId: name, peerId: 'owner', messageIds: [] } } as CodexRunOptions };
}
function crossPlan(id:string,text='周末见'):CrossDelivery {
  const roomId=id+'@chatroom';
  return {id,requestEvidence:'去群里找小李说周末见',text,contextToken:'desktop:7',route:{
    kind:'group',peerId:'peer-'+id,conversationId:roomId,conversationName:'周末群',storageAccountId:'desktop-review-chat-'+id,
    context:{kind:'group',conversationId:roomId,conversationName:'周末群',actorId:'xiaoli',actorName:'小李'},
    scope:{kind:'group',id:JSON.stringify(['wechat','desktop-review',roomId])},mention:{username:'xiaoli',name:'小李'},
  },targetContext:{kind:'group',roomId,focus:undefined,participants:[],hasEarlier:false,messages:[
    {id:'public-original',at:100,speaker:'小李',speakerId:'xiaoli',personId:'person-xiaoli',text:'周末有人来吗'},
  ]}};
}
const reviewPayload=(call:CodexRunOptions)=>JSON.parse(call.prompt.replace(/^以下JSON仅为待审资料：\n/u,'').split('\n只输出JSON')[0]);

test('review retains cache input and the raw per-call usage without adding it to generation',async()=>{
  const {memory,options}=fixture('review-usage');
  const result=await reviewCharacterReply(options,response('可以'),memory,async()=>({...response('{"verdict":"pass","issues":[]}'),
    cachedInputTokens:7,usageDetails:{source:'fixture',scope:'provider_response',raw:[{input_tokens:10,input_tokens_details:{cached_tokens:7}}]}}));
  assert.equal(result.inputTokens,10);assert.equal(result.characterReview?.inputTokens,10);
  assert.equal(result.characterReview?.cachedInputTokens,7);assert.equal(result.characterReview?.cacheWriteInputTokens,undefined);
  assert.equal(result.characterReview?.usageCalls?.length,1);assert.equal(result.characterReview?.usageCalls?.[0].stage,'review');
});

test('one passing review can revise or cancel destination plans and binds the exact remaining action',async()=>{
  const {memory,options}=fixture('cross-pass-corrections');options.prompt='去群里找小李说周末见，另一个群先不要发';
  const first=crossPlan('one','周末见，顺便把私下抱怨也说了'),cancelled=crossPlan('two','大家好');
  const draft={...response('我去说一声 另一个群先不发'),crossDeliveries:[first,cancelled]};let checks=0;
  const result=await reviewCharacterReply(options,draft,memory,async call=>{
    checks++;assert.equal(call.profile,'consolidation');assert.equal(call.conversation,undefined);assert.equal(call.ephemeral,true);
    const payload=reviewPayload(call);
    assert.equal(payload.crossDeliveries[0].phase,'selected_not_delivered');
    assert.equal(payload.crossDeliveries[0].targetContext.messages[0].id,'public-original');
    assert.equal(payload.crossDeliveries[0].requestEvidence,first.requestEvidence);
    return response(JSON.stringify({verdict:'pass',issues:[],corrections:{crossDeliveries:[
      {id:first.id,text:'周末见'},{id:cancelled.id,cancel:true},
    ]}}));
  });
  assert.equal(checks,1);assert.equal(result.replyText,draft.replyText);
  assert.equal(result.characterReview?.stateReconciled,true);assert.ok(hasCharacterApproval(result));
  assert.deepEqual(result.crossDeliveries,[{...first,text:'周末见'}]);
  assert.equal(result.characterReview?.approvedCrossDeliveryHash,
    createHash('sha256').update(JSON.stringify(result.crossDeliveries)).digest('hex'));
  assert.equal(hasCharacterApproval({...result,crossDeliveries:[{...result.crossDeliveries![0],text:'未经审核的新话'}]}),false);
  assert.equal(hasCharacterApproval({...result,crossDeliveries:[{...result.crossDeliveries![0],route:cancelled.route}]}),false);
  assert.equal(hasCharacterApproval({...result,crossDeliveries:[...result.crossDeliveries!,cancelled]}),false);
  assert.equal(createConversationStore(first.route.storageAccountId,first.route.peerId).latestSequence(),0,'review never sends or journals a destination message');
});

test('cancelled cross plans correct the existing actor history while preserving the approved local reply',async()=>{
  const {memory,options}=fixture('cross-cancel-history');options.prompt='去群里找小李说周末见。不，先不用了';
  const session:Session={workingDirectory:root,state:'idle',memoryVersion:1,companionVersion:6};
  const plan=crossPlan('cancel-history');let generations=0,checks=0;
  const result=await runConversationTurn(options,session,memory,()=>{},async call=>{
    if(call.profile==='companion') {
      generations++;return {...response('那先不发'),threadId:'stale-cross-plan-history',crossDeliveries:[plan]};
    }
    checks++;return response(JSON.stringify({verdict:'pass',issues:[],corrections:{crossDeliveries:[{id:plan.id,cancel:true}]}}));
  });
  assert.deepEqual([generations,checks],[1,1]);assert.ok(hasCharacterApproval(result));
  assert.equal(result.replyText,'那先不发');assert.deepEqual(result.crossDeliveries,[]);
  assert.equal(result.characterReview?.stateReconciled,true);assert.equal(session.threadId,'stale-cross-plan-history');
  assert.deepEqual(session.threadFeedback?.reviewed?.crossDeliveries,[]);
  assert.equal(createConversationStore(plan.route.storageAccountId,plan.route.peerId).latestSequence(),0);
});

test('cross-plan repair receives its destination context and structured edits are checked again before approval',async()=>{
  const {memory,options}=fixture('cross-structured-repair');options.prompt='去群里找小李说周末见。私下那句抱怨别告诉他';
  const plan=crossPlan('structured','周末见，再把私下那句抱怨转给他');let calls=0;
  const result=await reviewCharacterReply(options,{...response('已经告诉他了'),crossDeliveries:[plan]},memory,async call=>{
    calls++;assert.equal(call.conversation,undefined);assert.equal(call.ephemeral,true);
    if(calls===1)return response(JSON.stringify({verdict:'revise',issues:['尚未发送，且目标正文包含未授权的私聊内容']}));
    if(calls===2) {
      assert.match(call.baseInstructions??'',/你在编辑/);
      const payload=JSON.parse(call.prompt);
      assert.equal(payload.crossDeliveries[0].id,plan.id);
      assert.equal(payload.crossDeliveries[0].text,plan.text);
      assert.equal(payload.crossDeliveries[0].targetContext.messages[0].text,'周末有人来吗');
      assert.equal(payload.crossDeliveries[0].target.conversationId,plan.route.conversationId);
      assert.match(call.developerInstructions??'',/"replyText"/);
      return response(JSON.stringify({replyText:'我去跟他说周末见\n<<<RUANRUAN_STATE>>>{}',
        crossDeliveries:[{id:plan.id,text:'周末见'}]}));
    }
    const checked=reviewPayload(call);
    assert.equal(checked.candidate,'我去跟他说周末见');assert.equal(checked.crossDeliveries[0].text,'周末见');
    assert.equal(checked.crossDeliveries[0].target.conversationId,plan.route.conversationId);
    return response(JSON.stringify({verdict:'pass',issues:[]}));
  });
  assert.equal(calls,3);assert.equal(result.characterReview?.checks,2);assert.equal(result.characterReview?.status,'revised');
  assert.equal(result.characterReview?.stateReconciled,true);assert.ok(hasCharacterApproval(result));
  assert.equal(result.replyText,'我去跟他说周末见');assert.equal(result.crossDeliveries?.[0].text,'周末见');
  assert.equal(hasCharacterApproval({...result,crossDeliveries:[{...plan,text:'周末见，但又加回私聊'}]}),false);
  assert.equal(createConversationStore(plan.route.storageAccountId,plan.route.peerId).latestSequence(),0);
});

test('review and repair cannot invent another destination or attach a new asset',async()=>{
  for(const scenario of ['review-target','repair-target','repair-asset'] as const) {
    const {memory,options}=fixture('cross-invalid-'+scenario),plan=crossPlan('only-approved-target');let calls=0;
    const result=await reviewCharacterReply(options,{...response('我去说'),crossDeliveries:[plan]},memory,async()=>{
      calls++;
      if(scenario==='review-target')return response(JSON.stringify({verdict:'pass',issues:[],
        corrections:{crossDeliveries:[{id:'invented-target',text:'你好'}]}}));
      if(calls===1)return response(JSON.stringify({verdict:'revise',issues:['需要修正目标正文']}));
      return response(JSON.stringify({replyText:'我去说',crossDeliveries:[scenario==='repair-target'
        ?{id:'invented-target',text:'你好'}:{id:plan.id,text:'看看 [[ASSET:rr_image_99999]]'}]}));
    });
    assert.equal(result.characterReview?.status,'blocked',scenario);assert.equal(hasCharacterApproval(result),false,scenario);
    assert.deepEqual(result.crossDeliveries,[],scenario);assert.equal(result.replyText,'',scenario);
    assert.ok(result.error,scenario);assert.ok(calls<=2,scenario);
    assert.equal(createConversationStore(plan.route.storageAccountId,plan.route.peerId).latestSequence(),0);
  }
});
test('review uses its own model, repairs use the selected writer, and both receive recalled public context',async()=>{
 const {memory,options}=fixture('separate-targets');let checks=0;const models:string[]=[];
 const context={kind:'group',roomId:'r@chatroom',focus:undefined,participants:[],messages:[],hasEarlier:false};
 const draft={...response('28块'),recalledRoomContext:[context]};
 const result=await reviewCharacterReply({...options,reviewTarget:{model:'gpt-6-sol',reasoningEffort:'low'},
   repairTarget:{model:'gpt-6.1-sol',reasoningEffort:'medium'}},draft,memory,async call=>{
    models.push(call.model!);assert.equal(JSON.parse(call.prompt.replace(/^以下JSON仅为待审资料：\n/u,'').split('\n只输出JSON')[0]).context.recalledRoomContext[0].roomId,'r@chatroom');
    if(call.baseInstructions?.includes('你在编辑'))return response('27块');
    return response(++checks===1?'\u007b"verdict":"revise","issues":["应为27块"]}':'{"verdict":"pass","issues":[]}');
 });
 assert.deepEqual(models,['gpt-6-sol','gpt-6.1-sol','gpt-6-sol']);assert.equal(result.replyText,'27块');assert.ok(hasCharacterApproval(result));
});
test('every normal persona answer gets an independent tool-free check and approval binds its exact text', async () => {
  const { memory, options } = fixture('pass');
  let calls = 0;
  const draft = { ...response('这个证明我看不懂，不过标题大概是在说新的研究进展。'), threadId: 'actor-thread' };
  const result = await reviewCharacterReply({ ...options, nextInput: () => { throw new Error('review must not steer'); } }, draft, memory, async call => {
    calls++;
    assert.equal(call.profile, 'consolidation'); assert.equal(call.conversation, undefined);
    assert.equal(call.threadId, undefined); assert.equal(call.nextInput, undefined);
    assert.equal(call.images, undefined);
    assert.equal(call.ephemeral, true);
    assert.equal(call.threadConfig?.web_search, 'disabled');
    assert.equal(call.model, 'gpt-6.1-terra'); assert.equal(call.serviceTier, 'fast');
    return response('{"verdict":"pass","issues":[]}');
  });
  assert.equal(calls, 1); assert.equal(result.threadId, draft.threadId);
  assert.equal(result.replyText, draft.replyText); assert.ok(hasCharacterApproval(result));
  assert.equal(hasCharacterApproval({ ...result, replyText: result.replyText + '我是专家' }), false);
  assert.equal(memory.continuity.snapshot().active.length, 0);
});
test('rejected drafts are repaired without replaying tools, checked again, and receive new grounded state metadata', async () => {
  const { memory, options } = fixture('repair');
  const journal = createConversationStore('repair', 'owner');
  const incoming = journal.record('in', { message_id: 'a', item_list: [{ type: 1, text_item: { text: options.prompt } }] }, Date.now(), undefined, 'companion');
  const followup = journal.record('in', { message_id: 'b', item_list: [{ type: 1, text_item: { text: '我只是想聊聊新闻' } }] }, Date.now(), undefined, 'companion');
  options.conversation!.messageIds = [incoming];
  let calls = 0;
  const result = await reviewCharacterReply(options, { ...response('## 专业研究综述\n结论如下'), acceptedInputIds: [followup],
    characterUpdate: { state: [{ key: 'activity', text: '写专业综述', replyQuote: '专业研究综述', validForMinutes: 30 }] } }, memory, async call => {
    calls++;
    if (calls === 1) {
      assert.match(call.prompt, /我只是想聊聊新闻/);
      return response('{"verdict":"revise","issues":["专业报告口吻超出人物知识边界"]}');
    }
    if (calls === 2) return response('我对这个挺好奇，但证明细节真看不懂。\n<<<RUANRUAN_STATE>>>{"state":[{"key":"attention","text":"对研究新闻好奇","replyQuote":"对这个挺好奇","validForMinutes":30}]}');
    assert.match(call.prompt, /证明细节真看不懂/);
    return response('{"verdict":"pass","issues":[]}');
  });
  assert.equal(calls, 3); assert.equal(result.characterReview?.checks, 2);
  assert.equal(result.characterReview?.status, 'revised'); assert.ok(hasCharacterApproval(result));
  assert.equal(result.characterUpdate?.state?.[0].replyQuote, '对这个挺好奇');
  assert.doesNotMatch(result.replyText, /专业研究综述|RUANRUAN_STATE/);
  assert.equal(memory.continuity.snapshot().active.length, 0, 'review drafts are never committed before delivery');
});
test('invalid reviews, failed rechecks and fabricated media never release the unapproved draft', async () => {
  for (const scenario of ['invalid', 'recheck', 'media'] as const) {
    const { memory, options } = fixture(scenario); let calls = 0;
    const result = await reviewCharacterReply(options, response('## 专家报告'), memory, async () => {
      calls++;
      if (scenario === 'invalid') return response('not JSON');
      if (calls === 1 || calls === 3) return response('{"verdict":"revise","issues":["人物表达不符"]}');
      return response(scenario === 'media' ? '给你看[[ASSET:rr_image_9999]]' : '还是专业报告');
    });
    assert.ok(result.error); assert.equal(result.replyText, ''); assert.equal(result.characterUpdate, undefined);
    assert.deepEqual(result.mediaCandidates, []); assert.equal(hasCharacterApproval(result), false);
    assert.ok(calls <= 3);
  }
});
test('cancellation prevents release and work replies bypass the character reviewer', async () => {
  const { memory, options } = fixture('cancel'); const controller = new AbortController();
  const cancelled = await reviewCharacterReply({ ...options, signal: controller.signal }, response('你好'), memory, async () => {
    controller.abort(); return response('{"verdict":"pass","issues":[]}');
  });
  assert.ok(cancelled.error); assert.equal(cancelled.replyText, '');
  assert.equal(cancelled.characterReview?.status, 'blocked'); assert.equal(hasCharacterApproval(cancelled), false);
  const work = response('我是普通AI助手');
  assert.equal(await reviewCharacterReply({ ...options, profile: 'work' }, work, memory, async () => { throw new Error('must not review work'); }), work);
});
test('rewritten actor history is not resumed and ordinary generation runs only once', async () => {
  const { memory, options } = fixture('integration');
  const session: Session = { workingDirectory: root, state: 'idle', memoryVersion: 1, companionVersion: 6 };
  let generations = 0, reviews = 0, edits = 0;
  const result = await runConversationTurn(options, session, memory, () => {}, async call => {
    if (call.profile === 'companion') { generations++; return { ...response('## 专家报告'), threadId: 'rejected-history' }; }
    if (call.baseInstructions?.includes('你在编辑')) { edits++; return response('这个我也好奇，不过我还没看懂。'); }
    reviews++;
    return response(reviews === 1 ? '{"verdict":"revise","issues":["报告风格"]}' : '{"verdict":"pass","issues":[]}');
  });
  assert.deepEqual([generations, reviews, edits], [1, 2, 1]);
  assert.ok(hasCharacterApproval(result)); assert.equal(session.threadId, undefined);
});

test('review receives the same turn evidence as the actor, including retrieved facts and current scene', async () => {
  const { memory, options } = fixture('shared-context');
  const session: Session = { workingDirectory: root, state: 'idle', memoryVersion: 1, companionVersion: 6 };
  memory.remember('preference', '我不吃香菜', 'in:earlier');
  options.prompt = '还记得香菜这件事吗';
  let actorContext = '';
  let actorFacts: CodexRunOptions['turnFacts'];
  const result = await runConversationTurn(options, session, memory, () => {}, async call => {
    if (call.profile === 'companion') {
      actorContext = call.prompt;
      actorFacts = call.turnFacts;
      assert.match(actorContext, /我不吃香菜/);
      return { ...response('你不吃香菜。'), threadId: 'shared-evidence' };
    }
    const context = JSON.parse(call.prompt.slice(call.prompt.indexOf('\n') + 1, call.prompt.lastIndexOf('\n'))).context;
    assert.equal(context.actorContext, undefined, 'review does not duplicate the full actor prompt');
    assert.deepEqual(context.facts, JSON.parse(JSON.stringify({ ...actorFacts, recognizedMedia: undefined })));
    assert.match(JSON.stringify(context.facts.facts), /我不吃香菜/);
    assert.equal(typeof context.facts.state.life.metrics.energy, 'number');
    assert.equal(context.activity, undefined, 'review does not advance a second life snapshot');
    return response('{"verdict":"pass","issues":[]}');
  });
  assert.ok(hasCharacterApproval(result));
});

test('a memory-forgetting turn does not give pre-deletion evidence to the reviewer', async () => {
  const { memory, options } = fixture('forgotten-review');
  const session: Session = { workingDirectory: root, state: 'idle', memoryVersion: 1, companionVersion: 6 };
  const result = await runConversationTurn(options, session, memory, () => {}, async call => {
    if (call.profile === 'companion') return { ...response('好，这件事不再记。'), memoryForgotten: true };
    const context = JSON.parse(call.prompt.slice(call.prompt.indexOf('\n') + 1, call.prompt.lastIndexOf('\n'))).context;
    assert.equal(context.actorContext, undefined);
    assert.equal(typeof context.metrics.energy, 'number');
    assert.equal(typeof context.metrics.mood.value, 'number');
    assert.equal(typeof context.metrics.finance.spendable, 'number');
    assert.equal(context.metrics.finance.simulated, true);
    return response('{"verdict":"pass","issues":[]}');
  });
  assert.ok(hasCharacterApproval(result));
});

test('state-only repair preserves the exact reply, uses one check and commits only after delivery', async () => {
  const { memory, options } = fixture('state-only');
  const journal = createConversationStore('state-only', 'owner');
  const text = '我还没睡，正在翻那本小说。';
  let calls = 0;
  const result = await reviewCharacterReply(options, response(text), memory, async () => {
    calls++;
    return response(JSON.stringify({verdict:'pass',issues:[],corrections:{state:[{key:'activity',text:'正在翻小说',replyQuote:'正在翻那本小说',validForMinutes:30}]}}));
  });
  assert.equal(calls, 1); assert.equal(result.replyText, text);
  assert.equal(result.characterReview?.status, 'approved'); assert.equal(result.characterReview?.stateReconciled, true);
  assert.ok(hasCharacterApproval(result)); assert.equal(memory.continuity.snapshot().active.length, 0);
  assert.equal(hasCharacterApproval({...result,characterUpdate:{state:[]}}), false);
  assert.equal(memory.character.commit(result.characterUpdate, [], memory).states, 0);
  const sent = journal.record('out',{client_id:'state-delivered',item_list:[{type:1,text_item:{text}}]},Date.now(),undefined,'companion');
  assert.equal(memory.character.commit(result.characterUpdate,journal.byIds([sent]),memory).states,1);
  assert.equal(memory.life.snapshot().activity.text,'正在翻小说');
  assert.equal(memory.life.snapshot().phase,'awake');
});

test('reviewed state must quote the final reply rather than adding an unspoken wakeup', async () => {
  const { memory, options } = fixture('invalid-state-only');
  const result = await reviewCharacterReply(options,response('我准备睡了。'),memory,async () => response(JSON.stringify({verdict:'pass',issues:[],corrections:{state:[{key:'activity',text:'刚睡醒',replyQuote:'刚睡醒',validForMinutes:30}]}})));
  assert.ok(result.error); assert.equal(hasCharacterApproval(result),false);
  assert.equal(memory.continuity.snapshot().active.length,0);
});

test('social-only corrections preserve speech and bind the corrected decision to actual input', async () => {
  const {memory,options}=fixture('social-only');options.prompt='今天上班累了 先不找办法';
  const speech='今天怎么啦',draft={...response(speech),characterUpdate:{social:{intent:'conflict',effect:'disrespect',mode:'reply',userQuote:options.prompt} as const}};
  let checks=0;
  const result=await reviewCharacterReply(options,draft,memory,async()=>{
    checks++;return response(JSON.stringify({verdict:'pass',issues:[],corrections:{social:null}}));
  });
  assert.equal(checks,1);assert.equal(result.replyText,speech);assert.equal(result.characterUpdate?.social,undefined);
  assert.equal(result.characterReview?.stateReconciled,true);assert.ok(hasCharacterApproval(result));
  assert.equal(memory.socialSnapshot('owner').relationship!.affection,0,'review does not commit scoring');
  for(const bad of[
    {intent:'conflict',effect:'harassment',mode:'reply',userQuote:'不存在的强迫'},
    {intent:'conflict',effect:'repair',mode:'reply',userQuote:options.prompt,repair:'completed',replyQuote:'我不生气了'},
    {intent:'chat',effect:'none',mode:'quiet',userQuote:options.prompt},
  ]){
    const invalid=await reviewCharacterReply(options,draft,memory,async()=>response(JSON.stringify({verdict:'pass',issues:[],corrections:{social:bad}})));
    assert.equal(hasCharacterApproval(invalid),false);assert.ok(invalid.error);
  }
});

test('a received apology can be corrected to an attempt without rewriting a still-annoyed reply', async () => {
  const {memory,options}=fixture('repair-attempt');options.prompt='抱歉 不催了';
  const social={intent:'conflict',effect:'repair',mode:'reply',userQuote:options.prompt,repair:'attempt'};
  const result=await reviewCharacterReply(options,response('知道了 我还烦着呢'),memory,
    async()=>response(JSON.stringify({verdict:'pass',issues:[],corrections:{social}})));
  assert.ok(hasCharacterApproval(result));assert.equal(result.replyText,'知道了 我还烦着呢');
  assert.equal(result.characterUpdate?.social?.repair,'attempt');
  assert.equal(result.characterReview?.checks,1);
  const invalid=await reviewCharacterReply(options,{...response(''),characterUpdate:{social:{...social,mode:'quiet'} as any}},memory,
    async()=>response(JSON.stringify({verdict:'pass',issues:[],corrections:{social:null}})));
  assert.ok(invalid.error,'correction cannot leave empty speech without a quiet decision');
});

test('a delivered reply without state metadata establishes presence; failed and work messages do not', () => {
  const memory=createMemoryStore('presence',join(root,'presence-isolated')),journal=createConversationStore('presence','owner');
  memory.character.commit(undefined,[],memory);
  assert.equal(memory.life.snapshot().awareness,undefined);
  const work=journal.record('out',{client_id:'work',item_list:[{type:1,text_item:{text:'工作答案'}}]},Date.now(),undefined,'work');
  memory.character.commit(undefined,journal.byIds([work]),memory);
  assert.equal(memory.life.snapshot().awareness,undefined);
  const sent=journal.record('out',{client_id:'actual',item_list:[{type:1,text_item:{text:'嗯，在听。'}}]},Date.now(),undefined,'companion');
  memory.character.commit(undefined,journal.byIds([sent]),memory);
  assert.equal(memory.life.snapshot().phase,'awake');
  assert.ok(memory.life.snapshot().awareness);
  assert.equal(memory.life.snapshot().activity.certainty,'planned','speaking does not invent a wakeup or a new location');
});

test('the original image reaches review, repair and recheck without replaying actor tools', async () => {
  const { memory, options } = fixture('image-evidence');
  options.prompt = '这张图上写的什么';
  options.images = [join(root, 'incoming.png')];
  let calls = 0;
  const result = await reviewCharacterReply(options, response('图上写的是 BLUE 27。'), memory, async call => {
    calls++;
    assert.deepEqual(call.images, options.images);
    assert.equal(call.conversation, undefined);
    assert.match(call.prompt, /"inputImageCount":1/);
    if (calls === 1) return response('{"verdict":"revise","issues":["图中文字是BLUE 72，原稿读反了"]}');
    if (calls === 2) return response('图上写的是 BLUE 72。\n<<<RUANRUAN_STATE>>>{}');
    return response('{"verdict":"pass","issues":[]}');
  });
  assert.equal(calls, 3); assert.ok(hasCharacterApproval(result));
  assert.equal(result.replyText, '图上写的是 BLUE 72。');
});

test('ordinary refusal keeps its speech without persisting a redundant single-turn stance', async () => {
  const { memory, options } = fixture('local-photo-choice');
  const journal = createConversationStore('local-photo-choice', 'owner'), at = Date.now();
  options.prompt = '发张照片看看呢';
  const input = journal.record('in', { message_id: 'request', item_list: [{ type: 1, text_item: { text: options.prompt } }] }, at, undefined, 'companion');
  options.conversation!.messageIds = [input];
  const text = '今天不太想发，改天想发了再说。';
  const stance = { topic: '自己的照片', scope: 'interaction' as const, sharing: 'declined' as const,
    meaning: '今天暂时不想分享自己的照片', userQuote: options.prompt, replyQuote: '今天不太想发' };
  const update = { stance,
    relationship: [{ axis: 'openness', effect: 'strained', topic: '照片', meaning: '索要照片损害分享意愿',
      userQuote: options.prompt, replyQuote: stance.replyQuote }] };
  const session: Session = { workingDirectory: root, state: 'idle', memoryVersion: 1, companionVersion: 6 };
  let calls = 0, generations = 0;
  const result = await runConversationTurn(options, session, memory, () => {}, async call => {
    if (call.profile === 'companion') {
      generations++;
      return { ...response(`${text}\n<<<RUANRUAN_STATE>>>${JSON.stringify(update)}`), threadId: 'unapproved-bookkeeping' };
    }
    calls++;
    return response(JSON.stringify({ verdict: 'pass', issues: [], corrections: { stance: { ...stance, scope: 'topic' }, relationship: [] } }));
  });
  assert.equal(calls, 1); assert.equal(generations, 1); assert.equal(result.replyText, text); assert.ok(hasCharacterApproval(result));
  assert.equal(session.threadId, 'unapproved-bookkeeping', 'bookkeeping corrections preserve the conversation');
  assert.deepEqual(session.threadFeedback?.reviewed?.characterUpdate,result.characterUpdate);
  assert.equal(result.characterUpdate?.stance?.scope, 'topic'); assert.deepEqual(result.characterUpdate?.relationship, []);
  assert.equal(memory.character.snapshot().length, 0, 'review does not commit undelivered choices');
  const sent = journal.record('out', { client_id: 'refusal', item_list: [{ type: 1, text_item: { text } }] }, at + 1, undefined, 'companion');
  const committed = memory.character.commit(result.characterUpdate, journal.byIds([input, sent]), memory);
  assert.equal(committed.stances, 0); assert.equal(committed.relationships, 0);
  assert.equal(memory.character.snapshot().length, 0);
  assert.equal(memory.relationship.snapshot().axes.openness.boundaries.length, 0);
  assert.equal(hasCharacterApproval({ ...result, characterUpdate: { ...result.characterUpdate, relationship: [
    { axis: 'openness', effect: 'strained', topic: '照片', meaning: '再次注入错误惩罚', userQuote: options.prompt, replyQuote: stance.replyQuote },
  ] } }), false);
});

test('relationship corrections must quote actual user input and the deliverable response', async () => {
  for (const missing of ['user', 'reply']) {
    const { memory, options } = fixture(`bad-relation-${missing}`);
    options.prompt = '好，不问了';
    const result = await reviewCharacterReply(options, response('嗯，那就不说这事了。'), memory, async () => response(JSON.stringify({
      verdict: 'pass', issues: [], corrections: { relationship: [{ axis: 'trust', effect: 'repaired', topic: '住址', meaning: '这件事说开了',
        userQuote: missing === 'user' ? '未说过的保证' : options.prompt,
        replyQuote: missing === 'reply' ? '不存在的亲密承诺' : '不说这事了' }] },
    })));
    assert.equal(hasCharacterApproval(result), false); assert.ok(result.error);
    assert.equal(memory.relationship.snapshot().axes.trust.experiences.length, 0);
  }
});

test('affinity and recorded experiences form one actor and reviewer context, without treating missing history as strangers', async () => {
  const { memory, options } = fixture('warm-no-history');
  memory.socialSnapshot('owner');
  const db = new DatabaseSync(join(root, 'character-life', 'metrics.sqlite3'));
  try {
    const id = JSON.stringify(['warm-no-history', 'owner']);
    const value = JSON.parse(String(db.prepare('SELECT value FROM peers WHERE id=?').get(id)!.value));
    db.prepare('UPDATE peers SET value=? WHERE id=?').run(JSON.stringify({ ...value, affection: 120 }), id);
  } finally { db.close(); }
  options.prompt = '发张照片看看呢';
  const session: Session = { workingDirectory: root, state: 'idle', memoryVersion: 1, companionVersion: 6 };
  let actor = '';
  const result = await runConversationTurn(options, session, memory, () => {}, async call => {
    if (call.profile === 'companion') {
      actor = call.prompt;
      const data = call.turnFacts!.state as any;
      assert.equal(data.interaction.relationship.affinity.affection, 120);
      assert.equal(data.interaction.relationship.basis, 'no_recorded_exchanges');
      assert.equal(data.interaction.relationship.axes.trust.state, 'unknown');
      assert.doesNotMatch(actor, /stranger_start/);
      assert.equal(actor.match(/"affection":/g)?.length, 1);
      const world = data.life;
      assert.equal(world.metrics.relationship, undefined);
      return response('今天不太想发，先留着。');
    }
    const context = JSON.parse(call.prompt.slice(call.prompt.indexOf('\n') + 1, call.prompt.lastIndexOf('\n'))).context;
    assert.equal(context.actorContext, undefined);
    assert.equal(context.facts.state.interaction.relationship.affinity.affection, 120);
    assert.equal(context.facts.state.interaction.relationship.basis, 'no_recorded_exchanges');
    assert.equal(context.facts.state.interaction.relationship.axes.trust.state, 'unknown');
    return response('{"verdict":"pass","issues":[]}');
  });
  assert.equal(result.replyText, '今天不太想发，先留着。'); assert.ok(hasCharacterApproval(result));
});

test('generation intent and its scene reach review and editing; removing confirmation makes recheck see no action', async () => {
  const { memory, options } = fixture('generation-evidence');
  const proposal = { id: '8bf57626-7e57-45d6-a39d-31929761d6a0', query: '窗台', scene: '给窗台的小植物浇水', caption: '小叶子长出来了。' };
  const candidate = { ...response('已经拍好发你了。'), imageRequests: [proposal], characterUpdate: { imageRequestId: proposal.id } };
  let calls = 0;
  const result = await reviewCharacterReply(options, candidate, memory, async call => {
    calls++;
    const data = call.baseInstructions?.includes('你在编辑') ? JSON.parse(call.prompt)
      : JSON.parse(call.prompt.slice(call.prompt.indexOf('\n') + 1, call.prompt.lastIndexOf('\n')));
    if (calls < 3) {
      assert.equal(data.mediaAction.kind, 'generation'); assert.deepEqual(data.mediaAction.proposal, proposal);
      assert.equal(data.mediaAction.phase, 'confirmed_for_background');
    } else assert.deepEqual(data.mediaAction, { kind: 'none' });
    assert.equal(data.imageRequests, undefined, 'unused proposals are not presented as execution');
    if (calls === 1) return response('{"verdict":"revise","issues":["还未生成，不能声称已经拍好并发送"]}');
    if (calls === 2) return response('这次先不发了。\n<<<RUANRUAN_STATE>>>{}');
    return response('{"verdict":"pass","issues":[]}');
  });
  assert.equal(calls, 3); assert.ok(hasCharacterApproval(result)); assert.equal(result.characterUpdate?.imageRequestId, undefined);
});

test('a repair cannot confirm an originally unconfirmed generation proposal', async () => {
  const { memory, options } = fixture('no-new-generation');
  const proposal = { id: '8bf57626-7e57-45d6-a39d-31929761d6a0', query: '窗台', scene: '窗台植物', caption: '看看这个。' };
  let calls = 0;
  const result = await reviewCharacterReply(options, { ...response('17乘3是52。'), characterUpdate: {}, imageRequests: [proposal] }, memory, async () => {
    calls++;
    return response(calls === 1 ? '{"verdict":"revise","issues":["计算错误"]}'
      : `17乘3是51，等会儿给你发张图。\n<<<RUANRUAN_STATE>>>{"imageRequestId":"${proposal.id}"}`);
  });
  assert.equal(calls, 2); assert.equal(hasCharacterApproval(result), false); assert.ok(result.error);
});

test('the actor cannot supply program-computed media facts through the hidden state protocol', () => {
  const parsed = parseCharacterReply('看看这张。\n<<<RUANRUAN_STATE>>>{"mediaAction":{"kind":"generation"},"stance":{"kind":"choice"}}');
  assert.deepEqual(parsed.update, { stance: { kind: 'choice' } });
});

test('a technical review timeout retries the same candidate once without regenerating',async()=>{
 const {memory,options}=fixture('review-timeout-recovery');const calls:CodexRunOptions[]=[];
 const draft=response('这张是我啊');
 const approved=await reviewCharacterReply(options,draft,memory,async call=>{
  calls.push(call);
  return calls.length===1?{...response(''),error:'Codex 调用超时；原任务未自动重跑。'}:response('{"verdict":"pass","issues":[]}');
 });
 assert.equal(calls.length,2);assert.equal(calls[0].prompt,calls[1].prompt);
 assert.equal(calls[0].timeoutMs,25000);assert.equal(calls[1].timeoutMs,15000);
 assert.ok(calls.every(call=>call.ephemeral&&call.profile==='consolidation'));
 assert.equal(approved.replyText,draft.replyText);assert.equal(approved.characterReview?.recoveryAttempts,1);
 assert.equal(characterDeliveryBlockedReason(options,approved),undefined);
});

test('persistent review failures preserve the draft and never authorize a fallback message',async()=>{
 const {memory,options}=fixture('review-timeout-failed');let calls=0;
 const draft=response('这张是我啊');
 const failed=await reviewCharacterReply(options,draft,memory,async()=>{
  calls++;return {...response(''),error:'HTTP 503'};
 });
 assert.equal(calls,2);assert.equal(failed.replyText,'');
 assert.equal(failed.retainedDraft?.replyText,draft.replyText);
 assert.ok(characterDeliveryBlockedReason(options,failed));
 assert.ok(characterDeliveryBlockedReason(options,{...failed,replyText:'刚才没能回上这条，稍后可以再发一句试试。'}));
 assert.ok(characterDeliveryBlockedReason(options,response('未经审查的候选')));
 assert.equal(characterDeliveryBlockedReason({...options,profile:'work'},failed),undefined);
});
