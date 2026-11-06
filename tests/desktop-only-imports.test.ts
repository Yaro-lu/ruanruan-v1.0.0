import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'desktop-only-entry-'));
process.env.WCB_DATA_DIR = join(directory, 'app');
process.env.WCB_DESKTOP_CONFIG = join(directory, 'bridge.json');
delete process.env.WCB_CHANNEL;
delete process.env.WCB_WECHAT_TRANSPORT;
mkdirSync(join(directory, 'exchange'));
writeFileSync(process.env.WCB_DESKTOP_CONFIG, JSON.stringify({ version: 1, enabled: true,
  accountId: 'desktop-fixture', ownerPeerId: 'owner', exchangeDirectory: join(directory, 'exchange'),
  queueDirectory: join(directory, 'queue'), contacts: [{ peerId: 'owner', uiLabel: 'Fixture owner', identityNote: 'Offline fixture' }] }));
test.after(() => rmSync(directory, { recursive: true, force: true }));

const { createWechatChannel } = await import('../src/wechat/channel-factory.js');
const { channelKind } = await import('../src/wechat/channel.js');
const { prepareMediaForCodex, cleanupTempFiles } = await import('../src/wechat/media.js');
const { readImage } = await import('../src/media/image.js');
const { MessageItemType } = await import('../src/wechat/types.js');

test('the default entry imports and creates only the desktop adapter', async () => {
  await import('../src/main.js');
  await import('../src/memecub.js');
  assert.equal(channelKind(), 'desktop');
  const channel = await createWechatChannel();
  assert.equal(channel.account.transport, 'desktop');
  assert.equal(channel.account.entryRole, 'character');
  assert.equal(channel.mediaPreparation, undefined);
  assert.throws(() => channelKind('qq'), /Unknown/);
  await assert.rejects(createWechatChannel('qq' as never), /Unknown/);
});

test('local desktop images never need a control/CDN downloader', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const localPath = join(directory, 'fixture.png'); writeFileSync(localPath, png);
  assert.deepEqual(await readImage(localPath), png);
  const prepared = await prepareMediaForCodex({ kind: 'image', item: { type: MessageItemType.IMAGE }, localPath }, {
    downloadImageToTemp: async () => { throw new Error('Remote image adapter must not be called'); },
    downloadBinaryMediaToTemp: async () => { throw new Error('Remote binary adapter must not be called'); },
  });
  try { assert.equal(prepared.imagePaths.length, 1); assert.deepEqual(readFileSync(prepared.imagePaths[0]), png); }
  finally { cleanupTempFiles(prepared.tempFiles); }
});
