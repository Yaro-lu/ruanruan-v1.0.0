import test from 'node:test';
import assert from 'node:assert/strict';
import { idleCompactionDue, COMPACTION_IDLE_MS } from '../src/context-policy.js';
import type { Session } from '../src/session.js';

test('idle compaction uses actual current context and capacity, never cumulative CLI usage', () => {
  const s: Session = { state: 'idle', workingDirectory: '/tmp', threadId: 'existing', contextModel: 'model', contextWindow: 100000, contextTokens: 59999 };
  assert.equal(idleCompactionDue(s), false);
  s.contextTokens = 60000;
  assert.equal(idleCompactionDue(s), true);
  assert.equal(idleCompactionDue({ ...s, state: 'processing' }), false);
  assert.equal(idleCompactionDue({ ...s, activeJobId: 'running' }), false);
  assert.equal(idleCompactionDue({ ...s, queuePaused: true }), false);
  assert.equal(idleCompactionDue({ ...s, contextWindow: undefined, contextTokens: 5000000 }), false);
  assert.equal(idleCompactionDue({ ...s, lastCompactionTokens: 60000 }), false);
  assert.equal(idleCompactionDue({ ...s, lastCompactionTokens: 60000, contextTokens: 63000 }), true);
  assert.equal(COMPACTION_IDLE_MS, 30000);
});
