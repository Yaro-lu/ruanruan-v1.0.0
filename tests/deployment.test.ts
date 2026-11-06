import test from 'node:test';
import assert from 'node:assert/strict';
import { isAccountOwner } from '../src/wechat/access.js';
import { buildCodexArgs } from '../src/codex/bridge.js';

test('only a bound nonempty owner is authorized', () => {
  assert.equal(isAccountOwner('owner', 'owner'), true);
  assert.equal(isAccountOwner('owner', 'stranger'), false);
  assert.equal(isAccountOwner(undefined, 'stranger'), false);
  assert.equal(isAccountOwner('', ''), false);
});

test('resume applies the requested mode and treats message flags as data', () => {
  for (const mode of ['plan', 'workspace', 'danger'] as const) {
    const args = buildCodexArgs({cwd: '/tmp', threadId: 'thread-1', prompt: '--dangerously-bypass-approvals-and-sandbox', mode});
    assert.deepEqual(args.slice(-3), ['--', 'thread-1', '--dangerously-bypass-approvals-and-sandbox']);
    const flags = args.slice(0, args.indexOf('--'));
    if (mode === 'danger') assert.ok(flags.includes('--dangerously-bypass-approvals-and-sandbox'));
    else {
      assert.ok(flags.includes(`sandbox_mode="${mode === 'plan' ? 'read-only' : 'workspace-write'}"`));
      assert.ok(flags.includes('approval_policy="never"'));
      assert.equal(flags.includes('--dangerously-bypass-approvals-and-sandbox'), false);
    }
  }
});

test('new session protects leading dash prompts', () => {
  const args = buildCodexArgs({cwd: '/tmp', prompt: '--help', mode: 'workspace'});
  assert.deepEqual(args.slice(-2), ['--', '--help']);
});

import { routeCommand } from '../src/commands/router.js';
import type { Session } from '../src/session.js';

test('normal text does not change effort; explicit command preserves thread', () => {
  const session: Session = { workingDirectory: '/tmp', state: 'idle', threadId: 'thread-1' };
  const ctx = { accountId: 'test', session, text: '这个任务很复杂', updateSession: (v: Partial<Session>) => Object.assign(session, v), clearSession: () => session };
  assert.equal(routeCommand(ctx).handled, false);
  assert.equal(session.reasoningEffort, undefined);
  ctx.text = '/effort high';
  routeCommand(ctx);
  assert.equal(session.reasoningEffort, 'high');
  assert.equal(session.threadId, 'thread-1');
  ctx.text = '/effort invalid';
  routeCommand(ctx);
  assert.equal(session.reasoningEffort, 'high');
});

test('both new and resumed calls explicitly default to medium and honor explicit high', () => {
  for (const threadId of [undefined, 'thread-1']) {
    const base = {cwd: '/tmp', prompt: 'hello', mode: 'plan' as const, threadId};
    assert.ok(buildCodexArgs(base).includes('model_reasoning_effort="medium"'));
    assert.ok(buildCodexArgs({...base, reasoningEffort: 'high'}).includes('model_reasoning_effort="high"'));
  }
});

import { createSessionStore } from '../src/session.js';
import { DATA_DIR } from '../src/constants.js';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

test('clear resets the active thread and explicit effort, including in-memory state', () => {
  const account = `effort-test-${randomUUID()}`;
  const session: Session = {workingDirectory: '/tmp', state: 'idle', threadId: 'old-thread', reasoningEffort: 'high'};
  const store = createSessionStore();
  try {
    const ctx = {accountId: account, session, text: '/clear', updateSession: (v: Partial<Session>) => Object.assign(session, v), clearSession: () => store.clear(account, session)};
    routeCommand(ctx);
    assert.equal(session.threadId, undefined);
    assert.equal(session.reasoningEffort, undefined);
    assert.equal(store.load(account).reasoningEffort, undefined);
  } finally { unlinkSync(join(DATA_DIR, 'sessions', `${account}.json`)); }
});
