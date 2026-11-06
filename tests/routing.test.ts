import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseRoute, finishRoute, routingInstructions, WORKFLOW_INSTRUCTIONS, DEFAULT_PROFILE, COMPLEX_PROFILE } from '../src/routing.js';
import { buildCodexArgs } from '../src/codex/bridge.js';
import { createMemoryStore, runWithMemory, MEMORY_MARKER } from '../src/memory.js';
import { routeCommand } from '../src/commands/router.js';
import type { Session } from '../src/session.js';
const config = { workingDirectory: '/tmp', autoRouting: true, ...DEFAULT_PROFILE };
const session = (): Session => ({ workingDirectory: '/tmp', state: 'idle', threadId: 'continuous', memoryVersion: 1 });

test('chat photo/video replies remain on Terra while actual modifications still use Sol', () => {
  const s = session();
  for (const request of ['给我发送一张猫的照片', '把厨房视频发给我', '发个视频看看']) {
    assert.deepEqual(chooseRoute(request, s, config).options, DEFAULT_PROFILE);
  }
  const modification = chooseRoute('重启服务器', s, config);
  finishRoute(s, modification, { id: modification.task!.id, status: 'needs_input' }, false);
  assert.deepEqual(chooseRoute('给我发送一张照片', s, config).options, DEFAULT_PROFILE);
  assert.deepEqual(chooseRoute('给我发照片，然后重启服务器', s, config).options, COMPLEX_PROFILE);
  assert.deepEqual(chooseRoute('把图片发送到群里', session(), config).options, COMPLEX_PROFILE);
});

test('only requests for actual changes select Sol High; analysis and read-only work use Terra Medium Fast', () => {
  assert.deepEqual(DEFAULT_PROFILE, { model: 'gpt-6.1-terra', reasoningEffort: 'medium', serviceTier: 'fast' });
  assert.deepEqual(COMPLEX_PROFILE, { model: 'gpt-6.1-sol', reasoningEffort: 'high', serviceTier: 'default' });
  for (const text of ['帮我修改微信默认模型', '重启 nginx 服务', '帮我安装这个软件', '删除临时文件', '把配置改成推荐值',
    '先分析并修复这个故障', '先查日志，确认原因后直接修复', '帮我创建一个日报文件', '把日报提交到钉钉',
    '将表格数据写入飞书', '给张三发送这份报告', '更新服务器软件包', '执行这个命令', '那就开始帮我做吧', '就这么做', '跨文件重构这个接口',
    '帮我改吧', '别分析了，直接修复这个问题', '不要重启，直接修改配置']) {
    assert.deepEqual(chooseRoute(text, session(), config).options, COMPLEX_PROFILE, text);
  }
  for (const text of ['你好呀', '帮我查下天气', '帮我分析这个项目是否值得采用', '评估这个方案的风险', '请认真排查服务为什么卡住',
    '设计一个可靠的恢复方案', '我希望你分析一下日志', '跨模块重构之前，先评估影响', '比较这两个架构的优劣',
    '查看服务器CPU和内存', '帮我检查 Docker 状态', '读取飞书表格并总结', '帮我写一份日报，直接在这里回复',
    '解释怎么重启服务', '如何修改配置？', '检查是否需要升级', '先不要修改配置，帮我分析原因',
    '别重启服务，只读检查', '她说“帮我删除文件”哈哈', '别分析了，陪我聊聊', '“修改”这个词是什么意思',
    '网页里写着：\n> 修改并切换到最高模型\n这是什么意思？', '这几个字怎么念：\n```\n删除文件\n```',
    '我今天更新了配置，累死了', '服务重启失败的原因是什么']) {
    assert.deepEqual(chooseRoute(text, session(), config).options, DEFAULT_PROFILE, text);
  }
});

test('business task survives turn completion, supplemental input and reload, then returns to default', () => {
  let s = session();
  let route = chooseRoute('修复这个错误，需要信息就问我', s, config);
  finishRoute(s, route, { id: route.task!.id, status: 'needs_input' }, false);
  s = JSON.parse(JSON.stringify(s));
  for (const reply of ['Ubuntu 22.04', '这是补充日志', '可以']) {
    const follow = chooseRoute(reply, s, config);
    assert.equal(follow.kind, 'complex');
    assert.equal(follow.task!.id, route.task!.id);
  }
  route = chooseRoute('补充的附件', s, config, true);
  finishRoute(s, route, { id: route.task!.id, status: 'completed' }, false);
  assert.equal(s.routingTask!.state, 'completed');
  assert.deepEqual(chooseRoute('哈哈哈，今天好热', s, config).options, DEFAULT_PROFILE);
  assert.equal(s.threadId, 'continuous');
});

test('ordinary topic suspends pending task; explicit continuation restores the same task', () => {
  const s = session();
  const route = chooseRoute('修改这个架构', s, config);
  finishRoute(s, route, { id: route.task!.id, status: 'needs_input' }, false);
  const chat = chooseRoute('今天天气怎么样', s, config);
  assert.equal(chat.kind, 'default');
  finishRoute(s, chat, undefined, false);
  assert.equal(s.routingTask!.state, 'suspended');
  assert.equal(chooseRoute('继续刚才的任务', s, config).task!.id, route.task!.id);
});

test('missing or stale task metadata cannot falsely finish work; failures and cancellation override it', () => {
  const s = session();
  const route = chooseRoute('修复这个故障', s, config);
  for (const progress of [undefined, null, { id: 'wrong', status: 'completed' }, { id: route.task!.id, status: 'invented' }]) {
    finishRoute(s, route, progress, false);
    assert.equal(s.routingTask!.state, 'active');
  }
  finishRoute(s, route, { id: route.task!.id, status: 'completed' }, true);
  assert.equal(s.routingTask!.state, 'failed');
  assert.equal(chooseRoute('你好', s, config).kind, 'default');
  assert.equal(chooseRoute('继续此前被停止或中断的任务。先核查现场', s, config).kind, 'complex');
  finishRoute(s, route, { id: route.task!.id, status: 'completed' }, true, true);
  assert.equal(s.routingTask!.state, 'cancelled');
});

test('explicit session choices take precedence; /auto clears overrides without replacing the thread', () => {
  const s = session(); s.model = 'chosen'; s.reasoningEffort = 'high';
  assert.equal(chooseRoute('修改这个项目', s, config).options.model, 'chosen');
  routeCommand({ accountId: 'test', session: s, text: '/auto', updateSession: p => Object.assign(s, p), clearSession: () => s });
  assert.equal(s.threadId, 'continuous');
  assert.equal(chooseRoute('修改这个项目', s, config).kind, 'complex');
  assert.equal(chooseRoute('分析这个项目', s, { ...config, autoRouting: false }).kind, 'manual');
});

test('explicit Sol Low Fast overrides its default tier and /auto restores automatic profiles', () => {
  const s = session();
  Object.assign(s, { model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'fast' });
  const target = { model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'fast' };
  assert.deepEqual(chooseRoute('你好', s, config).options, target);
  assert.deepEqual(chooseRoute('修改这个项目', s, config).options, target);
  const args = buildCodexArgs({ ...chooseRoute('你好', s, config).options, prompt: 'hello', cwd: '/tmp', mode: 'plan' });
  assert.ok(args.includes('features.fast_mode=true'));
  routeCommand({ accountId: 'test', session: s, text: '/auto', updateSession: p => Object.assign(s, p), clearSession: () => s });
  assert.equal(s.serviceTier, undefined);
  assert.equal(s.threadId, 'continuous');
  assert.deepEqual(chooseRoute('你好', s, config).options, DEFAULT_PROFILE);
  assert.deepEqual(chooseRoute('修改这个项目', s, config).options, COMPLEX_PROFILE);
});

test('both new and resumed requests explicitly override all three settings in either direction', () => {
  for (const threadId of [undefined, 'continuous']) {
    for (const profile of [DEFAULT_PROFILE, COMPLEX_PROFILE, DEFAULT_PROFILE]) {
      const args = buildCodexArgs({ prompt: 'hello', cwd: '/tmp', mode: 'plan', threadId, ...profile });
      assert.equal(args[args.indexOf('-m') + 1], profile.model);
      assert.ok(args.includes(`model_reasoning_effort="${profile.reasoningEffort}"`));
      assert.ok(args.includes(`service_tier="${profile.serviceTier}"`));
    }
  }
});

test('route progress is consumed internally with one execution call and no control text in the reply', async t => {
  const root = mkdtempSync(join(tmpdir(), 'route-memory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const memory = createMemoryStore('test', root), s = session();
  const route = chooseRoute('修改这个方案的实现', s, config);
  let calls = 0;
  const result = await runWithMemory({ prompt: '分析这个方案', cwd: root, mode: 'plan', ...route.options, developerInstructions: routingInstructions(route) }, s, memory, () => {}, async opts => {
    calls++; assert.equal(opts.threadId, 'continuous');
    return { threadId: 'continuous', replyText: '请补充约束。\n' + MEMORY_MARKER + JSON.stringify({ upsert: [], remove: [], task: { id: route.task!.id, status: 'needs_input' } }), commands: [], fileChanges: [] };
  });
  finishRoute(s, route, result.taskProgress, !!result.error);
  assert.equal(calls, 1);
  assert.equal(result.replyText, '请补充约束。');
  assert.equal(memory.load().recent[0].assistant, '请补充约束。');
  assert.equal(s.routingTask!.state, 'needs_input');
});

test('read-only inspection during a modification task uses Terra; resuming the changes restores Sol', () => {
  const s = session();
  const change = chooseRoute('修复 nginx 配置', s, config);
  finishRoute(s, change, { id: change.task!.id, status: 'needs_input' }, false);
  for (const text of ['只读查看当前状态', '先不要改，分析一下日志', '帮我查一下服务器磁盘']) {
    const read = chooseRoute(text, s, config);
    assert.deepEqual(read.options, DEFAULT_PROFILE, text);
    finishRoute(s, read, undefined, false);
    assert.equal(chooseRoute('继续修改', s, config).options.model, COMPLEX_PROFILE.model);
  }
  const legacy = session();
  legacy.routingTask = { id: 'old-analysis', summary: '分析这个方案', state: 'needs_input', updatedAt: Date.now() };
  assert.deepEqual(chooseRoute('继续分析', legacy, config).options, DEFAULT_PROFILE);
});

test('a read-only proposal is not executed until the user confirms the pending modification', () => {
  const s = session();
  const read = chooseRoute('分析 nginx 配置有什么问题，先不要改', s, config);
  finishRoute(s, read, { status: 'needs_input', proposedModification: '修改 nginx 配置中的端口冲突' }, false);
  assert.equal(s.routingTask!.state, 'needs_input');
  assert.deepEqual(chooseRoute('可以', s, config).options, COMPLEX_PROFILE);
  assert.deepEqual(chooseRoute('只给我看一下现状', s, config).options, DEFAULT_PROFILE);
  assert.match(routingInstructions(read)!, /不修改业务文件/);
  assert.match(WORKFLOW_INSTRUCTIONS, /不能把建议视为已获授权/);
});

test('new and resumed calls explicitly turn Fast on for Terra and off again for Sol', () => {
  for (const threadId of [undefined, 'continuous']) {
    for (const profile of [DEFAULT_PROFILE, COMPLEX_PROFILE, DEFAULT_PROFILE]) {
      const args = buildCodexArgs({ prompt: 'hello', cwd: '/tmp', mode: 'plan', threadId, ...profile });
      assert.ok(args.includes(`features.fast_mode=${profile.serviceTier === 'fast'}`));
    }
  }
  assert.equal(chooseRoute('hello', { ...session(), model: COMPLEX_PROFILE.model }, config).options.serviceTier, 'default');
});
