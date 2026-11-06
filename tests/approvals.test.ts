import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApprovalStore } from '../src/approvals.js';

test('approval is bound to owner, request and explicit reply, persists and cannot be replayed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'approval-')); let now = 1000;
  try {
    const s = createApprovalStore(dir, () => now);
    const a = s.create({ accountId: 'bot', userId: 'owner', summary: 'test only', details: 'no operation', origin: 'test' }, 100);
    s.resolveReply('bot', 'stranger', `同意 ${a.code}`);
    assert.equal(s.find(a.code)?.state, 'pending');
    assert.equal(s.resolveReply('bot', 'owner', '好的'), undefined);
    s.resolveReply('bot', 'owner', `同意测试${a.code} 备注`);
    assert.equal(createApprovalStore(dir, () => now).find(a.code)?.state, 'approved');
    s.resolveReply('bot', 'owner', `拒绝 ${a.code}`);
    assert.equal(s.find(a.code)?.state, 'approved');
    const b = s.create({ accountId: 'bot', userId: 'owner', summary: 'expired', details: '', origin: 'test' }, 100);
    now = 1200; s.resolveReply('bot', 'owner', `同意 ${b.code}`);
    assert.equal(s.find(b.code)?.state, 'expired');
    const c = s.create({ accountId: 'bot', userId: 'owner', summary: 'reject', details: '', origin: 'test' });
    s.resolveReply('bot', 'owner', `不同意 ${c.code}`);
    assert.equal(s.find(c.code)?.state, 'rejected');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
