import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// Stub only the child process's homedir API; never repoint the real HOME or
// invoke a model. All configuration mutations stay inside the temporary tree.
const child = `
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
const [, testHome, script, ...args] = process.argv;
os.homedir = () => testHome;
syncBuiltinESMExports();
process.argv = [process.execPath, script, ...args];
await import(pathToFileURL(script).href);
`;

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'ruanruan-backends-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const desktop = join(home, '.wechat-codex-desktop', 'app');
  const control = join(home, '.wechat-codex-bridge');
  const explicit = join(home, 'explicit-app');
  for (const directory of [desktop, control, explicit]) {
    mkdirSync(join(directory, 'providers'), { recursive: true });
    writeFileSync(join(directory, 'providers', 'llm.json'), JSON.stringify({ active: 'codex', providers: {}, scope: 'character' }));
    writeFileSync(join(directory, 'providers', 'heartbeat.json'), JSON.stringify({ backend: 'api', apiModel: 'offline-test-model' }));
  }
  const heartbeat = directory => JSON.parse(readFileSync(join(directory, 'providers', 'heartbeat.json')));
  function run(name, args, selected) {
    const script = fileURLToPath(new URL(`../scripts/${name}.mjs`, import.meta.url));
    const env = { ...process.env };
    delete env.WCB_DATA_DIR; delete env.WCB_BUILD_DIR;
    if (selected) env.WCB_DATA_DIR = selected;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', child, home, script, ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  return { desktop, control, explicit, heartbeat, run };
}

test('LLM selector defaults to the character app and does not change the separate control heartbeat', t => {
  const f = fixture(t);
  const control = f.heartbeat(f.control);
  f.run('llm-backend', ['use', 'codex']);
  assert.equal(f.heartbeat(f.desktop).backend, 'codex');
  assert.deepEqual(f.heartbeat(f.control), control);
  assert.equal(f.heartbeat(f.explicit).backend, 'api');
});

test('LLM selector honors an explicit data root even with the supported desktop flag', t => {
  const f = fixture(t);
  f.run('llm-backend', ['--desktop', 'use', 'codex'], f.explicit);
  assert.equal(f.heartbeat(f.explicit).backend, 'codex');
  assert.equal(f.heartbeat(f.desktop).backend, 'api');
  assert.equal(f.heartbeat(f.control).backend, 'api');
});

test('heartbeat selector defaults to the character app only', t => {
  const f = fixture(t);
  f.run('heartbeat-backend', ['codex']);
  assert.equal(f.heartbeat(f.desktop).backend, 'codex');
  assert.equal(f.heartbeat(f.control).backend, 'api');
});

test('heartbeat selector honors an explicit data root', t => {
  const f = fixture(t);
  f.run('heartbeat-backend', ['codex'], f.explicit);
  assert.equal(f.heartbeat(f.explicit).backend, 'codex');
  assert.equal(f.heartbeat(f.desktop).backend, 'api');
  assert.equal(f.heartbeat(f.control).backend, 'api');
});
