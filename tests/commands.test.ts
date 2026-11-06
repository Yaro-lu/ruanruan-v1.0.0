import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../src/session.js';
const root = mkdtempSync(join(tmpdir(), 'wcb-commands-'));
process.env.WCB_DATA_DIR = root;
const { routeCommand } = await import('../src/commands/router.js');
const { createJob } = await import('../src/jobs.js');
const { saveConfig } = await import('../src/config.js');
const { DEFAULT_PROFILE, COMPLEX_PROFILE } = await import('../src/routing.js');
test.after(() => rmSync(root, { recursive: true, force: true }));

function buildContext(text: string, session?: Partial<Session>) {
  const current: Session = {
    workingDirectory: '/tmp/default',
    state: 'idle',
    mode: 'workspace',
    ...session,
  };

  return {
    accountId: 'acct-1',
    session: current,
    updateSession(partial: Partial<Session>) {
      Object.assign(current, partial);
    },
    clearSession() {
      return {
        workingDirectory: current.workingDirectory,
        model: current.model,
        mode: current.mode,
        state: 'idle' as const,
      };
    },
    text,
  };
}

test('/mode updates the execution mode', () => {
  const ctx = buildContext('/mode plan', { threadId: 'thread-1' });
  const result = routeCommand(ctx);
  assert.equal(result.handled, true);
  assert.match(result.reply ?? '', /plan/);
  assert.equal(ctx.session.mode, 'plan');
  assert.equal(ctx.session.threadId, undefined);
});

test('/Q applies both presets while retaining separate histories and existing work', () => {
  const ctx = buildContext('/Q', { chatMode: 'companion', assistantVersion: 1,
    threadId: 'character-thread', workContext: { threadId: 'work-thread' }, workJobId: 'running-work',
    model: 'manual-model', reasoningEffort: 'low', serviceTier: 'fast' });
  const first = routeCommand(ctx);
  assert.match(first.reply!, /GPT-6\.1 Sol \/ High.*Fast 关闭.*服务器操作/);
  assert.equal(ctx.session.model, 'gpt-6.1-sol');
  assert.equal(ctx.session.reasoningEffort, 'high');
  assert.equal(ctx.session.serviceTier, 'default');
  assert.equal(ctx.session.mode, 'danger');
  routeCommand(ctx);
  assert.equal(ctx.session.model, 'gpt-5.6-luna');
  assert.equal(ctx.session.reasoningEffort, 'medium');
  assert.equal(ctx.session.serviceTier, 'fast');
  assert.equal(ctx.session.mode, 'plan');
  assert.equal(ctx.session.threadId, 'character-thread');
  assert.equal(ctx.session.workContext?.threadId, 'work-thread');
  assert.equal(ctx.session.workJobId, 'running-work');
  const before = JSON.stringify(ctx.session);
  ctx.text = '/Q with-arguments';
  routeCommand(ctx);
  assert.equal(JSON.stringify(ctx.session), before);
});

test('/cwd validates and updates the working directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wcb-cwd-'));
  const ctx = buildContext(`/cwd ${dir}`);
  const result = routeCommand(ctx);
  assert.match(result.reply ?? '', /工作目录已切换/);
  assert.equal(ctx.session.workingDirectory, dir);
});

test('unknown slash command falls back to help when skill is absent', () => {
  const ctx = buildContext('/no-such-skill');
  const result = routeCommand(ctx);
  assert.equal(result.handled, true);
  assert.match(result.reply ?? '', /未找到 skill/);
});

test('/status distinguishes the chat default from the most recent modification request', () => {
  saveConfig({ workingDirectory: root, autoRouting: true, ...DEFAULT_PROFILE });
  const ctx = buildContext('/status');
  const job = createJob({ accountId: ctx.accountId, kind: 'codex', userText: '重启测试服务',
    fromUserId: 'test-owner', contextToken: 'test-context', tempFiles: [], session: ctx.session,
    routing: { kind: 'complex', reason: 'explicit-modification', options: COMPLEX_PROFILE } });
  ctx.session.lastJobId = job.id;
  const result = routeCommand(ctx);
  assert.match(result.reply!, /日常聊天: gpt-6\.1-terra \/ medium \/ Fast 开启/);
  assert.match(result.reply!, /只读工作: gpt-6\.1-terra \/ medium \/ Fast 开启/);
  assert.match(result.reply!, /最近请求: gpt-6\.1-sol \/ high \/ Fast 关闭/);
  assert.match(result.reply!, /选择原因: 本轮要求实际修改/);
  assert.doesNotMatch(result.reply!, /test-context|test-owner/);
});
