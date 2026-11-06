// Persistent local relay for the official Codex stdio app-server. No model
// requests are synthesized: every turn/start comes from an existing job.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { mkdirSync, lstatSync, unlinkSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { llmRuntimeRegistration } = await import(pathToFileURL(resolve(process.env.WCB_BUILD_DIR ?? 'dist', 'src/llm.js')).href);
const { archiveRetiredThreads } = await import(pathToFileURL(resolve(process.env.WCB_BUILD_DIR ?? 'dist', 'src/thread-retirement.js')).href);

const directory = process.env.WCB_DATA_DIR || join(homedir(), '.wechat-codex-desktop', 'app');
const path = join(directory, 'codex-runtime.sock');
mkdirSync(directory, { recursive: true, mode: 0o700 });
try {
  if (!lstatSync(path).isSocket()) throw new Error('Runtime socket path is occupied by a regular file');
  unlinkSync(path);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const registration = llmRuntimeRegistration(directory);
const codex = spawn('codex', ['app-server', ...registration.args], {
  env: { ...process.env, ...registration.env }, stdio: ['pipe', 'pipe', 'inherit'] });
const clients = new Map();
const pending = new Map();
const requests = new Map();
const maintenanceRequests = new Map();
// Ephemeral threads stay loaded in this server but have no rollout to resume
// from disk. Keep their current metadata for later workers in the same run.
const ephemeralThreads = new Map();
const send = value => codex.stdin.write(JSON.stringify(value) + '\n');
const reply = (socket, value) => { if (!socket.destroyed) socket.write(JSON.stringify(value) + '\n'); };
let sequence = 0;
let initialized;
const ready = new Promise((resolve, reject) => { initialized = { resolve, reject }; });
const upstream = createInterface({ input: codex.stdout });
upstream.on('line', line => {
  let value;
  try { value = JSON.parse(line); } catch { return; }
  if (value.id === 'initialize' && !value.method) {
    if (value.error) initialized.reject(new Error(value.error.message));
    else { send({ method: 'initialized', params: {} }); initialized.resolve(value.result); }
    return;
  }
  if (value.id !== undefined && !value.method) {
    const maintenance = maintenanceRequests.get(value.id);
    if (maintenance) {
      clearTimeout(maintenance.timer); maintenanceRequests.delete(value.id);
      if (value.error) maintenance.reject(new Error(value.error.message)); else maintenance.resolve(value.result);
      return;
    }
    const owner = pending.get(value.id);
    if (!owner) return;
    pending.delete(value.id);
    const thread = value.result?.thread?.id;
    if (value.result?.thread?.ephemeral) ephemeralThreads.set(thread, value.result);
    if (thread) clients.get(owner.socket)?.add(thread);
    reply(owner.socket, { ...value, id: owner.id });
    return;
  }
  const thread = value.params?.threadId ?? value.params?.thread?.id;
  if (value.method === 'thread/status/changed' && ephemeralThreads.has(thread)) {
    ephemeralThreads.get(thread).thread.status = value.params.status;
  }
  if (value.method === 'thread/closed') ephemeralThreads.delete(thread);
  if (value.id !== undefined) {
    const owner = [...clients].find(([, threads]) => threads.has(thread))?.[0];
    if (owner) { requests.set(value.id, owner); reply(owner, value); }
    else send({ id: value.id, error: { code: -32601, message: 'No active WeChat job can answer this request' } });
    return;
  }
  for (const [socket, threads] of clients) if (thread && threads.has(thread)) reply(socket, value);
});
codex.on('error', error => { console.error(error.message); process.exit(1); });
codex.on('exit', code => process.exit(code || 1));
send({ id: 'initialize', method: 'initialize', params: {
  clientInfo: { name: 'wechat_codex', version: '1.0.0' }, capabilities: { experimentalApi: true },
} });
const capabilities = await ready;
const maintenanceRpc = (method, params) => new Promise((resolve, reject) => {
  const id = `maintenance-${++sequence}`;
  const timer = setTimeout(() => { maintenanceRequests.delete(id); reject(new Error(`${method} timed out`)); }, 30000);
  maintenanceRequests.set(id, { resolve, reject, timer });
  send({ id, method, params });
});
let sweeping = false;
async function sweepRetired() {
  if (sweeping) return;
  sweeping = true;
  try { await archiveRetiredThreads(directory, maintenanceRpc, () => new Set([...clients.values()].flatMap(threads => [...threads]))); }
  catch (error) { console.error('Retired thread sweep deferred:', String(error)); }
  finally { sweeping = false; }
}
const retirementTimer = setInterval(() => { void sweepRetired(); }, 60000);
retirementTimer.unref();
void sweepRetired();
const allowed = new Set(['thread/start', 'thread/resume', 'thread/name/set', 'turn/start', 'turn/steer', 'turn/interrupt', 'thread/compact/start', 'account/read']);
const server = createServer(socket => {
  clients.set(socket, new Set());
  createInterface({ input: socket }).on('line', line => {
    let value;
    try { value = JSON.parse(line); } catch { return; }
    if (value.method === 'initialize') { reply(socket, { id: value.id, result: capabilities }); return; }
    if (value.method === 'initialized') return;
    if (!value.method && requests.get(value.id) === socket) { requests.delete(value.id); send(value); return; }
    if (!allowed.has(value.method)) { reply(socket, { id: value.id, error: { code: -32601, message: 'Unsupported runtime request' } }); return; }
    // Older acceptance builds omit this field. Only callers that explicitly
    // need resumable production history should create a persistent thread.
    if (value.method === 'thread/start') value.params = { ...value.params, ephemeral: value.params?.ephemeral ?? true };
    if (value.params?.threadId) clients.get(socket).add(value.params.threadId);
    if (value.method === 'thread/resume' && ephemeralThreads.has(value.params.threadId)) {
      reply(socket, { id: value.id, result: ephemeralThreads.get(value.params.threadId) });
      return;
    }
    const id = `request-${++sequence}`;
    pending.set(id, { socket, id: value.id });
    send({ ...value, id });
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    clients.delete(socket);
    for (const [id, owner] of pending) if (owner.socket === socket) pending.delete(id);
    for (const [id, owner] of requests) if (owner === socket) {
      requests.delete(id); send({ id, error: { code: -32603, message: 'WeChat job disconnected' } });
    }
  });
});
server.listen(path, () => { chmodSync(path, 0o600); console.log('Codex runtime ready'); });
function stop() { clearInterval(retirementTimer); server.close(); for (const socket of clients.keys()) socket.destroy(); codex.kill('SIGTERM'); }
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
