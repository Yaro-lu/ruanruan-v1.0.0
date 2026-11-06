import { appendFileSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { saveJson } from './store.js';
import {isCharacterThreadTitle} from './thread-continuity.js';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const sourceKinds = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
  'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
const queue = (directory: string) => join(directory, 'retired-threads');
function entries(directory: string): string[] {
  try { return readdirSync(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
const read = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));

// Persist retirement before dropping the old id. Current references always win
// over this queue, including after a crash between these two writes.
export function retireThread(directory: string, threadId?: string) {
  if (!threadId || !uuid.test(threadId)) return;
  mkdirSync(queue(directory), { recursive: true, mode: 0o700 });
  const path = join(queue(directory), `${threadId}.json`);
  try { readFileSync(path); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  saveJson(path, { threadId, retiredAt: Date.now() });
}

function protectedThreads(directory: string): Set<string> {
  const threads = new Set<string>(), jobs = new Set<string>();
  const addSession = (session: any) => {
    if (session?.threadId) threads.add(session.threadId);
    if (session?.workContext?.threadId) threads.add(session.workContext.threadId);
  };
  for (const name of entries(join(directory, 'sessions')).filter(name => name.endsWith('.json'))) {
    const session = read(join(directory, 'sessions', name));
    addSession(session);
    for (const key of ['activeJobId', 'workJobId', 'backgroundJobId']) if (session[key]) jobs.add(session[key]);
  }
  for (const id of entries(join(directory, 'jobs')).filter(id => uuid.test(id))) {
    const status = read(join(directory, 'jobs', id, 'status.json'));
    if (!jobs.has(id) && !['pending', 'running'].includes(status.state)) continue;
    const job = read(join(directory, 'jobs', id, 'job.json'));
    addSession(job.session); addSession(status.session);
    for (const thread of [status.threadId, status.result?.threadId]) if (thread) threads.add(thread);
  }
  return threads;
}

type Rpc = (method: string, params: any) => Promise<any>;
async function archived(rpc: Rpc, thread: any): Promise<boolean> {
  let cursor: string | undefined;
  do {
    const page = await rpc('thread/list', { archived: true, cwd: thread.cwd, searchTerm: thread.name,
      modelProviders: [], sourceKinds, limit: 100, cursor });
    if (page.data.some((row: any) => row.id === thread.id)) return true;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return false;
}

// Called only by the owning runtime, never exposed as a worker RPC. One sweep
// cannot stop a chat: failures retain the candidate for the next sweep.
export async function archiveRetiredThreads(directory: string, rpc: Rpc,
  connected: () => Set<string> = () => new Set(), now = Date.now()) {
  for (const name of entries(queue(directory)).filter(name => uuid.test(name.slice(0, -5)) && name.endsWith('.json'))) {
    const path = join(queue(directory), name);
    try {
      const candidate = read(path), id = candidate.threadId;
      if (`${id}.json` !== name || now - candidate.retiredAt < 60000) continue;
      if (protectedThreads(directory).has(id) || connected().has(id)) continue;
      const { thread } = await rpc('thread/read', { threadId: id, includeTurns: false });
      if (thread.ephemeral || !isCharacterThreadTitle(thread.name)
        || resolve(thread.cwd) !== resolve(directory, 'chat-workspace')) continue;
      if (!['idle', 'notLoaded'].includes(thread.status?.type)) continue;
      // Native archival cascades to descendants. Leave any such tree to an
      // explicit app cleanup rather than archiving another task implicitly.
      const children = await rpc('thread/list', { ancestorThreadId: id, archived: false, modelProviders: [], sourceKinds, limit: 1 });
      if (children.data.length) continue;
      const alreadyArchived = await archived(rpc, thread);
      if (protectedThreads(directory).has(id) || connected().has(id)) continue;
      if (!alreadyArchived) {
        // Recheck after async reads; a new worker may have resumed this thread.
        const latest = await rpc('thread/read', { threadId: id, includeTurns: false });
        if (!['idle', 'notLoaded'].includes(latest.thread.status?.type)
          || protectedThreads(directory).has(id) || connected().has(id)) continue;
        await rpc('thread/archive', { threadId: id });
        if (!await archived(rpc, thread)) throw new Error('Archive not confirmed by thread/list');
      }
      appendFileSync(join(directory, 'thread-archives.jsonl'), JSON.stringify({ threadId: id, archivedAt: new Date(now).toISOString() }) + '\n', { mode: 0o600 });
      unlinkSync(path);
    } catch (error) { console.error('Retired thread archive deferred:', name, String(error)); }
  }
}
