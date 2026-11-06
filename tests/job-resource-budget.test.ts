import test from 'node:test';
import assert from 'node:assert/strict';
import { jobResourceProperties } from '../src/jobs.js';

test('background and character workers have separate bounded resource pools', () => {
  for (const kind of ['life', 'consolidate', 'compact'] as const) {
    const values = jobResourceProperties({kind});
    assert.ok(values.includes('--slice=wechat-background.slice'));
    assert.ok(values.includes('--property=MemoryMax=512M'));
    assert.ok(values.includes('--property=MemorySwapMax=256M'));
  }
  const chat = jobResourceProperties({kind: 'codex', options: {cwd: '/tmp', prompt: 'fixture', profile: 'companion', mode: 'plan'}});
  assert.ok(chat.includes('--slice=wechat-chat.slice'));
  assert.ok(chat.includes('--property=MemoryMax=512M'));
  assert.deepEqual(jobResourceProperties({kind: 'update'}), []);
});
