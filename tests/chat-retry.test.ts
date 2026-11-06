import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root=mkdtempSync(join(tmpdir(),'chat-retry-suite-'));
process.env.WCB_DATA_DIR=root;
const { createMemoryStore } = await import('../src/memory.js');
const { createConversationStore } = await import('../src/conversation.js');
const { runConversationTurn } = await import('../src/chat-retry.js');
const { hasUnconsumedChatInput } = await import('../src/jobs.js');
test.after(()=>rmSync(root,{recursive:true,force:true}));
import type { CodexRunOptions, CodexRunResult } from '../src/codex/bridge.js';
import type { Session } from '../src/session.js';

const capacity = 'Selected model is at capacity. Please try a different model.';
const result = (error?: string): CodexRunResult => ({ error, replyText: '', commands: [], fileChanges: [] });
function fixture(t: any) {
  const accountId = `chat-retry-${randomUUID()}`, peerId = 'owner';
  const memory = createMemoryStore(accountId), journal = createConversationStore(accountId, peerId);
  t.after(() => { rmSync(memory.dir, { recursive: true, force: true }); rmSync(journal.path, { force: true }); });
  const session: Session = { workingDirectory: '/tmp', state: 'idle', threadId: 'old-thread', memoryVersion: 1, companionVersion: 5 };
  const options: CodexRunOptions = { prompt: '周六钓什么鱼', cwd: '/tmp', mode: 'plan', model: 'gpt-6.1-terra',
    reasoningEffort: 'low', serviceTier: 'fast', profile: 'companion', conversation: { accountId, peerId } };
  return { memory, journal, session, options };
}

test('capacity recovery starts one fresh Terra thread with actual history, relevant memory and accepted followups', async t => {
  const { memory, journal, session, options } = fixture(t);
  memory.remember('fish', '周六钓鲫鱼，用玉米', 'in:remember', Date.now());
  const news = journal.record('out', { client_id: 'news', item_list: [{ type: 1, text_item: { text: '今天整理的新闻里提到了城市数字化' } }] }, Date.now(), undefined, 'companion');
  const input = journal.record('in', { message_id: 'question', item_list: [{ type: 1, text_item: { text: options.prompt } }] }, Date.now(), undefined, 'companion');
  const followup = journal.record('in', { message_id: 'followup', item_list: [{ type: 1, text_item: { text: '用什么鱼饵呢' } }] }, Date.now(), undefined, 'companion');
  journal.markSeen('old-thread', [news, followup]);
  options.conversation!.messageIds = [input];
  const calls: CodexRunOptions[] = [];
  const events: any[] = []; options.onEvent = event => events.push(event);
  const answer = await runConversationTurn(options, session, memory, () => {}, async call => {
    calls.push(call);
    return calls.length === 1
      ? { ...result(capacity), threadId: 'old-thread', acceptedInputIds: [followup], timing: { elapsedMs: 20 } }
      : { ...result(), threadId: 'new-thread', replyText: '鲫鱼，用玉米呀', timing: { elapsedMs: 30, firstTokenMs: 10 } };
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].threadId, 'old-thread'); assert.equal(calls[1].threadId, undefined);
  for (const call of calls) { assert.equal(call.model, 'gpt-6.1-terra'); assert.equal(call.serviceTier, 'fast'); }
  assert.match(calls[1].prompt, /周六钓鲫鱼[，,]用玉米/);
  assert.match(calls[1].prompt, /今天整理的新闻里提到了城市数字化/);
  assert.match(calls[1].currentUser!, /周六钓什么鱼[\s\S]*用什么鱼饵呢/);
  assert.deepEqual(calls[1].conversation?.messageIds, [input, followup]);
  assert.equal(answer.capacityRetries, 1); assert.deepEqual(answer.acceptedInputIds, [followup]);
  assert.equal(answer.timing?.elapsedMs, 50); assert.equal(answer.timing?.firstTokenMs, 30);
  assert.equal(session.threadId, 'new-thread'); assert.equal(session.rotateBeforeNext, false);
  assert.equal(journal.prepare('new-thread', []).text, '');
  assert.equal(events[0].type, 'chat.capacity_retry');
});

test('continued capacity failures stop after one retry and keep the next message recoverable', async t => {
  const { memory, session, options } = fixture(t);
  let calls = 0;
  const answer = await runConversationTurn(options, session, memory, () => {}, async () => {
    calls++; return { ...result(capacity), threadId: `thread-${calls}` };
  });
  assert.equal(calls, 2); assert.equal(answer.error, capacity); assert.equal(answer.capacityRetries, 1);
  assert.equal(session.rotateBeforeNext, true);
});

test('work, quota failures and user cancellation never trigger automatic replay', async t => {
  for (const scenario of ['work', 'quota', 'cancel', 'normal'] as const) {
    const { memory, session, options } = fixture(t);
    const controller = new AbortController(); options.signal = controller.signal;
    if (scenario === 'work') options.profile = 'work';
    let calls = 0;
    const answer = await runConversationTurn(options, session, memory, () => {}, async () => {
      calls++; if (scenario === 'cancel') controller.abort();
      return result(scenario === 'quota' ? 'Usage limit reached' : scenario === 'normal' ? undefined : capacity);
    });
    assert.equal(calls, 1, scenario); assert.equal(answer.capacityRetries, undefined);
  }
});

test('a turn that has executed a command is never replayed even if capacity is reported', async t => {
  const { memory, session, options } = fixture(t);
  let calls = 0;
  await runConversationTurn(options, session, memory, () => {}, async () => {
    calls++; return { ...result(capacity), commands: [{ command: 'touch /tmp/result', exit_code: 0 } as any] };
  });
  assert.equal(calls, 1);
});

test('a newer unconsumed batch retains the old draft without spending a review call', async t => {
  const { memory, session, options } = fixture(t);
  options.personaContext = {version:'ruanruan-core-v6',fingerprint:'offline',files:[],bytes:0};
  options.isSuperseded = accepted => { assert.deepEqual(accepted,['in:followup']); return true; };
  let calls = 0;
  const answer = await runConversationTurn(options, session, memory, () => {}, async () => {
    calls++; return {...result(),replyText:'没听完就生成的旧稿',acceptedInputIds:['in:followup']};
  });
  assert.equal(calls,1);
  assert.equal(answer.superseded,true);
  assert.equal(answer.replyText,'');
  assert.equal(answer.characterReview,undefined);
  assert.equal(answer.retainedDraft?.replyText,'没听完就生成的旧稿');
  assert.equal(session.rotateBeforeNext,true);
});

test('freshness uses actual group members and ignores supplements already accepted by steering', () => {
  const context = {kind:'group',conversationId:'room',actorId:'alice',actorName:'同名',conversationName:'群'};
  const job:any={accountId:'freshness',fromUserId:'room-peer',options:{profile:'companion'},session:{chatContext:context}};
  const write=(rows:unknown[])=>writeFileSync(join(root,'message-queue.json'),JSON.stringify([['freshness',rows]]));
  write([{fromUserId:'room-peer',chatContext:{...context,actorId:'bob'},messageIds:['in:2']}]);
  assert.equal(hasUnconsumedChatInput(job),false);
  write([{fromUserId:'room-peer',chatContext:context,messageIds:['in:3','in:4']}]);
  assert.equal(hasUnconsumedChatInput(job,['in:3']),true);
  assert.equal(hasUnconsumedChatInput(job,['in:3','in:4']),false);
  rmSync(join(root,'message-queue.json'));
});

test('low affinity still reaches generation; an explicit finite pause remains honored',async t=>{
 const {memory,session,options}=fixture(t);
 options.personaContext={version:'ruanruan-core-v6',fingerprint:'offline',files:[],bytes:0};
 let pausedUntil=0,calls=0;
 t.mock.method(memory,'socialSnapshot',()=>({relationship:{affection:-24,reluctant:true,pausedUntil}} as any));
 const runner=async()=>{calls++;return result('offline sentinel: stop before review');};
 await runConversationTurn(options,session,memory,()=>{},runner);
 assert.equal(calls,1);
 pausedUntil=Date.now()+60000;
 const paused=await runConversationTurn(options,session,memory,()=>{},runner);
 assert.equal(calls,1);assert.equal(paused.replyDisposition,'no_reply');
});
