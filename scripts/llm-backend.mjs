// Existing foreground-only configurations keep their behavior. Character-wide
// configurations switch generation, review, repair, memory and life together.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

const args = process.argv.slice(2).filter(arg => arg !== '--desktop');
const directory = process.env.WCB_DATA_DIR || join(homedir(), '.wechat-codex-desktop', 'app');
const build = process.env.WCB_BUILD_DIR ?? fileURLToPath(new URL('../dist-desktop/', import.meta.url));
const { readLlmConfiguration } = await import(pathToFileURL(resolve(build, 'src/llm.js')).href);
const folder = join(directory, 'providers');
const path = join(folder, 'llm.json');
const config = readLlmConfiguration(directory);
const command = args[0] ?? 'status';
if (command === 'use') {
  const id = args[1];
  if (!id || (id !== 'codex' && !config.providers[id])) throw new Error('Choose codex or a configured provider');
  if (id !== 'codex') {
    const credential = JSON.parse(readFileSync(join(folder, `${id}.json`), 'utf8'));
    if (!credential.apiKey) throw new Error('Provider API key is missing');
  }
  config.active = id;
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
  if (config.scope === 'character') {
    const heartbeatPath = join(folder, 'heartbeat.json');
    let heartbeat = { backend: 'codex', apiModel: 'gpt-6.1-sol', codexModel: 'gpt-6-luna' };
    try { heartbeat = { ...heartbeat, ...JSON.parse(readFileSync(heartbeatPath, 'utf8')) }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    heartbeat.backend = id === 'codex' ? 'codex' : 'api';
    const pending = `${heartbeatPath}.${process.pid}.tmp`;
    writeFileSync(pending, JSON.stringify(heartbeat, null, 2) + '\n', { mode: 0o600 }); renameSync(pending, heartbeatPath);
  }
} else if (command !== 'status') throw new Error('Usage: node scripts/llm-backend.mjs [--desktop] status|use PROVIDER');
console.log(JSON.stringify({ scope: config.scope === 'character' ? 'character generation, review, repair, memory and life' : 'foreground WeChat companion only', active: config.active,
  model: config.active === 'codex' ? 'existing Codex chat selection' : config.providers[config.active].model,
  reasoningEffort: config.active === 'codex' ? 'existing chat selection' : config.providers[config.active].reasoningEffort,
  useRoleModels: config.active !== 'codex' && config.providers[config.active].useRoleModels === true,
  available: ['codex', ...Object.keys(config.providers)],
  effective: 'next foreground turn; running jobs keep their model; saved conversations and memories are retained' }, null, 2));
