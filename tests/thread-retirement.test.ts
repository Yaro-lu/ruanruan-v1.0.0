import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { retireThread, archiveRetiredThreads } from '../src/thread-retirement.js';
import { createSessionStore } from '../src/session.js';

function fixture(t: any) {
  const directory = mkdtempSync(join(tmpdir(), 'thread-retirement-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const id = randomUUID(), calls: string[] = [];
  const thread = { id, name: '微信 · 阮阮', cwd: join(directory, 'chat-workspace'), status: { type: 'idle' }, ephemeral: false };
  let confirmed = false;
  const rpc = async (method: string, params: any) => {
    calls.push(method);
    if (method === 'thread/read') return { thread };
    if (method === 'thread/list') {
      if (params.ancestorThreadId) {
        assert.ok(params.sourceKinds.includes('subAgentThreadSpawn'));
        return { data: [], nextCursor: null };
      }
      assert.equal(params.archived, true); assert.deepEqual(params.modelProviders, []);
      return { data: confirmed ? [thread] : [], nextCursor: null };
    }
    assert.equal(method, 'thread/archive'); assert.equal(params.threadId, id);
    confirmed = true; return {};
  };
  const candidate = join(directory, 'retired-threads', `${id}.json`);
  const write = (path: string, value: any) => writeFileSync(path, JSON.stringify(value));
  const sweep = (client = new Set<string>()) => archiveRetiredThreads(directory, rpc, () => client, Date.now() + 61000);
  return { directory, id, calls, thread, rpc, candidate, write, sweep };
}

test('session replacement and clear queue the retired id; current conversation continues unchanged', async t => {
  const f = fixture(t), store = createSessionStore(join(f.directory, 'sessions'));
  const current = { threadId: f.id, state: 'idle' as const, workingDirectory: f.thread.cwd };
  store.save('peer', current); assert.equal(existsSync(f.candidate), false);
  store.save('peer', { ...current, threadId: randomUUID() });
  assert.ok(existsSync(f.candidate));
  await f.sweep();
  assert.equal(f.calls.filter(method => method === 'thread/archive').length, 1);
  assert.equal(existsSync(f.candidate), false);
  assert.equal(JSON.parse(readFileSync(join(f.directory, 'thread-archives.jsonl'), 'utf8')).threadId, f.id);
  const next = store.load('peer').threadId!;
  store.clear('peer', store.load('peer'));
  assert.ok(existsSync(join(f.directory, 'retired-threads', `${next}.json`)));
});

test('current sessions, work contexts, connected workers and active native turns are protected', async t => {
  const f = fixture(t), store = createSessionStore(join(f.directory, 'sessions'));
  retireThread(f.directory, f.id);
  await archiveRetiredThreads(f.directory, f.rpc);
  assert.equal(f.calls.length, 0, 'retirement grace period');
  for (const fields of [{ threadId: f.id }, { workContext: { threadId: f.id } }]) {
    store.save('peer', { ...fields, state: 'idle', workingDirectory: f.thread.cwd });
    await f.sweep(); assert.equal(f.calls.length, 0);
  }
  store.clear('peer'); await f.sweep(new Set([f.id])); assert.equal(f.calls.length, 0);
  f.thread.status.type = 'active'; await f.sweep();
  assert.equal(f.calls.includes('thread/archive'), false); assert.ok(existsSync(f.candidate));
});

test('running jobs and completed jobs awaiting delivery keep their original thread', async t => {
  const f = fixture(t), jobId = randomUUID(), path = join(f.directory, 'jobs', jobId);
  mkdirSync(path, { recursive: true });
  f.write(join(path, 'job.json'), { session: { threadId: f.id } });
  retireThread(f.directory, f.id);
  f.write(join(path, 'status.json'), { state: 'running' });
  await f.sweep(); assert.equal(f.calls.length, 0);
  f.write(join(path, 'status.json'), { state: 'completed' });
  const store = createSessionStore(join(f.directory, 'sessions'));
  store.save('peer', { threadId: randomUUID(), activeJobId: jobId, state: 'idle', workingDirectory: f.thread.cwd });
  await f.sweep(); assert.equal(f.calls.length, 0);
  store.clear('peer'); await f.sweep(); assert.ok(f.calls.includes('thread/archive'));
});

test('failed or unconfirmed archives survive restart and are retried without duplicate completion', async t => {
  const f = fixture(t); retireThread(f.directory, f.id);
  await archiveRetiredThreads(f.directory, async (method, params) => {
    if (method === 'thread/archive') throw new Error('active writer');
    return f.rpc(method, params);
  }, undefined, Date.now() + 61000);
  assert.ok(existsSync(f.candidate));
  await archiveRetiredThreads(f.directory, async (method, params) => {
    if (method === 'thread/list') return { data: [], nextCursor: null };
    return f.rpc(method, params);
  }, undefined, Date.now() + 61000);
  assert.ok(existsSync(f.candidate));
  await f.sweep(); assert.equal(existsSync(f.candidate), false);
  assert.equal(f.calls.filter(method => method === 'thread/archive').length, 1, 'already archived thread is only verified on retry');
});

test('scope checks exclude other workspaces and assistants, and resume during reads cancels archival', async t => {
  const f = fixture(t); retireThread(f.directory, f.id);
  const cwd = f.thread.cwd;
  f.thread.cwd = tmpdir(); await f.sweep();
  f.thread.cwd = cwd; f.thread.name = '微信 · 助手'; await f.sweep();
  assert.equal(f.calls.includes('thread/archive'), false);
  f.thread.name = '微信 · 阮阮';
  await archiveRetiredThreads(f.directory, async (method, params) => {
    const value = await f.rpc(method, params);
    if (method === 'thread/list') createSessionStore(join(f.directory, 'sessions')).save('peer', {
      threadId: f.id, state: 'processing', workingDirectory: cwd,
    });
    return value;
  }, undefined, Date.now() + 61000);
  assert.equal(f.calls.includes('thread/archive'), false); assert.ok(existsSync(f.candidate));
});

test('threads with descendants are retained because native archival cascades', async t => {
  const f = fixture(t); retireThread(f.directory, f.id);
  await archiveRetiredThreads(f.directory, async (method, params) => {
    if (params.ancestorThreadId) return { data: [{ id: randomUUID(), status: { type: 'active' } }] };
    return f.rpc(method, params);
  }, undefined, Date.now() + 61000);
  assert.equal(f.calls.includes('thread/archive'), false); assert.ok(existsSync(f.candidate));
});
test('named group and private character threads follow the same verified retirement lifecycle',async t=>{
  for(const name of ['微信 · 阮阮 · 群聊：钓鱼群','微信 · 阮阮 · 私聊：测试哥']) {
    const f=fixture(t);f.thread.name=name;retireThread(f.directory,f.id);await f.sweep();
    assert.ok(f.calls.includes('thread/archive'));assert.equal(existsSync(f.candidate),false);
  }
});
