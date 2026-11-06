import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAppServerCodex } from '../src/codex/app-server.js';
import { createConversationStore } from '../src/conversation.js';
import { memoryDirectory } from '../src/memory.js';
import { randomUUID } from 'node:crypto';

async function fixture(t: any, handle: (value: any, send: (value: unknown) => void, socket: any) => void) {
  const root = mkdtempSync(join(tmpdir(), 'wcb-appserver-'));
  const path = join(root, 'runtime.sock');
  const sockets = new Set<any>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const send = (value: unknown) => socket.write(JSON.stringify(value) + '\n');
    createInterface({ input: socket }).on('line', line => {
      const value = JSON.parse(line);
      if (value.method === 'thread/name/set') response(send, value, {});
      handle(value, send, socket);
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); rmSync(root, { recursive: true, force: true }); });
  return path;
}
const response = (send: (value: unknown) => void, value: any, result: any) => send({ id: value.id, result });
const notification = (send: (value: unknown) => void, method: string, params: any) => send({ method, params });

test('native usage counts successive requests once and preserves raw cache facts',async t=>{
  const path=await fixture(t,(value,send)=>{
    if(value.method==='initialize')response(send,value,{});
    if(value.method==='thread/resume')response(send,value,{thread:{id:'usage-thread'}});
    if(value.method==='turn/start'){
      response(send,value,{turn:{id:'usage-turn'}});
      const p={threadId:'usage-thread',turnId:'usage-turn'};
      const first={total:{inputTokens:1000},last:{inputTokens:100,cachedInputTokens:80,outputTokens:10}};
      notification(send,'thread/tokenUsage/updated',{...p,tokenUsage:first});
      notification(send,'thread/tokenUsage/updated',{...p,tokenUsage:first});
      notification(send,'thread/tokenUsage/updated',{...p,tokenUsage:{total:{inputTokens:1200},last:{inputTokens:200,cachedInputTokens:150,outputTokens:20}}});
      notification(send,'item/completed',{...p,item:{type:'agentMessage',text:'ok',phase:'final_answer'}});
      notification(send,'turn/completed',{threadId:p.threadId,turn:{id:p.turnId,status:'completed'}});
    }
  });
  const result=await runAppServerCodex({threadId:'usage-thread',cwd:'/tmp',mode:'plan',prompt:'test',timeoutMs:2000},path);
  assert.equal(result.inputTokens,300);assert.equal(result.cachedInputTokens,230);assert.equal(result.outputTokens,30);
  assert.equal(result.cacheWriteInputTokens,undefined);assert.equal(result.usageDetails?.observedCalls,2);
  assert.equal(result.usageDetails?.raw.length,2);assert.equal(result.contextTokens,200);
});

test('resuming a named conversation changes only a generic title and never starts another thread',async t=>{
  for(const name of ['微信 · 阮阮','微信 · 阮阮 · 群聊：钓鱼群']) {
    const calls:any[]=[];
    const path=await fixture(t,(value,send)=>{
      calls.push(value);
      if(value.method==='initialize')response(send,value,{});
      if(value.method==='thread/resume')response(send,value,{thread:{id:'same',name}});
      if(value.method==='turn/start') {
        response(send,value,{turn:{id:'turn'}});
        notification(send,'item/completed',{threadId:'same',turnId:'turn',item:{type:'agentMessage',text:'好',phase:'final_answer'}});
        notification(send,'turn/completed',{threadId:'same',turn:{id:'turn',status:'completed'}});
      }
    });
    const result=await runAppServerCodex({profile:'companion',threadId:'same',cwd:'/tmp',mode:'plan',prompt:'你好',timeoutMs:2000,
      conversation:{accountId:'title-test',peerId:'room',roomId:'g@chatroom',label:'钓鱼群'}},path);
    assert.equal(result.threadId,'same');assert.equal(result.error,undefined);
    assert.equal(calls.filter(c=>c.method==='turn/start').length,1);
    assert.equal(calls.some(c=>c.method==='thread/start'),false);
    assert.equal(calls.filter(c=>c.method==='thread/name/set').length,name==='微信 · 阮阮'?1:0);
  }
});

test('background calls are ephemeral while production conversations keep resumable named threads', async t => {
  for (const profile of ['consolidation', 'companion', 'work'] as const) {
    for (const ephemeral of [undefined, true]) {
      const calls: any[] = [];
      const path = await fixture(t, (value, send) => {
        calls.push(value);
        if (value.method === 'initialize') response(send, value, {});
        if (value.method === 'thread/start') response(send, value, { thread: { id: 'policy-thread' } });
        if (value.method === 'turn/start') {
          response(send, value, { turn: { id: 'policy-turn' } });
          notification(send, 'item/completed', { threadId: 'policy-thread', turnId: 'policy-turn',
            item: { type: 'agentMessage', text: '完成', phase: 'final_answer' } });
          notification(send, 'turn/completed', { threadId: 'policy-thread', turn: { id: 'policy-turn', status: 'completed' } });
        }
      });
      const result = await runAppServerCodex({ profile, ephemeral, cwd: '/tmp', mode: 'plan', prompt: '测试',
        conversation: { accountId: 'thread-policy-test', peerId: 'owner' }, timeoutMs: 2000 }, path);
      assert.equal(result.error, undefined);
      assert.equal(result.replyText, '完成');
      const expectedEphemeral = ephemeral ?? profile === 'consolidation';
      assert.equal(calls.find(call => call.method === 'thread/start').params.ephemeral, expectedEphemeral);
      const title = calls.find(call => call.method === 'thread/name/set');
      if (expectedEphemeral) assert.equal(title, undefined);
      else assert.equal(title.params.name, profile === 'companion' ? '微信 · 阮阮 · 私聊：owner' : '微信 · 助手');
    }
  }
});

test('assistant and character presets reach new and resumed RPC calls with their own tier and permissions', async t => {
  const { CHAT_MODE_SETTINGS } = await import('../src/commands/router.js');
  for (const [profile, target] of Object.entries(CHAT_MODE_SETTINGS)) {
    for (const resume of [false, true]) {
      let loaded = false;
      const path = await fixture(t, (value, send) => {
        if (value.method === 'initialize') response(send, value, {});
        if (value.method === (resume ? 'thread/resume' : 'thread/start')) {
          assert.equal(value.params.model, target.model);
          assert.equal(value.params.serviceTier, profile === 'assistant' ? 'default' : 'priority');
          assert.equal(value.params.sandbox, profile === 'assistant' ? 'danger-full-access' : 'read-only');
          assert.equal(value.params.approvalPolicy, 'never');
          loaded = true; response(send, value, { thread: { id: 'preset-thread' } });
        }
        if (value.method === 'turn/start') {
          assert.equal(value.params.model, target.model);
          assert.equal(value.params.effort, target.reasoningEffort);
          assert.equal(value.params.serviceTier, profile === 'assistant' ? 'default' : 'priority');
          response(send, value, { turn: { id: 'preset-turn' } });
          notification(send, 'item/completed', { threadId: 'preset-thread', turnId: 'preset-turn',
            item: { type: 'agentMessage', text: '好', phase: 'final_answer' } });
          notification(send, 'turn/completed', { threadId: 'preset-thread', turn: { id: 'preset-turn', status: 'completed' } });
        }
      });
      const result = await runAppServerCodex({ ...target, prompt: '配置检查', cwd: '/tmp',
        profile: profile === 'assistant' ? 'work' : 'companion', threadId: resume ? 'preset-thread' : undefined, timeoutMs: 2000 }, path);
      assert.ok(loaded); assert.equal(result.error, undefined); assert.equal(result.replyText, '好');
    }
  }
});

test('custom suppliers are selected explicitly on both new and resumed native threads', async t => {
  for (const resume of [false, true]) {
    let selected = false;
    const path = await fixture(t, (value, send) => {
      if (value.method === 'initialize') response(send, value, {});
      if (value.method === (resume ? 'thread/resume' : 'thread/start')) {
        assert.equal(value.params.modelProvider, 'wcb_deepseek');
        assert.equal(value.params.model, 'deepseek-flash');
        selected = true; response(send, value, { thread: { id: 'supplier-thread' } });
      }
      if (value.method === 'turn/start') {
        assert.equal(value.params.serviceTier, 'default');
        response(send, value, { turn: { id: 'supplier-turn' } });
        notification(send, 'item/completed', { threadId: 'supplier-thread', turnId: 'supplier-turn',
          item: { type: 'agentMessage', text: '好', phase: 'final_answer' } });
        notification(send, 'turn/completed', { threadId: 'supplier-thread', turn: { id: 'supplier-turn', status: 'completed' } });
      }
    });
    const result = await runAppServerCodex({ prompt: '你好', cwd: '/tmp', mode: 'plan',
      modelProvider: 'wcb_deepseek', model: 'deepseek-flash', serviceTier: 'default',
      threadId: resume ? 'supplier-thread' : undefined, timeoutMs: 2000 }, path);
    assert.ok(selected); assert.equal(result.error, undefined); assert.equal(result.replyText, '好');
  }
});

test('chat profile overrides native base instructions and steers into the same active turn', async t => {
  let offered = false, starts = 0;
  const acknowledged: string[] = [];
  const path = await fixture(t, (value, send) => {
    if (value.method === 'initialize') response(send, value, {});
    if (value.method === 'thread/start') {
      assert.equal(value.params.baseInstructions, '微信专用');
      assert.equal(value.params.config['features.shell_tool'], false);
      response(send, value, { thread: { id: 'chat' } });
    }
    if (value.method === 'turn/start') { starts++; response(send, value, { turn: { id: 'turn-1' } }); }
    if (value.method === 'turn/steer') {
      assert.equal(value.params.expectedTurnId, 'turn-1');
      assert.match(value.params.input[0].text, /我说的是明天/);
      assert.match(value.params.input[0].text, /"speaker":"对方"/);
      assert.match(value.params.input[0].text, /按本轮生成提示词/);
      response(send, value, { turnId: 'turn-1' });
      setTimeout(() => {
        notification(send, 'item/completed', { threadId: 'chat', turnId: 'turn-1', item: { type: 'agentMessage', text: '明天啊，行', phase: 'final_answer' } });
        notification(send, 'turn/completed', { threadId: 'chat', turn: { id: 'turn-1', status: 'completed' } });
      }, 5);
    }
  });
  const result = await runAppServerCodex({ prompt: '晚上聊', cwd: '/tmp', mode: 'plan', profile: 'companion',
    baseInstructions: '微信专用', threadConfig: { 'features.shell_tool': false }, timeoutMs: 2000,
    nextInput: () => { if (offered) return; offered = true; return { text: '我说的是明天', ids: ['in:2'] }; },
    onInputAccepted: ids => acknowledged.push(...ids) }, path);
  assert.equal(result.error, undefined);
  assert.equal(result.replyText, '明天啊，行');
  assert.equal(starts, 1);
  assert.deepEqual(acknowledged, ['in:2']);
  assert.deepEqual(result.acceptedInputIds, ['in:2']);
});

test('WeChat-only dynamic tools complete through the native protocol and remain bound to the active thread', async t => {
  const accountId = `dynamic-test-${randomUUID()}`;
  const store = createConversationStore(accountId, 'owner');
  t.after(() => { rmSync(store.path, { force: true }); rmSync(memoryDirectory(accountId), { force: true, recursive: true }); });
  store.record('out', { client_id: 'news', item_list: [{ type: 1, text_item: { text: '城市数字化标准体系文件发布' } }] }, Date.now(), undefined, 'companion');
  let registered = false, completed = false;
  const path = await fixture(t, (value, send) => {
    if (value.method === 'initialize') response(send, value, {});
    if (value.method === 'thread/start') {
      registered = value.params.dynamicTools.some((tool: any) => tool.name === 'character_scene')
        && value.params.dynamicTools.some((tool: any) => tool.name === 'memory_recall');
      response(send, value, { thread: { id: 'wechat-native' } });
    }
    if (value.method === 'turn/start') {
      response(send, value, { turn: { id: 'turn-native' } });
      send({ id: 'tool-1', method: 'item/tool/call', params: { threadId: 'wechat-native', turnId: 'turn-native',
        callId: 'call-1', tool: 'memory_recall', arguments: { query: '城市数字化' } } });
    }
    if (value.id === 'tool-1' && value.result) {
      assert.equal(value.result.success, true);
      assert.match(value.result.contentItems[0].text, /城市数字化标准体系文件发布/);
      completed = true;
      notification(send, 'item/completed', { threadId: 'wechat-native', turnId: 'turn-native', item: { type: 'agentMessage', text: '接上刚才的新闻', phase: 'final_answer' } });
      notification(send, 'turn/completed', { threadId: 'wechat-native', turn: { id: 'turn-native', status: 'completed' } });
    }
  });
  const result = await runAppServerCodex({ prompt: '刚才那条呢', cwd: '/tmp', mode: 'plan',
    conversation: { accountId, peerId: 'owner' }, timeoutMs: 2000 }, path);
  assert.equal(result.error, undefined);
  assert.equal(result.replyText, '接上刚才的新闻');
  assert.ok(registered && completed);
});

test('runtime completion returns without process shutdown and preserves final text, files, usage and settings', async t => {
  const calls: any[] = [];
  const path = await fixture(t, (value, send) => {
    if (!value.method || value.method === 'initialized') return;
    calls.push(value);
    if (value.method === 'initialize') response(send, value, {});
    if (value.method === 'thread/resume') response(send, value, { thread: { id: 'same-thread', status: { type: 'idle' } } });
    if (value.method !== 'turn/start') return;
    response(send, value, { turn: { id: 'turn-1' } });
    const p = { threadId: 'same-thread', turnId: 'turn-1' };
    notification(send, 'item/completed', { ...p, item: { type: 'agentMessage', text: '正在处理', phase: 'commentary' } });
    notification(send, 'item/completed', { ...p, item: { type: 'commandExecution', command: 'pwd', exitCode: 0, status: 'completed' } });
    notification(send, 'item/completed', { ...p, item: { type: 'fileChange', changes: [{ path: '/tmp/example', kind: { type: 'add' } }] } });
    notification(send, 'item/agentMessage/delta', { ...p, delta: '完成' });
    notification(send, 'item/completed', { ...p, item: { type: 'agentMessage', text: '完成', phase: 'final_answer' } });
    notification(send, 'thread/tokenUsage/updated', { ...p, tokenUsage: { total: { inputTokens: 900000 }, last: { inputTokens: 12000, cachedInputTokens: 11000 } } });
    notification(send, 'turn/completed', { threadId: p.threadId, turn: { id: p.turnId, status: 'completed' } });
  });
  const r = await runAppServerCodex({ prompt: '当前用户消息', threadId: 'same-thread', cwd: '/tmp', mode: 'plan',
    model: 'gpt-6.1-terra', serviceTier: 'fast', reasoningEffort: 'medium', images: ['/tmp/input.png'],
    developerInstructions: '固定人格', injectDeveloperInstructionsOnResume: false, contextWindow: 100000, timeoutMs: 2000 }, path);
  assert.equal(r.error, undefined);
  assert.equal(r.threadId, 'same-thread');
  assert.equal(r.replyText, '完成');
  assert.equal(r.inputTokens, 12000);
  assert.equal(r.cachedInputTokens, 11000);
  assert.deepEqual(r.commands, [{ command: 'pwd', exitCode: 0, status: 'completed' }]);
  assert.deepEqual(r.fileChanges, [{ path: '/tmp/example', kind: 'add' }]);
  assert.equal(r.timing?.transport, 'app-server');
  assert.ok(r.timing!.elapsedMs < 1000);
  const resume = calls.find(x => x.method === 'thread/resume').params;
  assert.equal(resume.sandbox, 'read-only');
  assert.equal(resume.approvalPolicy, 'never');
  assert.equal(resume.excludeTurns, true);
  assert.equal(resume.config.model_auto_compact_token_limit, 70000);
  const start = calls.find(x => x.method === 'turn/start').params;
  assert.equal(start.model, 'gpt-6.1-terra');
  assert.equal(start.serviceTier, 'priority');
  assert.equal(start.effort, 'medium');
  assert.equal(start.input[0].text, '当前用户消息');
  assert.deepEqual(start.input[1], { type: 'localImage', path: '/tmp/input.png' });
});

test('abort interrupts the exact active turn, waits for settlement and never starts a replacement', async t => {
  const controller = new AbortController();
  let starts = 0, interrupts = 0;
  const path = await fixture(t, (value, send) => {
    if (value.method === 'initialize') response(send, value, {});
    if (value.method === 'thread/start') response(send, value, { thread: { id: 'new-thread' } });
    if (value.method === 'turn/start') {
      starts++; response(send, value, { turn: { id: 'exact-turn' } });
      setTimeout(() => controller.abort(), 10);
    }
    if (value.method === 'turn/interrupt') {
      interrupts++; assert.equal(value.params.threadId, 'new-thread'); assert.equal(value.params.turnId, 'exact-turn');
      response(send, value, {});
      notification(send, 'turn/completed', { threadId: 'new-thread', turn: { id: 'exact-turn', status: 'interrupted' } });
    }
  });
  const r = await runAppServerCodex({ prompt: '任务', cwd: '/tmp', mode: 'workspace', signal: controller.signal }, path);
  assert.match(r.error!, /任务已停止/);
  assert.equal(starts, 1); assert.equal(interrupts, 1);
});

test('disconnect and an already-active thread never replay user input', async t => {
  for (const active of [false, true]) {
    let starts = 0;
    const path = await fixture(t, (value, send, socket) => {
      if (value.method === 'initialize') response(send, value, {});
      if (value.method === 'thread/resume') response(send, value, { thread: { id: 'old', status: { type: active ? 'active' : 'idle' } } });
      if (value.method === 'turn/start') { starts++; socket.destroy(); }
    });
    const r = await runAppServerCodex({ prompt: '继续', threadId: 'old', cwd: '/tmp', mode: 'danger' }, path);
    assert.match(r.error!, active ? /已有运行中的任务/ : /连接中断/);
    assert.equal(starts, active ? 0 : 1);
  }
});

test('failed turns cannot return partial text as successful execution', async t => {
  const path = await fixture(t, (value, send) => {
    if (value.method === 'initialize') response(send, value, {});
    if (value.method === 'thread/start') response(send, value, { thread: { id: 'new' } });
    if (value.method === 'turn/start') {
      response(send, value, { turn: { id: 'failed-turn' } });
      notification(send, 'item/completed', { threadId: 'new', turnId: 'failed-turn', item: { type: 'agentMessage', text: '部分结果', phase: 'final_answer' } });
      notification(send, 'turn/completed', { threadId: 'new', turn: { id: 'failed-turn', status: 'failed', error: { message: '连接失败' } } });
    }
  });
  const r = await runAppServerCodex({ prompt: '任务', cwd: '/tmp', mode: 'plan' }, path);
  assert.equal(r.error, '连接失败');
});

test('idle compaction adds no user turn and new input can interrupt its exact turn', async t => {
  const controller = new AbortController();
  let compacted = 0, started = 0;
  const path = await fixture(t, (value, send) => {
    if (value.method === 'initialize') response(send, value, {});
    if (value.method === 'thread/resume') response(send, value, { thread: { id: 'same' } });
    if (value.method === 'turn/start') started++;
    if (value.method === 'thread/compact/start') {
      compacted++; response(send, value, {});
      notification(send, 'turn/started', { threadId: 'same', turn: { id: 'compact-1' } });
      setTimeout(() => controller.abort(), 10);
    }
    if (value.method === 'turn/interrupt') {
      assert.equal(value.params.turnId, 'compact-1'); response(send, value, {});
      notification(send, 'turn/completed', { threadId: 'same', turn: { id: 'compact-1', status: 'interrupted' } });
    }
  });
  const r = await runAppServerCodex({ threadId: 'same', prompt: '', cwd: '/tmp', mode: 'plan', signal: controller.signal }, path, 'compact');
  assert.match(r.error!, /任务已停止/);
  assert.equal(compacted, 1); assert.equal(started, 0);
});
