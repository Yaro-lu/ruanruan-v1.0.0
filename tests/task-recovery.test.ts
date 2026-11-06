import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {createHash} from 'node:crypto';
const root = mkdtempSync(join(tmpdir(), 'bridge-recovery-'));
process.env.WCB_DATA_DIR = root;
process.env.WCB_MEDIA_ROOT = join(root, 'assets');
mkdirSync(join(root, 'assets', '图片'), { recursive: true });
mkdirSync(join(root, 'assets', '视频'), { recursive: true });
const { createJob, writeStatus, readStatus, jobDir, atomicWrite } = await import('../src/jobs.js');
const { watchJob, handleMessage } = await import('../src/main.js');
const { MessageType } = await import('../src/wechat/types.js');
const { createConversationStore } = await import('../src/conversation.js');
test.after(() => rmSync(root, { recursive: true, force: true }));
function fixture() {
  const session: any = { workingDirectory: root, state: 'processing', model: 'keep-model', reasoningEffort: 'medium' };
  const job = createJob({ accountId: 'test', kind: 'codex', userText: 'do work', fromUserId: 'owner', contextToken: 'old', tempFiles: [], session: { ...session } });
  session.activeJobId = job.id;
  writeStatus(job.id, { state: 'completed', phase: 'done', updatedAt: Date.now(), session: { ...session, threadId: 'new-thread', memoryTurns: 4 },
    result: { replyText: 'verified result', commands: [], fileChanges: [], threadId: 'new-thread' } });
  const messages: string[] = [];
  const sender: any = { inThread: (_thread: string, action: () => Promise<unknown>) => action(), sendText: async (_u: string, _c: string, text: string) => messages.push(text), startTyping: () => ({ stop: async () => {} }) };
  const account: any = { accountId: 'test', userId: 'owner' };
  const store: any = { save: () => {} };
  return { session, job, messages, sender, account, store };
}
test('reattachment delivers saved result and session metadata without rerunning job or changing model', async () => {
  const f = fixture();
  await watchJob(f.job.id, f.account, f.session, f.store, f.sender, { workingDirectory: root });
  assert.deepEqual(f.messages, ['verified result']);
  assert.equal(f.session.state, 'idle');
  assert.equal(f.session.activeJobId, undefined);
  assert.equal(f.session.threadId, 'new-thread');
  assert.equal(f.session.model, 'keep-model');
  assert.equal(f.session.reasoningEffort, 'medium');
});

test('an owner can switch with /Q during generation; the old unsent reply is suppressed', async () => {
  const f = fixture();
  f.job.options = { profile: 'companion', prompt: '你好', cwd: root, mode: 'plan' };
  atomicWrite(join(jobDir(f.job.id), 'job.json'), f.job);
  await handleMessage({ message_type: MessageType.USER, from_user_id: 'owner', context_token: 'new',
    message_id: 100001, item_list: [{ type: 1, text_item: { text: '/Q' } }] },
    f.account, f.session, f.store, f.sender, { workingDirectory: root });
  assert.equal(f.session.chatMode, 'assistant');
  assert.match(f.messages[0], /普通AI助手/);
  await watchJob(f.job.id, f.account, f.session, f.store, f.sender, { workingDirectory: root });
  assert.equal(f.messages.length, 1, 'the previous character draft is not sent after the mode switch');
  assert.equal(f.session.rotateBeforeNext, true);
  assert.equal(f.session.queuePaused, false);
});

test('a work result arriving during chat keeps chat execution and native history intact', async () => {
  const f = fixture();
  f.session.threadId = 'chat-thread'; f.session.contextTokens = 1000;
  f.session.activeJobId = 'a-different-chat-job';
  f.session.workJobId = f.job.id;
  f.job.options = { profile: 'work', prompt: '看日志', cwd: root, mode: 'plan' };
  atomicWrite(join(jobDir(f.job.id), 'job.json'), f.job);
  writeStatus(f.job.id, { state: 'completed', phase: 'done', updatedAt: Date.now(),
    session: { ...f.job.session, threadId: 'work-thread', contextTokens: 9000 },
    result: { replyText: '日志查完了', threadId: 'work-thread', commands: [], fileChanges: [] } });
  await watchJob(f.job.id, f.account, f.session, f.store, f.sender, { workingDirectory: root });
  assert.equal(f.session.threadId, 'chat-thread');
  assert.equal(f.session.contextTokens, 1000);
  assert.equal(f.session.activeJobId, 'a-different-chat-job');
  assert.equal(f.session.state, 'processing');
  assert.equal(f.session.workJobId, undefined);
  assert.equal(f.session.workContext.threadId, 'work-thread');
  assert.deepEqual(f.messages, ['日志查完了']);
});

test('capacity failure does not lock ordinary conversation behind a resume command', async () => {
  const f = fixture();
  f.job.options = { profile: 'companion', prompt: '你好', cwd: root, mode: 'plan' };
  atomicWrite(join(jobDir(f.job.id), 'job.json'), f.job);
  writeStatus(f.job.id, { state: 'failed', phase: 'failed', updatedAt: Date.now(), session: f.session,
    result: { replyText: '', commands: [], fileChanges: [], error: 'Selected model is at capacity.' } });
  await watchJob(f.job.id, f.account, f.session, f.store, f.sender, { workingDirectory: root });
  assert.equal(f.session.queuePaused, false);
  assert.equal(f.session.rotateBeforeNext, true);
  assert.equal(f.session.state, 'idle');
  assert.deepEqual(f.messages, [], 'failed character candidates do not send transport fallback text');
});
test('failed delivery retains active job and reattachment can deliver without repeating execution', async () => {
  const f = fixture();
  const failing = { ...f.sender, sendText: async () => { throw new Error('offline'); } };
  await watchJob(f.job.id, f.account, f.session, f.store, failing, { workingDirectory: root });
  assert.equal(f.session.activeJobId, f.job.id);
  await watchJob(f.job.id, f.account, f.session, f.store, f.sender, { workingDirectory: root });
  assert.deepEqual(f.messages, ['verified result']);
  assert.equal(readStatus(f.job.id).state, 'completed');
});
test('character delivery failure preserves the model thread and records an undelivered candidate',async()=>{
  const f=fixture();f.account.entryRole='character';
  f.job.options={profile:'companion',prompt:'打个招呼',cwd:root,mode:'plan'};
  atomicWrite(join(jobDir(f.job.id),'job.json'),f.job);
  const text='来了';
  writeStatus(f.job.id,{state:'completed',phase:'done',updatedAt:Date.now(),
    session:{...f.session,threadId:'stable-character',rotateBeforeNext:false},
    result:{threadId:'stable-character',replyText:text,commands:[],fileChanges:[],characterReview:{
      status:'approved',checks:1,elapsedMs:0,issues:[],model:'mock',inputTokens:0,outputTokens:0,
      approvedReplyHash:createHash('sha256').update(text).digest('hex')}}});
  await watchJob(f.job.id,f.account,f.session,f.store,{...f.sender,sendText:async()=>{throw Error('target missing');}}, {workingDirectory:root});
  assert.equal(f.session.threadId,'stable-character');assert.equal(f.session.rotateBeforeNext,false);
  assert.equal(f.session.activeJobId,undefined);assert.equal(f.session.state,'idle');
  assert.equal(f.session.threadFeedback.delivery.status,'incomplete');
  assert.deepEqual(f.session.threadFeedback.delivery.confirmedTexts,[]);
  assert.equal(readStatus(f.job.id).state,'completed');
});
test('image reply uploads once and removes local Markdown paths from the WeChat text', async () => {
  const f = fixture(); const images: string[] = [];
  f.sender.sendImage = async (_to: string, _ctx: string, path: string, opts: any) => {
    opts.beforeSend(); images.push(path); return { ret: 0, messageIdPresent: true };
  };
  writeStatus(f.job.id, { state: 'completed', phase: 'done', updatedAt: Date.now(), session: f.session,
    result: { replyText: '给你画好了。\n![图片](/tmp/result.png)', commands: [], fileChanges: [] } });
  await watchJob(f.job.id, f.account, f.session, f.store, f.sender, { workingDirectory: root });
  assert.deepEqual(images, ['/tmp/result.png']); assert.deepEqual(f.messages, ['给你画好了。']);
  await watchJob(f.job.id, f.account, f.session, f.store, f.sender, { workingDirectory: root });
  assert.equal(images.length, 1); assert.equal(f.messages.length, 1);
});
test('catalog media chosen by this job is delivered once and its marker stays off WeChat', async () => {
  const f = fixture(); const path = join(root, 'assets', '视频', 'sample.mp4'); writeFileSync(path, 'test-video');
  f.job.mediaCandidates = [{ asset_id: 'rr_video_0006', kind: 'video', file: '视频/sample.mp4', title: '厨房', tags: ['厨房'] }];
  atomicWrite(join(jobDir(f.job.id), 'job.json'), f.job);
  let count = 0;
  f.sender.sendVideo = async (_u: string, _c: string, value: string, options: any) => {
    assert.equal(value, path); options.beforeSend(); count++;
    createConversationStore('test', 'owner').record('out', { client_id: options.clientId,
      item_list: [{ type: 5, video_item: {} }] });
    return { ret: 0, messageIdPresent: true };
  };
  writeStatus(f.job.id, { state: 'completed', phase: 'done', updatedAt: Date.now(), session: f.session,
    result: { replyText: '给你看看。\n[[ASSET:rr_video_0006]]', commands: [], fileChanges: [] } });
  await watchJob(f.job.id, f.account, f.session, f.store, f.sender, { workingDirectory: root });
  await watchJob(f.job.id, f.account, f.session, f.store, f.sender, { workingDirectory: root });
  assert.equal(count, 1); assert.deepEqual(f.messages, ['给你看看。']);
});
test('approval confirmation bypasses normal chat and queue even while a task is busy', async () => {
  const { createApprovalStore } = await import('../src/approvals.js');
  const f = fixture(); const approvals = createApprovalStore();
  const a = approvals.create({ accountId: f.account.accountId, userId: 'owner', summary: 'test only', details: 'no files', origin: 'test' });
  await handleMessage({ message_type: MessageType.USER, from_user_id: 'owner', context_token: 'new',
    item_list: [{ type: 1, text_item: { text: `同意 ${a.code}` } }] } as any,
    f.account, f.session, f.store, f.sender, { workingDirectory: root });
  assert.equal(approvals.find(a.code)?.state, 'approved'); assert.match(f.messages[0], /已同意授权/);
  assert.equal(f.session.activeJobId, f.job.id);
});
test('delivery respects a worker-cleared thread after forgetting instead of restoring the old execution id', async () => {
  const f = fixture();
  f.session.threadId = 'old-thread';
  writeStatus(f.job.id, { state: 'completed', phase: 'done', updatedAt: Date.now(),
    session: { ...f.session, threadId: undefined }, threadId: 'old-thread',
    result: { replyText: '已忘记', commands: [], fileChanges: [], threadId: 'old-thread' } });
  await watchJob(f.job.id, f.account, f.session, f.store, f.sender, { workingDirectory: root });
  assert.equal(f.session.threadId, undefined);
  assert.deepEqual(f.messages, ['已忘记']);
});
test('only owner can request stop and stop remains available while busy', async () => {
  const f = fixture();
  writeStatus(f.job.id, { state: 'running', phase: 'work', updatedAt: Date.now() });
  const msg: any = { message_type: MessageType.USER, from_user_id: 'stranger', context_token: 'new', item_list: [{ type: 1, text_item: { text: '/stop' } }] };
  await handleMessage(msg, f.account, f.session, f.store, f.sender, { workingDirectory: root });
  assert.equal(f.messages.length, 0);
  msg.from_user_id = 'owner';
  await handleMessage(msg, f.account, f.session, f.store, f.sender, { workingDirectory: root });
  assert.equal(f.session.queuePaused, true);
  assert.equal(readFileSync(join(jobDir(f.job.id), 'stop'), 'utf8'), '');
  assert.match(f.messages[0], /已请求停止/);
});
test('resume during attachment preparation never starts a duplicate task', async () => {
  const f = fixture();
  f.session.activeJobId = undefined;
  f.session.pendingRequest = { userText: 'attachment request', fromUserId: 'owner', contextToken: 'old' };
  const msg: any = { message_type: MessageType.USER, from_user_id: 'owner', context_token: 'new', item_list: [{ type: 1, text_item: { text: '/resume' } }] };
  await handleMessage(msg, f.account, f.session, f.store, f.sender, { workingDirectory: root });
  assert.match(f.messages[0], /未重复启动/);
  assert.equal(f.session.activeJobId, undefined);
});
test('waiting jobs keep typing across phase changes and only send progress when asked', async () => {
  const f = fixture();
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  let typingCalls = 0;
  let typingStops = 0;
  f.sender.startTyping = () => { typingCalls++; return { stop: async () => { typingStops++; } }; };
  writeStatus(f.job.id, { state: 'running', phase: 'first phase', updatedAt: now });
  const watching = watchJob(f.job.id, f.account, f.session, f.store, f.sender, { workingDirectory: root });
  try {
    now += 31_000;
    writeStatus(f.job.id, { state: 'running', phase: 'new phase', updatedAt: now });
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.deepEqual(f.messages, []);
    assert.equal(typingCalls, 1);
    assert.equal(typingStops, 0);
    await handleMessage({ message_type: MessageType.USER, from_user_id: 'owner', context_token: 'new',
      item_list: [{ type: 1, text_item: { text: '/progress' } }] } as any,
      f.account, f.session, f.store, f.sender, { workingDirectory: root });
    assert.equal(f.messages.length, 1);
    assert.match(f.messages[0], /new phase/);
  } finally {
    writeStatus(f.job.id, { state: 'completed', phase: 'done', updatedAt: now,
      result: { replyText: 'final result', commands: [], fileChanges: [] } });
    await watching;
    Date.now = originalNow;
  }
  assert.equal(f.messages.at(-1), 'final result');
  assert.equal(typingStops, 1);
});

test('preparation hands typing to the watcher until reply delivery finishes', async () => {
  const f = fixture();
  let stops = 0;
  let finishDelivery!: () => void;
  const delivering = new Promise<void>(resolve => { finishDelivery = resolve; });
  const initialTyping = { stop: async () => { stops++; } };
  f.sender.startTyping = () => assert.fail('must reuse the preparation indicator');
  f.sender.sendText = async () => { await delivering; };
  const watching = watchJob(f.job.id, f.account, f.session, f.store, f.sender, { workingDirectory: root }, initialTyping);
  assert.equal(stops, 0);
  assert.equal(f.session.activeJobId, f.job.id);
  finishDelivery();
  await watching;
  assert.equal(stops, 1);
  assert.equal(f.session.state, 'idle');
});

test('server command execution stops typing and leaves progress silent', async () => {
  const f = fixture();
  let stops = 0;
  const initialTyping = { stop: async () => { stops++; } };
  f.sender.startTyping = () => assert.fail('must not restart typing during commands');
  writeStatus(f.job.id, { state: 'running', phase: '正在执行服务器命令', executionStarted: true, updatedAt: Date.now() });
  const watching = watchJob(f.job.id, f.account, f.session, f.store, f.sender, { workingDirectory: root }, initialTyping);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(stops, 1);
  assert.deepEqual(f.messages, []);
  writeStatus(f.job.id, { state: 'completed', phase: 'done', updatedAt: Date.now(), executionStarted: true,
    result: { replyText: 'done', commands: [], fileChanges: [] } });
  await watching;
  assert.equal(stops, 1);
  assert.deepEqual(f.messages, ['done']);
});

test('failed reply delivery stops the transferred indicator and retains the result', async () => {
  const f = fixture();
  let stops = 0;
  f.sender.sendText = async () => { throw new Error('offline'); };
  await watchJob(f.job.id, f.account, f.session, f.store, f.sender, { workingDirectory: root }, { stop: async () => { stops++; } });
  assert.equal(stops, 1);
  assert.equal(f.session.activeJobId, f.job.id);
  assert.equal(readStatus(f.job.id).state, 'completed');
});

test('incoming burst while a job is busy queues one combined request without notification spam', async () => {
  const f = fixture();
  f.account.accountId = 'busy-burst';
  for (const [text, token] of [['去吃了个网红店', 'ctx1'], ['不好吃，钱白花了', 'ctx2'], ['纯吐槽', '']]) {
    await handleMessage({ message_type: MessageType.USER, from_user_id: 'owner', context_token: token,
      item_list: [{ type: 1, text_item: { text } }] } as any,
      f.account, f.session, f.store, f.sender, { workingDirectory: root });
  }
  assert.deepEqual(f.messages, []);
  const queues = new Map<string, any[]>(JSON.parse(readFileSync(join(root, 'message-queue.json'), 'utf8')));
  assert.equal(queues.get('busy-burst')!.length, 1);
  assert.equal(queues.get('busy-burst')![0].userText, '去吃了个网红店\n不好吃，钱白花了\n纯吐槽');
  assert.equal(queues.get('busy-burst')![0].contextToken, 'ctx2');
  assert.equal(f.session.jobContextToken, 'ctx2');
});

test('a message during character idle compaction requests interruption and stays queued quietly', async () => {
  const f = fixture();
  f.account.accountId = 'compaction-owner';
  const job = createJob({ accountId: f.account.accountId, kind: 'compact', userText: '', fromUserId: 'owner', contextToken: 'ctx', session: { ...f.session }, tempFiles: [] });
  f.session.activeJobId = job.id;
  writeStatus(job.id, { state: 'running', phase: 'compact', updatedAt: Date.now() });
  for (const text of ['在吗', '我还有一句']) await handleMessage({ message_type: MessageType.USER, from_user_id: 'owner', context_token: 'new',
    item_list: [{ type: 1, text_item: { text } }] } as any, f.account, f.session, f.store, f.sender, { workingDirectory: root });
  assert.deepEqual(f.messages, []);
  assert.equal(readFileSync(join(jobDir(job.id), 'stop'), 'utf8'), '');
  const queues = new Map<string, any[]>(JSON.parse(readFileSync(join(root, 'message-queue.json'), 'utf8')));
  assert.equal(queues.get('compaction-owner')![0].userText, '在吗\n我还有一句');
});

test('interrupted idle compaction keeps the thread, routing and normal queue available', async () => {
  const f = fixture();
  f.session.threadId = 'preserved';
  f.session.lastJobId = 'user-task';
  const job = createJob({ accountId: 'test', kind: 'compact', userText: '', fromUserId: 'owner', contextToken: 'ctx', session: f.session, tempFiles: [] });
  f.session.activeJobId = job.id;
  writeStatus(job.id, { state: 'stopped', phase: 'interrupted', updatedAt: Date.now(), result: { replyText: '', commands: [], fileChanges: [], error: '任务已停止' } });
  await watchJob(job.id, f.account, f.session, f.store, f.sender, { workingDirectory: root });
  assert.equal(f.session.threadId, 'preserved');
  assert.equal(f.session.lastJobId, 'user-task');
  assert.equal(f.session.state, 'idle');
  assert.ok(!f.session.queuePaused); assert.ok(!f.session.rotateBeforeNext);
  assert.deepEqual(f.messages, []);
});

test('idle burst waits quietly and stop cancels the pending launch while preserving its messages', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.account.accountId = 'idle-burst';
  f.session.state = 'idle';
  f.session.activeJobId = undefined;
  const inbound = (text: string) => handleMessage({ message_type: MessageType.USER, from_user_id: 'owner', context_token: 'ctx',
    item_list: [{ type: 1, text_item: { text } }] } as any,
    f.account, f.session, f.store, f.sender, { workingDirectory: root });
  await inbound('先等等');
  await inbound('我还有半句');
  assert.equal(f.session.state, 'idle');
  assert.equal(f.session.activeJobId, undefined);
  assert.deepEqual(f.messages, []);
  await inbound('/stop');
  t.mock.timers.tick(2000);
  assert.equal(f.session.queuePaused, true);
  assert.equal(f.session.activeJobId, undefined);
  assert.equal(f.messages.length, 1);
  const queues = new Map<string, any[]>(JSON.parse(readFileSync(join(root, 'message-queue.json'), 'utf8')));
  assert.equal(queues.get('idle-burst')![0].userText, '先等等\n我还有半句');
});

test('chat-only delivery failure retains its receipt without blocking later conversation behind /resume',async()=>{
  const f=fixture();f.account.entryRole='character';f.account.transport='desktop';
  const sender={...f.sender,sendText:async()=>{throw Error('uncertain transport result');}};
  await watchJob(f.job.id,f.account,f.session,f.store,sender,{workingDirectory:root});
  assert.equal(f.session.activeJobId,undefined);assert.equal(f.session.state,'idle');
  assert.equal(f.session.lastJobId,f.job.id);assert.notEqual(f.session.rotateBeforeNext,true);
  assert.equal(f.session.threadId,'new-thread');assert.equal(f.session.threadFeedback.delivery.status,'incomplete');
  assert.equal(readStatus(f.job.id).state,'completed');assert.deepEqual(f.messages,[]);
});
