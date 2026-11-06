import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { deploymentHeld } from '../src/desktop/deployment-hold.js';
import { createDesktopMonitor, createDesktopSender } from '../src/desktop/channel.js';
import { createDesktopStore } from '../src/desktop/store.js';
import type { DesktopConfig } from '../src/desktop/config.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'wechat-deployment-hold-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config: DesktopConfig = { version: 1, enabled: true, accountId: 'desktop-hold-test', ownerPeerId: 'owner',
    contacts: [{ peerId: 'owner', uiLabel: '测试好友', identityNote: 'synthetic test contact' }],
    queueDirectory: join(root, 'queue'), exchangeDirectory: join(root, 'exchange') };
  mkdirSync(config.exchangeDirectory);
  mkdirSync(join(root, 'auto-repair'));
  const screenshotPath = join(config.exchangeDirectory, 'screen.png'); writeFileSync(screenshotPath, png);
  let time = 1_700_000_000_000;
  const now = () => time, advance = (ms: number) => { time += ms; };
  return { root, config, screenshotPath, now, advance, store: createDesktopStore(config, now), hold: join(root, 'auto-repair', 'deploy-hold.json') };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await pause(2); }
  assert.fail('offline channel did not reach the expected state');
}

test('deployment hold requires a live holder and a finite future deadline', t => {
  const f = fixture(t); let alive = true, permitted = true, probes = 0;
  t.mock.method(process, 'kill', (pid: number, signal: number | string = 0) => {
    assert.equal(pid, 123); assert.equal(signal, 0); probes++;
    if (!permitted) throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    if (!alive) throw Object.assign(new Error('not running'), { code: 'ESRCH' });
    return true;
  });
  const save = (value: unknown) => writeFileSync(f.hold, JSON.stringify(value));
  assert.equal(deploymentHeld(f.hold, 1000), false);
  save({ pid: 123, until: 1001 }); assert.equal(deploymentHeld(f.hold, 1000), true);
  alive = false; assert.equal(deploymentHeld(f.hold, 1000), false);
  alive = true; permitted = false; assert.equal(deploymentHeld(f.hold, 1000), true);
  permitted = true;
  const before = probes;
  for (const value of [null, [], {}, true, { pid: 0, until: 1001 }, { pid: 1.5, until: 1001 },
    { pid: '123', until: 1001 }, { pid: true, until: 1001 }, { pid: 123, until: 1000 },
    { pid: 123, until: '1001' }, { pid: 123, until: Infinity }, { pid: 123, until: NaN }]) {
    save(value); assert.equal(deploymentHeld(f.hold, 1000), false);
  }
  writeFileSync(f.hold, '{'); assert.equal(deploymentHeld(f.hold, 1000), false);
  assert.equal(probes, before, 'invalid/expired holds never probe a process');
});

test('monitor neither takes incoming nor calls handlers during hold and consumes once after release', async t => {
  const f = fixture(t); let probes = 0, takes = 0, callbacks = 0, finishes = 0, reloads = 0;
  t.mock.method(process, 'kill', () => { probes++; return true; });
  f.store.incoming({ peerId: 'owner', uiLabel: '测试好友', sourceMessageId: 'one', text: '新消息', screenshotPath: f.screenshotPath });
  writeFileSync(f.hold, JSON.stringify({ pid: 123, until: Date.now() + 60_000 }));
  const store = { ...f.store, takeIncoming() { takes++; return f.store.takeIncoming(); },
    finishIncoming(seq: number, error?: string) { finishes++; f.store.finishIncoming(seq, error); } };
  const monitor = createDesktopMonitor(f.config, { onSessionExpired() {}, onMessage: async () => { callbacks++; monitor.stop(); } },
    { store, pollMs: 1, reloadConfig: () => { reloads++; return f.config; } });
  t.after(() => monitor.stop());
  const running = monitor.run();
  await until(() => probes >= 3);
  assert.equal(takes, 0); assert.equal(callbacks, 0); assert.equal(finishes, 0); assert.equal(reloads, 0);
  assert.deepEqual(f.store.status().incoming.map(row => [row.status, row.count]), [['pending', 1]]);
  rmSync(f.hold);
  await running;
  assert.equal(takes, 1); assert.equal(callbacks, 1); assert.equal(finishes, 1);
  assert.deepEqual(f.store.status().incoming.map(row => [row.status, row.count]), [['processed', 1]]);
});

test('an extended authorized send waits past its original deadline for the same real receipt', async t => {
  const f = fixture(t); t.mock.method(Date, 'now', f.now);
  let reads = 0, cancellations = 0, settled = false;
  const store = { ...f.store, getDelivery(id: string) { reads++; return f.store.getDelivery(id); },
    cancelUnsent(id: string, reason: string) { cancellations++; return f.store.cancelUnsent(id, reason); } };
  const sender = createDesktopSender(f.config, { store, journalDirectory: f.root, pollMs: 1, receiptTimeoutMs: 50 });
  const sending = sender.sendText('owner', '', '已审核原文', 'original');
  void sending.then(() => { settled = true; });
  const claim = f.store.claimDelivery()!;
  await until(() => f.store.getDelivery(claim.id).status === 'ready');
  f.store.extendDelivery(claim.leaseId!);
  f.advance(100);
  const before = reads; await until(() => reads >= before + 2);
  assert.equal(settled, false); assert.equal(cancellations, 0);
  assert.equal(f.store.getDelivery(claim.id).status, 'ready');
  const receipt = { id: claim.id, leaseId: claim.leaseId!, status: 'sent' as const, uiLabel: '测试好友', screenshotPath: f.screenshotPath, observedText: '已审核原文' };
  assert.throws(() => f.store.receipt({ ...receipt, leaseId: 'unrelated-lease' }), /active authorized/);
  assert.throws(() => f.store.receipt({ ...receipt, observedText: '不同正文' }), /must match/);
  assert.equal(settled, false);
  f.store.receipt(receipt);
  assert.ok((await sending).desktopEvidence);
  assert.equal(cancellations, 0);
});

test('an ordinary authorized send keeps its normal receipt deadline without a recovery extension', async t => {
  const f = fixture(t); t.mock.method(Date, 'now', f.now);
  const sender = createDesktopSender(f.config, { store: f.store, journalDirectory: f.root, pollMs: 1, receiptTimeoutMs: 50 });
  const sending = sender.sendText('owner', '', '原文', 'ordinary');
  const rejected = assert.rejects(sending, /receipt timed out/);
  const claim = f.store.claimDelivery()!;
  await until(() => f.store.getDelivery(claim.id).status === 'ready');
  f.advance(50);
  await rejected;
  assert.equal(f.store.getDelivery(claim.id).status, 'uncertain');
});

test('queued metadata cannot masquerade as an authorized recovery lease or bypass the deadline', async t => {
  const f = fixture(t); t.mock.method(Date, 'now', f.now);
  let authorized = 0;
  const store = { ...f.store, getDelivery(id: string) { return { ...f.store.getDelivery(id), recoveryExtended: true, leaseUntil: f.now() + 300_000 }; },
    authorizeDelivery() { authorized++; throw new Error('queued delivery cannot be authorized without a claim'); } };
  const sender = createDesktopSender(f.config, { store, journalDirectory: f.root, pollMs: 1, receiptTimeoutMs: 50 });
  const sending = sender.sendText('owner', '', '原文', 'queued');
  const rejected = assert.rejects(sending, /receipt timed out/);
  f.advance(50);
  await rejected;
  assert.equal(authorized, 0);
  assert.deepEqual(f.store.status().outgoing.map(row => [row.status, row.count]), [['cancelled', 1]]);
});
