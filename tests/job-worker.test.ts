import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function fixture(t: any, hang = false, routed = false) {
  const root = mkdtempSync(join(tmpdir(), 'worker-test-'));
  const id = randomUUID(), dir = join(root, 'jobs', id);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(root, 'bin'));
  const task = { id: 'routing-test', summary: '分析方案', state: 'active', updatedAt: Date.now() };
  const routing = routed ? { kind: 'complex', reason: 'test', task,
    options: { model: 'gpt-6.1-sol', reasoningEffort: 'max', serviceTier: 'default' } } : undefined;
  const envelope = { handoff: '完成', upsert: [], remove: [], ...(routed ? { task: { id: task.id, status: 'needs_input' } } : {}) };
  const fake = `#!${process.execPath}
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(join(root, 'calls'))}, '1');
fs.writeFileSync(${JSON.stringify(join(root, 'args'))}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({type:'thread.started',thread_id:'test-thread'}));
console.log(JSON.stringify({type:'item.started',item:{type:'command_execution'}}));
${hang ? `const {spawn}=require('child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(join(root, 'child.pid'))}, String(child.pid)); setInterval(()=>{},1000);` : `setTimeout(()=>console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'完成\\n<<<WCB_MEMORY_V1>>>\\n'+JSON.stringify(${JSON.stringify(envelope)})}})),1500);`}
`;
  writeFileSync(join(root, 'bin', 'codex'), fake, { mode: 0o700 });
  const job = { id, accountId: 'test-owner', createdAt: Date.now(), kind: 'codex', userText: 'test',
    fromUserId: 'test', contextToken: 'test', tempFiles: [],
    routing, session: { state: 'processing', workingDirectory: root, routingTask: routing?.task },
    options: { prompt: 'test', cwd: root, mode: 'plan', model: 'fake', reasoningEffort: 'medium', ...routing?.options } };
  writeFileSync(join(dir, 'job.json'), JSON.stringify(job));
  const worker = spawn(process.execPath, [fileURLToPath(new URL('../src/job-worker.js', import.meta.url)), id], {
    env: { ...process.env, WCB_DATA_DIR: root, PATH: `${join(root, 'bin')}:${process.env.PATH}` }, stdio: 'ignore',
  });
  const done = new Promise<number | null>(r => worker.on('exit', r));
  t.after(() => { worker.kill(); rmSync(root, { recursive: true, force: true }); });
  const status = () => JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'));
  for (let i = 0; i < 100 && !existsSync(join(root, 'calls')); i++) await wait(30);
  assert.ok(existsSync(join(root, 'calls')));
  return { root, dir, status, done };
}
test('independent worker persists progress, final result and memory without a bridge process', async t => {
  const f = await fixture(t);
  assert.equal(f.status().state, 'running');
  assert.equal(await f.done, 0);
  assert.equal(f.status().state, 'completed');
  assert.equal(f.status().result.replyText, '完成');
  assert.equal(f.status().executionStarted, true);
  assert.equal(f.status().session.threadId, 'test-thread');
  assert.equal(readFileSync(join(f.root, 'calls'), 'utf8'), '1');
  assert.ok(existsSync(join(f.dir, 'events.jsonl')));
});
test('durable stop request terminates Codex and its child, records stopped, never retries', async t => {
  const f = await fixture(t, true);
  for (let i = 0; i < 100 && !existsSync(join(f.root, 'child.pid')); i++) await wait(20);
  const pid = Number(readFileSync(join(f.root, 'child.pid'), 'utf8'));
  writeFileSync(join(f.dir, 'stop'), '');
  assert.equal(await f.done, 0);
  assert.equal(f.status().state, 'stopped');
  assert.match(f.status().result.error, /已停止/);
  assert.equal(readFileSync(join(f.root, 'calls'), 'utf8'), '1');
  // A killed orphan can briefly remain as a zombie until PID 1 reaps it.
  if (existsSync(`/proc/${pid}/stat`)) assert.match(readFileSync(`/proc/${pid}/stat`, 'utf8'), /\) Z /);
});

test('worker persists unfinished business task despite completed process and strips its metadata', async t => {
  const f = await fixture(t, false, true);
  assert.equal(await f.done, 0);
  const status = f.status();
  assert.equal(status.state, 'completed');
  assert.equal(status.session.routingTask.state, 'needs_input');
  assert.equal(status.result.replyText, '完成');
  const args = JSON.parse(readFileSync(join(f.root, 'args'), 'utf8'));
  assert.ok(args.includes('service_tier="default"'));
  assert.ok(args.includes('model_reasoning_effort="max"'));
  assert.equal(readFileSync(join(f.root, 'calls'), 'utf8'), '1');
});
