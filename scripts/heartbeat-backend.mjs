import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
const directory = join(process.env.WCB_DATA_DIR ?? join(homedir(), '.wechat-codex-desktop', 'app'), 'providers');
const path = join(directory, 'heartbeat.json');
let config = { backend: 'codex', apiModel: 'gpt-6.1-sol', codexModel: 'gpt-6-luna' };
try { config = { ...config, ...JSON.parse(readFileSync(path, 'utf8')) }; }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const backend = process.argv[2];
if (backend && !['api', 'codex', 'status'].includes(backend)) throw new Error('Usage: node scripts/heartbeat-backend.mjs api|codex|status');
if (backend && backend !== 'status') {
  config.backend = backend;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 }); renameSync(temp, path);
}
console.log(JSON.stringify({ backend: config.backend, model: config.backend === 'api' ? config.apiModel : config.codexModel,
  reasoningEffort: 'medium', effective: 'next heartbeat; active attempt keeps its selected provider' }, null, 2));
