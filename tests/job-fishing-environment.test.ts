import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'job-fishing-environment-'));
process.env.WCB_DATA_DIR = directory;
const { createJob, launchJob } = await import('../src/jobs.js');
test.after(() => rmSync(directory, { recursive: true, force: true }));

test('job launch passes only the two explicit fishing settings to the tool worker', t => {
  const calls: { command: string; args: readonly string[] }[] = [];
  t.mock.method(childProcess, 'execFileSync', (command: string, args: readonly string[]) => {
    calls.push({ command, args });
    return '';
  });
  syncBuiltinESMExports();
  const keys = ['WCB_FISHING_GROUP_ID', 'WCB_FISHING_GROUP_NAME', 'WCB_FISHING_PRIVATE_FIXTURE'];
  const previous = keys.map(key => process.env[key]);
  try {
    process.env.WCB_FISHING_GROUP_ID = '90000000001@chatroom';
    process.env.WCB_FISHING_GROUP_NAME = '离线钓鱼测试群';
    process.env.WCB_FISHING_PRIVATE_FIXTURE = 'must-not-forward';
    const job = createJob({ accountId: 'desktop-fixture', kind: 'codex', userText: 'fixture',
      fromUserId: 'owner', contextToken: 'fixture', tempFiles: [],
      session: { workingDirectory: directory, state: 'idle' } });
    launchJob(job);
    assert.equal(calls[0].command, 'systemd-run');
    assert.deepEqual(calls[0].args.filter(arg => arg.startsWith('--setenv=WCB_FISHING_')), [
      '--setenv=WCB_FISHING_GROUP_ID=90000000001@chatroom',
      '--setenv=WCB_FISHING_GROUP_NAME=离线钓鱼测试群',
    ]);
    delete process.env.WCB_FISHING_GROUP_ID;
    delete process.env.WCB_FISHING_GROUP_NAME;
    launchJob(job);
    assert.deepEqual(calls[1].args.filter(arg => arg.startsWith('--setenv=WCB_FISHING_')), []);
  } finally {
    keys.forEach((key, i) => previous[i] === undefined ? delete process.env[key] : process.env[key] = previous[i]);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
