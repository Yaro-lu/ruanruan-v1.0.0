import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateWechatSession } from '../src/session.js';

test('migration starts one new Codex thread without restoring either stale engine transcript', () => {
  const session = { state: 'idle' as const, workingDirectory: '/tmp', engine: 'dsh', threadId: 'rr-old',
    engineSessions: { codex: { threadId: 'old-work' } }, model: 'explicit-model',
    contextTokens: 10000, developerInstructionsHash: 'old', memoryVersion: 1, routingTask: undefined };
  migrateWechatSession(session);
  assert.equal(session.threadId, undefined);
  assert.equal(session.contextTokens, 0);
  assert.equal(session.developerInstructionsHash, undefined);
  assert.equal(session.model, 'explicit-model');
  assert.equal('engine' in session, false);
  assert.equal('engineSessions' in session, false);
});

test('migration refuses an active old job; ordinary native Codex threads are unchanged', () => {
  assert.throws(() => migrateWechatSession({ state: 'processing', workingDirectory: '/tmp', activeJobId: 'running', engine: 'dsh' } as any), /任务仍在运行/);
  const session = { state: 'idle' as const, workingDirectory: '/tmp', threadId: 'native', contextTokens: 300 };
  assert.equal(migrateWechatSession(session), session);
  assert.equal(session.threadId, 'native');
});
