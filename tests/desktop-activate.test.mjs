import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { activateDesktop } from '../desktop/activate.mjs';

function fixture(t) {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'wechat-activate-'));
  t.after(() => rmSync(dataDirectory, { recursive: true, force: true }));
  const configPath = join(dataDirectory, 'bridge.json');
  const databasePath = join(dataDirectory, 'database.json');
  const config = {
    version: 1, enabled: false, accountId: 'desktop-offline', ownerPeerId: '', contacts: [],
    exchangeDirectory: join(dataDirectory, 'exchange'), queueDirectory: join(dataDirectory, 'queue'),
    database: { accountDirectory: 'wxid_role_abc', selfUsername: 'wxid_role', ownerUsername: 'wxid_owner' },
  };
  const prepared = { enabled: false, accountWechatId: 'offline-role', ownerWechatId: 'offline-owner', uiLabel: 'Offline owner' };
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(databasePath, JSON.stringify(prepared));
  const calls = [];
  const dependencies = { dataDirectory, configPath,
    createStore: verified => ({ resume: () => calls.push({ action: 'resume', config: verified }) }),
    runService: (command, args) => { calls.push({ action: 'service', command, args }); return { status: 0 }; },
  };
  const args = ['--owner-wechat-id', prepared.ownerWechatId, '--ui-label', prepared.uiLabel, '--account-wechat-id', prepared.accountWechatId];
  return { dataDirectory, configPath, databasePath, config, prepared, calls, dependencies, args };
}

test('prepared database activation works without any legacy operator configuration or unit', t => {
  const f = fixture(t);
  const result = activateDesktop(f.args, f.dependencies);
  assert.equal(result.transport, 'database');
  assert.equal(result.loginAttempted, false);
  assert.equal(result.testMessageSent, false);
  assert.equal(JSON.parse(readFileSync(f.configPath)).enabled, true);
  assert.equal(JSON.parse(readFileSync(f.databasePath)).enabled, true);
  assert.equal(existsSync(join(f.dataDirectory, 'operator.json')), false);
  const session = JSON.parse(readFileSync(join(f.dataDirectory, 'app', 'sessions', `${f.config.accountId}.json`)));
  assert.equal(session.workingDirectory, realpathSync(fileURLToPath(new URL('..', import.meta.url))));
  assert.equal(f.calls[0].action, 'resume');
  assert.equal(f.calls[0].config.ownerPeerId, result.ownerPeerId);
  assert.deepEqual(f.calls[1], { action: 'service', command: 'systemctl', args: [
    '--user', 'enable', '--now', 'wechat-desktop-runtime.service',
    'wechat-desktop-bridge.service', 'wechat-desktop-database.service',
  ] });
  assert.equal(f.calls.length, 2);
});

test('explicit database transport remains supported and preserves an existing session', t => {
  const f = fixture(t);
  activateDesktop([...f.args, '--transport', 'database'], f.dependencies);
  const sessionPath = join(f.dataDirectory, 'app', 'sessions', `${f.config.accountId}.json`);
  const existing = { state: 'idle', threadId: 'offline-existing-thread' };
  writeFileSync(sessionPath, JSON.stringify(existing));
  activateDesktop([...f.args, '--transport', 'database'], f.dependencies);
  assert.deepEqual(JSON.parse(readFileSync(sessionPath)), existing);
});

test('removed vision transport is rejected before writes, unpausing, or starting services', t => {
  const f = fixture(t);
  assert.throws(() => activateDesktop([...f.args, '--transport', 'vision'], f.dependencies), /Only the database/);
  assert.deepEqual(JSON.parse(readFileSync(f.configPath)), f.config);
  assert.deepEqual(JSON.parse(readFileSync(f.databasePath)), f.prepared);
  assert.equal(existsSync(join(f.dataDirectory, 'app')), false);
  assert.deepEqual(f.calls, []);
});

test('missing preparation and identity mismatches cannot enable the channel', async t => {
  for (const fault of ['missing-settings', 'missing-binding', 'account', 'owner', 'label']) {
    await t.test(fault, t => {
      const f = fixture(t);
      if (fault === 'missing-settings') rmSync(f.databasePath);
      else if (fault === 'missing-binding') {
        delete f.config.database;
        writeFileSync(f.configPath, JSON.stringify(f.config));
      } else {
        const field = { account: 'accountWechatId', owner: 'ownerWechatId', label: 'uiLabel' }[fault];
        f.prepared[field] = 'different-identity';
        writeFileSync(f.databasePath, JSON.stringify(f.prepared));
      }
      assert.throws(() => activateDesktop(f.args, f.dependencies), /Prepare the database|prepared database identities/);
      assert.deepEqual(JSON.parse(readFileSync(f.configPath)), f.config);
      if (existsSync(f.databasePath)) assert.deepEqual(JSON.parse(readFileSync(f.databasePath)), f.prepared);
      assert.equal(existsSync(join(f.dataDirectory, 'app')), false);
      assert.deepEqual(f.calls, []);
    });
  }
});
