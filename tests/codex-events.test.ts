import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexOutput } from '../src/codex/events.js';
import { buildCodexArgs } from '../src/codex/bridge.js';

test('parseCodexOutput extracts thread id, final reply, commands, and file changes', () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-123' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'intermediate' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: '/bin/zsh -lc pwd', exit_code: 0, status: 'completed' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: '/tmp/a.ts', kind: 'add' }] } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final reply' } }),
  ].join('\n');

  const result = parseCodexOutput(stdout, '', 0);
  assert.equal(result.threadId, 'thread-123');
  assert.equal(result.replyText, 'final reply');
  assert.equal(result.commands.length, 1);
  assert.equal(result.fileChanges.length, 1);
});

test('parseCodexOutput returns stderr as error on non-zero exit', () => {
  const result = parseCodexOutput('', 'boom', 1);
  assert.equal(result.error, 'boom');
});

test('explicit commentary never becomes a delivered answer, including late status events', () => {
  const message = (text: string, phase: string) => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text, phase } });
  const internal = message('internal control status', 'commentary');
  assert.equal(parseCodexOutput(internal, '', 0).replyText, '');
  assert.equal(parseCodexOutput(message('正常结果', 'final_answer') + '\n' + internal, '', 0).replyText, '正常结果');
});

test('one-shot and evaluation CLI calls opt out of history without changing ordinary sessions', () => {
  const options = { prompt: 'test', cwd: '/tmp', mode: 'plan' as const };
  assert.ok(buildCodexArgs({ ...options, profile: 'consolidation' }).includes('--ephemeral'));
  assert.ok(buildCodexArgs({ ...options, ephemeral: true }).includes('--ephemeral'));
  assert.equal(buildCodexArgs(options).includes('--ephemeral'), false);
  const previous = process.env.WCB_CODEX_EPHEMERAL;
  try {
    process.env.WCB_CODEX_EPHEMERAL = '1';
    assert.ok(buildCodexArgs({ ...options, profile: 'companion' }).includes('--ephemeral'));
    assert.equal(buildCodexArgs({ ...options, ephemeral: false }).includes('--ephemeral'), false);
    assert.equal(buildCodexArgs({ ...options, threadId: 'existing' }).includes('--ephemeral'), false);
  } finally {
    if (previous === undefined) delete process.env.WCB_CODEX_EPHEMERAL;
    else process.env.WCB_CODEX_EPHEMERAL = previous;
  }
});

test('buildCodexArgs maps workspace mode to workspace-write sandbox', () => {
  const args = buildCodexArgs({
    prompt: 'hello',
    cwd: '/tmp/project',
    mode: 'workspace',
  });

  assert.deepEqual(args.slice(0, 7), ['exec', '--json', '--skip-git-repo-check', '-C', '/tmp/project', '-s', 'workspace-write']);
  assert.ok(args.includes('approval_policy="never"'));
});

test('buildCodexArgs omits cwd flags on resume', () => {
  const args = buildCodexArgs({
    prompt: 'follow up',
    cwd: '/tmp/project',
    threadId: 'thread-1',
    mode: 'plan',
  });

  assert.deepEqual(args.slice(0, 4), ['exec', 'resume', '--json', '--skip-git-repo-check']);
  assert.equal(args.includes('-C'), false);
  assert.equal(args.at(-2), 'thread-1');
  assert.equal(args.at(-1), 'follow up');
});


test('explicit Fast tier reaches both new and resumed Codex runs', () => {
  for (const threadId of [undefined, 'thread-fast']) {
    const args = buildCodexArgs({ prompt: 'hello', cwd: '/tmp', mode: 'plan',
      model: 'gpt-6-luna', reasoningEffort: 'high', serviceTier: 'fast', threadId });
    assert.ok(args.includes('service_tier="fast"'));
    assert.ok(args.includes('model_reasoning_effort="high"'));
    assert.equal(args[args.indexOf('-m') + 1], 'gpt-6-luna');
  }
  const args = buildCodexArgs({ prompt: 'hello', cwd: '/tmp', mode: 'plan' });
  assert.equal(args.some(arg => arg.startsWith('service_tier=')), false);
});
