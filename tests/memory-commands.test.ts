import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'memory-commands-'));
process.env.WCB_DATA_DIR = root;
const { createMemoryStore } = await import('../src/memory.js');
const { routeCommand } = await import('../src/commands/router.js');
test.after(() => rmSync(root, { recursive: true, force: true }));

test('memory commands show sources and forget only the selected note while refreshing the thread', () => {
  const memory = createMemoryStore('owner');
  memory.save({ version: 1, notes: [
    { id: 'keep', kind: 'task', text: '尚未完成的任务', updatedAt: '2026-10-01T00:00:00Z' },
    { id: 'remove', kind: 'fact', text: '钓鱼用玉米', updatedAt: '2026-10-02T00:00:00Z' },
  ], recent: [], handoff: '钓鱼用玉米' });
  const session: any = { workingDirectory: root, state: 'idle', threadId: 'old', model: 'chosen' };
  const ctx = { accountId: 'owner', session, text: '/memory remove',
    updateSession: (partial: any) => Object.assign(session, partial), clearSession: () => session };
  assert.match(routeCommand(ctx).reply!, /钓鱼用玉米/);
  assert.match(routeCommand(ctx).reply!, /未补造原话来源/);
  ctx.text = '/forget remove';
  assert.match(routeCommand(ctx).reply!, /已删除/);
  assert.equal(session.threadId, undefined);
  assert.equal(session.model, 'chosen');
  assert.deepEqual(memory.load().notes.map(note => note.id), ['keep']);
  assert.equal(memory.load().handoff, '');
  ctx.text = '/forget ../oops';
  assert.match(routeCommand(ctx).reply!, /用法/);
});

test('persona command reports the assembled version and files instead of generating a status claim', () => {
  mkdirSync(join(root, 'persona'), { recursive: true });
  writeFileSync(join(root, 'persona.md'), '阮阮核心人格 v3\n测试核心');
  for (const name of ['BACKSTORY.md', 'RELATIONSHIP.md', 'STYLE.md']) writeFileSync(join(root, 'persona', name), `测试${name}`);
  const session: any = { workingDirectory: root, state: 'idle' };
  const reply = routeCommand({ accountId: 'owner', session, text: '/persona',
    updateSession: () => {}, clearSession: () => session }).reply!;
  assert.match(reply, /ruanruan-core-v3/);
  assert.match(reply, /persona\/BACKSTORY.md/);
  assert.match(reply, /persona\/RELATIONSHIP.md/);
  assert.match(reply, /persona\/STYLE.md/);
  assert.match(reply, /尚无带版本记录的请求/);
});
