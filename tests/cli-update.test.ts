import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateCli, recoverCliUpdate, type RunCommand } from '../src/cli-update.js';

function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'cli-update-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('latest CLI check never invokes sudo or installation', async t => {
  const calls: string[] = [];
  const run: RunCommand = async (f, a) => { calls.push(f); return f === 'codex' ? 'codex-cli 1.2.3' : '1.2.3'; };
  assert.match(await updateCli(fixture(t), () => {}, run), /无需更新/);
  assert.deepEqual(calls, ['codex', 'npm']);
});
test('failed install restores local backup and verifies old executable', async t => {
  const calls: string[] = [];
  const run: RunCommand = async (f, a) => {
    const c = [f, ...a].join(' '); calls.push(c);
    if (f === 'codex') return 'codex-cli 1.2.3';
    if (f === 'readlink') return '../lib/node_modules/@openai/codex/bin/codex.js';
    if (f === 'npm') return a[0] === 'view' ? '1.2.4' : '/usr/local/lib/node_modules';
    if (c.includes('npm install')) throw new Error('network failed');
    return '';
  };
  await assert.rejects(updateCli(fixture(t), () => {}, run), /已恢复 1.2.3/);
  assert.ok(calls.findIndex(c => c.includes('tar -cpf')) < calls.findIndex(c => c.includes('npm install')));
  assert.ok(calls.some(c => c.includes('tar -xpf')));
  assert.equal(calls.at(-1), 'codex --version');
});
test('backup failure prevents any install or deletion', async t => {
  const calls: string[] = [];
  const run: RunCommand = async (f, a) => {
    const c = [f, ...a].join(' '); calls.push(c);
    if (f === 'codex') return 'codex-cli 1.2.3';
    if (f === 'npm') return a[0] === 'view' ? '1.2.4' : '/usr/local/lib/node_modules';
    if (c.includes('tar -cpf')) throw new Error('disk full');
    return '';
  };
  await assert.rejects(updateCli(fixture(t), () => {}, run), /disk full/);
  assert.ok(!calls.some(c => c.includes('install') || c.includes('rm -rf')));
});
test('recovery checks a completed install without reinstalling', async t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'versions.json'), JSON.stringify({ current: '1.2.3', latest: '1.2.4', oldLink: 'old' }));
  const calls: string[] = [];
  const run: RunCommand = async (f, a) => { calls.push([f, ...a].join(' ')); return a[0] === '--version' ? 'codex-cli 1.2.4' : 'help'; };
  assert.match(await recoverCliUpdate(dir, () => {}, run), /无需重复安装/);
  assert.deepEqual(calls, ['codex --version', 'codex exec --help']);
});
test('recovery does not overwrite a newer independently installed version', async t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'versions.json'), JSON.stringify({ current: '1.2.3', latest: '1.2.4', oldLink: 'old' }));
  const calls: string[] = [];
  const run: RunCommand = async (f, a) => { calls.push(f); return 'codex-cli 1.3.0'; };
  await assert.rejects(recoverCliUpdate(dir, () => {}, run), /不覆盖/);
  assert.deepEqual(calls, ['codex']);
});
test('successful upgrade validates version and CLI startup after installation', async t => {
  let installed = false;
  const calls: string[] = [];
  const run: RunCommand = async (f, a) => {
    const c = [f, ...a].join(' '); calls.push(c);
    if (f === 'codex') return a[0] === '--version' ? `codex-cli ${installed ? '1.2.4' : '1.2.3'}` : 'help';
    if (f === 'readlink') return '../lib/node_modules/@openai/codex/bin/codex.js';
    if (f === 'npm') return a[0] === 'view' ? '1.2.4' : '/usr/local/lib/node_modules';
    if (c.includes('npm install')) installed = true;
    return '';
  };
  assert.match(await updateCli(fixture(t), () => {}, run), /已从 1.2.3 更新到 1.2.4/);
  assert.deepEqual(calls.slice(-2), ['codex --version', 'codex exec --help']);
});
