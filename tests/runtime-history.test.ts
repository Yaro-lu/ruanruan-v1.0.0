import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';

test('relay resumes live ephemeral threads across workers and preserves their active status', { timeout: 10000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'wcb-history-test-'));
  const retired = '11111111-1111-4111-8111-111111111111';
  mkdirSync(join(root, 'retired-threads'));
  writeFileSync(join(root, 'retired-threads', `${retired}.json`), JSON.stringify({ threadId: retired, retiredAt: Date.now() - 61000 }));
  const fake = `#!${process.execPath}
const { createInterface } = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const status = type => send({ method: 'thread/status/changed', params: { threadId: 'temporary', status: { type } } });
let archived = false;
const retired = { id: '${retired}', name: '微信 · 阮阮', cwd: ${JSON.stringify(join(root, 'chat-workspace'))}, ephemeral: false, status: { type: 'idle' } };
createInterface({ input: process.stdin }).on('line', line => {
  const value = JSON.parse(line), p = value.params || {};
  const reply = result => send({ id: value.id, result });
  if (value.method === 'initialize') reply({});
  if (value.method === 'thread/read') reply({ thread: retired });
  if (value.method === 'thread/list') reply({ data: p.archived && archived ? [retired] : [], nextCursor: null });
  if (value.method === 'thread/archive') { archived = true; reply({}); }
  if (value.method === 'thread/start') reply({ thread: { id: p.ephemeral ? 'temporary' : 'persistent', ephemeral: p.ephemeral, status: { type: 'idle' } } });
  if (value.method === 'thread/resume') {
    if (p.threadId === 'temporary') send({ id: value.id, error: { message: 'no rollout found' } });
    else reply({ thread: { id: 'persistent', ephemeral: false }, resumedFromDisk: true });
  }
  if (value.method === 'turn/start') { status('active'); reply({ turn: { id: 'turn' } }); }
  if (value.method === 'turn/interrupt') {
    if (p.turnId === 'close') send({ method: 'thread/closed', params: { threadId: 'temporary' } });
    else status('idle');
    reply({});
  }
});
`;
  writeFileSync(join(root, 'codex'), fake, { mode: 0o700 });
  const relay = spawn(process.execPath, [resolve('scripts/codex-runtime.mjs')], {
    env: { ...process.env, PATH: `${root}:${process.env.PATH}`, WCB_DATA_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sockets: ReturnType<typeof createConnection>[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (relay.exitCode === null) { const exited = once(relay, 'exit'); relay.kill('SIGTERM'); await exited; }
    rmSync(root, { recursive: true, force: true });
  });
  let stderr = '';
  relay.stderr.on('data', data => { stderr += data; });
  await new Promise<void>((resolve, reject) => {
    createInterface({ input: relay.stdout }).on('line', line => { if (line === 'Codex runtime ready') resolve(); });
    relay.once('error', reject);
    relay.once('exit', code => reject(new Error(`relay exited ${code}: ${stderr}`)));
  });
  function client() {
    const socket = createConnection(join(root, 'codex-runtime.sock'));
    sockets.push(socket);
    let sequence = 0;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    createInterface({ input: socket }).on('line', line => {
      const value = JSON.parse(line), item = pending.get(value.id);
      if (!item || value.method) return;
      clearTimeout(item.timer); pending.delete(value.id);
      if (value.error) item.reject(new Error(value.error.message)); else item.resolve(value.result);
    });
    return (method: string, params: any = {}): Promise<any> => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('RPC timed out')); }, 3000);
      pending.set(id, { resolve, reject, timer });
      socket.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  const first = client();
  await assert.rejects(first('thread/archive', { threadId: retired }), /Unsupported runtime request/);
  assert.equal((await first('thread/start')).thread.ephemeral, true);
  sockets[0].end();
  const second = client();
  assert.equal((await second('thread/resume', { threadId: 'temporary' })).thread.status.type, 'idle');
  await second('turn/start', { threadId: 'temporary' });
  const third = client();
  assert.equal((await third('thread/resume', { threadId: 'temporary' })).thread.status.type, 'active');
  await second('turn/interrupt', { threadId: 'temporary', turnId: 'turn' });
  assert.equal((await third('thread/resume', { threadId: 'temporary' })).thread.status.type, 'idle');
  assert.equal((await second('thread/start', { ephemeral: false })).thread.ephemeral, false);
  assert.equal((await third('thread/resume', { threadId: 'persistent' })).resumedFromDisk, true);
  await second('turn/interrupt', { threadId: 'temporary', turnId: 'close' });
  await assert.rejects(third('thread/resume', { threadId: 'temporary' }), /no rollout found/);
  const deadline = Date.now() + 3000;
  while (existsSync(join(root, 'retired-threads', `${retired}.json`)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(existsSync(join(root, 'retired-threads', `${retired}.json`)), false, stderr);
  assert.equal(JSON.parse(readFileSync(join(root, 'thread-archives.jsonl'), 'utf8')).threadId, retired);
});
