import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { channelKind } from '../src/wechat/channel.js';
import { createConversationStore } from '../src/conversation.js';
import { cleanupTempFiles, prepareMediaForCodex } from '../src/wechat/media.js';
import { createDesktopChannel, createDesktopMonitor, createDesktopSender } from '../src/desktop/channel.js';
import { parseDesktopConfig, type DesktopConfig } from '../src/desktop/config.js';
import { createDesktopStore, type DesktopDelivery } from '../src/desktop/store.js';
import { desktopCommand } from '../src/desktop/cli.js';
import { deliverChatMessages } from '../src/utils/chat-reply.js';
import { deliverImageReply } from '../src/wechat/image-delivery.js';

// Synthetic files exercise the application contract. No live WeChat window,
// message sending, model execution or persisted Codex test thread is involved.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'wechat-desktop-interface-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config: DesktopConfig = { version: 1, enabled: true, accountId: 'desktop-test', ownerPeerId: 'owner',
    exchangeDirectory: join(root, 'exchange'), queueDirectory: join(root, 'queue'),
    contacts: [{ peerId: 'owner', uiLabel: '唯一备注', identityNote: 'synthetic owner identity' },
      { peerId: 'other', uiLabel: '另一人', identityNote: 'synthetic other identity' }] };
  mkdirSync(config.exchangeDirectory); const screenshotPath = join(config.exchangeDirectory, 'screen.png');
  writeFileSync(screenshotPath, png);
  const store = createDesktopStore(config);
  const incoming = (id: string, text = '同一句话') => store.incoming({ peerId: 'owner', uiLabel: '唯一备注', sourceMessageId: id, text, screenshotPath });
  return { root, config, store, screenshotPath, incoming };
}
async function until<T>(read: () => T, check: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 3000;
  while (true) { const value = read(); if (check(value)) return value; if (Date.now() >= end) assert.fail('interface did not reach expected state'); await pause(5); }
}

test('group media is confirmed before its member notification and captions avoid duplicate notifications',async t=>{
  const f=fixture(t);f.config.contacts.push({peerId:'group-alice',uiLabel:'群',identityNote:'synthetic member',
    kind:'group',username:'123@chatroom',actorUsername:'alice',actorName:'Alice'});
  const calls:Parameters<typeof f.store.enqueue>[0][]=[],deliveries=new Map<string,DesktopDelivery>();
  const store={...f.store,enqueue(input:Parameters<typeof f.store.enqueue>[0]) {
    calls.push(input);
    const delivery:DesktopDelivery={...input,mention:input.mention??undefined,id:input.clientId,accountId:f.config.accountId,uiLabel:'群',status:'sent',
      evidence:{screenshotPath:f.screenshotPath,observedAt:Date.now()}};
    deliveries.set(delivery.id,delivery);return delivery;
  },getDelivery(id:string){return deliveries.get(id)!;}};
  const sender=createDesktopSender(f.config,{store,journalDirectory:f.root});
  await sender.sendImage('group-alice','',f.screenshotPath,{clientId:'image-1'});
  await sender.sendVideo('group-alice','',f.screenshotPath,{clientId:'video-1'});
  assert.deepEqual(calls.map(c=>[c.kind,c.clientId,c.mentionOnly]),[
    ['image','image-1',undefined],['text','image-1-mention',true],
    ['video','video-1',undefined],['text','video-1-mention',true]]);
  assert.ok(calls.every(c=>c.peerId==='group-alice'));
  calls.length=0;
  await sender.sendImage('group-alice','',f.screenshotPath,{clientId:'caption-image',notifyRecipient:false});
  assert.deepEqual(calls.map(c=>c.kind),['image']);
});

test('a rejected image sends no notification; a failed notification preserves the confirmed image',async t=>{
  const f=fixture(t);f.config.contacts.push({peerId:'group-alice',uiLabel:'群',identityNote:'synthetic member',kind:'group',username:'123@chatroom',actorUsername:'alice',actorName:'Alice'});
  for (const failedKind of ['image','text']) {
    const calls:string[]=[],deliveries=new Map<string,DesktopDelivery>();
    const store={...f.store,enqueue(input:Parameters<typeof f.store.enqueue>[0]) {
      calls.push(input.kind);
      const d:DesktopDelivery={...input,mention:input.mention??undefined,id:input.clientId,accountId:f.config.accountId,uiLabel:'群',
        status:input.kind===failedKind?'rejected':'sent',error:input.kind===failedKind?'synthetic failure':undefined,
        evidence:{screenshotPath:f.screenshotPath,observedAt:Date.now()}};
      deliveries.set(d.id,d);return d;
    },getDelivery(id:string){return deliveries.get(id)!;}};
    const sender=createDesktopSender(f.config,{store,journalDirectory:f.root});
    if (failedKind==='image') {
      await assert.rejects(sender.sendImage('group-alice','',f.screenshotPath,{clientId:'failed-image'}),/synthetic failure/);
      assert.deepEqual(calls,['image']);
    } else {
      const ack=await sender.sendImage('group-alice','',f.screenshotPath,{clientId:'confirmed-image'});
      assert.ok(ack.desktopEvidence);assert.deepEqual(calls,['image','text']);
      assert.equal(createConversationStore(f.config.accountId,'group-alice',f.root).recent().filter(r=>r.id==='out:confirmed-image').length,1);
    }
  }
});

test('ClawBot remains the default; desktop cannot start with a disabled or unbound configuration', t => {
  const f = fixture(t), disabled = { ...f.config, enabled: false };
  assert.equal(channelKind(''), 'desktop'); assert.equal(channelKind('ilink'), 'ilink');
  assert.equal(channelKind('desktop'), 'desktop'); assert.throws(() => channelKind('typo'), /Unknown/);
  assert.throws(() => createDesktopChannel(disabled), /尚未启用/);
  assert.throws(() => createDesktopStore(disabled).enqueue({ peerId: 'owner', clientId: 'x', kind: 'text', text: 'x', context: '', profile: 'control' }), /尚未启用/);
  assert.throws(() => parseDesktopConfig({ ...f.config, ownerPeerId: '' }), /Bind/);
  assert.throws(() => parseDesktopConfig({ ...f.config, accountId: 'old-ilink-account' }), /namespace/);
  assert.throws(() => parseDesktopConfig({ ...f.config, contacts: [...f.config.contacts, f.config.contacts[0]] }), /unique/);
});

test('incoming retries deduplicate by occurrence, while identical separate messages and peer boundaries survive', t => {
  const f = fixture(t), first = f.incoming('bubble-1');
  assert.equal(f.incoming('bubble-1').duplicate, true);
  const second = f.incoming('bubble-2'); assert.notEqual(first.seq, second.seq);
  assert.throws(() => f.incoming('bubble-1', 'different'), /reused/);
  assert.throws(() => f.store.incoming({ peerId: 'other', uiLabel: '另一人', sourceMessageId: '1', text: '/Q', screenshotPath: f.screenshotPath }), /bound owner/);
  assert.throws(() => f.store.incoming({ peerId: 'owner', uiLabel: '另一人', sourceMessageId: '1', text: 'x', screenshotPath: f.screenshotPath }), /does not match/);
  assert.equal(f.store.takeIncoming()!.seq, first.seq); assert.equal(f.store.takeIncoming()!.seq, second.seq);
  assert.equal(f.store.takeIncoming(), undefined);
});

test('text is neither acknowledged nor journaled until the authorized GUI receipt matches the actual target and bubble', async t => {
  const f = fixture(t), incoming = f.incoming('1');
  const sender = createDesktopSender(f.config, { store: f.store, journalDirectory: f.root, pollMs: 2, receiptTimeoutMs: 3000 });
  let settled = false;
  const sent = sender.inThread('thread-1', () => sender.sendText('owner', `desktop:${incoming.seq}`, '回复正文', 'text-1'), 'companion');
  sent.then(() => { settled = true; });
  const journal = createConversationStore(f.config.accountId, 'owner', f.root);
  assert.equal(journal.recent().length, 0); assert.equal(settled, false);
  const claimed = f.store.claimDelivery()!; assert.equal(claimed.status, 'claimed');
  assert.throws(() => f.store.assertUiAccess(claimed.leaseId), /not authorized/);
  const ready = await until(() => f.store.getDelivery(claimed.id), d => d.status === 'ready');
  f.store.assertUiAccess(ready.leaseId);
  assert.throws(() => f.store.assertUiAccess(), /reserved/);
  assert.throws(() => f.store.assertUiAccess('another-operator'), /reserved/);
  assert.equal(f.store.claimDelivery(), undefined); assert.equal(settled, false);
  assert.equal(journal.recent().length, 0);
  const receipt = { id: ready.id, leaseId: ready.leaseId!, status: 'sent' as const, uiLabel: '唯一备注', screenshotPath: f.screenshotPath, observedText: '回复正文' };
  assert.throws(() => f.store.receipt({ ...receipt, uiLabel: '另一人' }), /does not match/);
  assert.throws(() => f.store.receipt({ ...receipt, observedText: '不是原文' }), /must match/);
  f.store.receipt(receipt); const ack = await sent;
  assert.equal(ack.messageIdPresent, false); assert.ok(ack.desktopEvidence);
  assert.equal(ack.desktopEvidence!.screenshotPath, undefined, 'successful sends do not archive the inspected screenshot');
  assert.equal(journal.recent().length, 1); assert.equal(journal.recent()[0].profile, 'companion');
  assert.equal(journal.recent()[0].text, '回复正文');
  await sender.inThread('thread-1', () => sender.sendText('owner', `desktop:${incoming.seq}`, '回复正文', 'text-1'), 'companion');
  assert.equal(journal.recent().length, 1); assert.equal(f.store.claimDelivery(), undefined);
  assert.throws(() => f.store.enqueue({ peerId: 'owner', clientId: 'text-1', kind: 'text', text: '不同回复', context: '', profile: 'control' }), /reused/);
});

test('image and video sends stage immutable local files and require an observed outgoing attachment', async t => {
  const f = fixture(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Desktop media must not use an API/CDN'); });
  const sender = createDesktopSender(f.config, { store: f.store, journalDirectory: f.root, pollMs: 2, receiptTimeoutMs: 3000 });
  for (const kind of ['image', 'video'] as const) {
    const source = join(f.root, kind === 'image' ? 'asset.png' : 'asset.mp4'); writeFileSync(source, png);
    const promise = kind === 'image' ? sender.sendImage('owner', '', source) : sender.sendVideo('owner', '', source);
    const claimed = f.store.claimDelivery()!, ready = await until(() => f.store.getDelivery(claimed.id), d => d.status === 'ready');
    assert.equal(ready.kind, kind); assert.match(ready.desktopPath!, /^\/exchange\/outgoing\//);
    writeFileSync(source, 'changed original'); assert.deepEqual(readFileSync(ready.filePath!), png);
    const receipt = { id: ready.id, leaseId: ready.leaseId!, status: 'sent' as const, uiLabel: '唯一备注', screenshotPath: f.screenshotPath };
    assert.throws(() => f.store.receipt(receipt), /must match/);
    f.store.receipt({ ...receipt, attachmentVisible: true }); await promise;
  }
  const rows = createConversationStore(f.config.accountId, 'owner', f.root).recent();
  assert.equal(rows.length, 2);
});

test('a mode change can cancel an image after queuing and before the operator receives permission to act', async t => {
  const f = fixture(t); const file = join(f.root, 'photo.png'); writeFileSync(file, png);
  let checks = 0;
  const sender = createDesktopSender(f.config, { store: f.store, journalDirectory: f.root, pollMs: 2, receiptTimeoutMs: 3000 });
  const promise = sender.sendImage('owner', '', file, { beforeSend: () => { checks++; throw new Error('mode changed'); } });
  const outcome = assert.rejects(promise, /mode changed/); assert.equal(checks, 0);
  const claimed = f.store.claimDelivery()!; await outcome;
  assert.equal(checks, 1); assert.equal(f.store.getDelivery(claimed.id).status, 'cancelled');
  assert.throws(() => f.store.assertUiAccess(claimed.leaseId), /cancelled/);
  assert.equal(createConversationStore(f.config.accountId, 'owner', f.root).recent().length, 0);
});

test('a newer visible message suppresses a queued companion reply before UI authorization', async t => {
  const f = fixture(t), first = f.incoming('1');
  const sender = createDesktopSender(f.config, { store: f.store, journalDirectory: f.root, pollMs: 2, receiptTimeoutMs: 3000 });
  const pending = sender.inThread('thread', () => deliverChatMessages(['旧回复'], text => sender.sendText('owner', `desktop:${first.seq}`, text)), 'companion');
  f.incoming('2', '先不用了');
  const claimed = f.store.claimDelivery()!;
  assert.deepEqual(await pending, { sent: 0, interrupted: true });
  assert.equal(f.store.getDelivery(claimed.id).status, 'cancelled');
});

test('an image superseded before GUI authorization is cancelled without an uncertain image receipt', async t => {
  const f = fixture(t), first = f.incoming('1'), file = join(f.root, 'photo.png'); writeFileSync(file, png);
  const sender = createDesktopSender(f.config, { store: f.store, journalDirectory: f.root, pollMs: 2, receiptTimeoutMs: 3000 });
  const pending = sender.inThread('thread', () => deliverImageReply({ directory: join(f.root, 'delivery'), images: [file], texts: [], sender,
    toUserId: 'owner', contextToken: () => `desktop:${first.seq}` }), 'companion');
  f.incoming('2', '先不用了'); f.store.claimDelivery();
  const result = await pending;
  assert.equal(result.cancelled, true); assert.equal(result.parts[0].status, 'cancelled');
});

test('a lost GUI lease leaves an uncertain send and never automatically requeues it', t => {
  const f = fixture(t); let at = 1000;
  const store = createDesktopStore(f.config, () => at);
  const task = store.enqueue({ peerId: 'owner', kind: 'text', text: '正文', clientId: '1', context: '', profile: 'control' });
  const claim = store.claimDelivery(100)!; store.authorizeDelivery(task.id);
  at += 101; assert.equal(store.getDelivery(task.id).status, 'uncertain');
  assert.equal(store.claimDelivery(), undefined);
  assert.throws(() => store.assertUiAccess(claim.leaseId), /expired/);
  assert.throws(() => store.receipt({ id: task.id, leaseId: claim.leaseId!, status: 'sent', uiLabel: '唯一备注', screenshotPath: f.screenshotPath, observedText: '正文' }), /active authorized/);
});

test('a send with no GUI operator times out as unsent and does not create outgoing history', async t => {
  const f = fixture(t);
  const sender = createDesktopSender(f.config, { store: f.store, journalDirectory: f.root, pollMs: 2, receiptTimeoutMs: 15 });
  await assert.rejects(sender.sendText('owner', '', '未发送'), /timed out/);
  assert.equal(f.store.claimDelivery(), undefined);
  assert.equal(createConversationStore(f.config.accountId, 'owner', f.root).recent().length, 0);
});

test('an explicit retry can requeue a known unsent delivery, while uncertain outcomes keep the original record', t => {
  const f = fixture(t), input = { peerId: 'owner', clientId: 'retry-1', kind: 'text' as const, text: '正文', context: '', profile: 'control' as const };
  const task = f.store.enqueue(input), first = f.store.claimDelivery()!; f.store.authorizeDelivery(task.id);
  f.store.receipt({ id: task.id, leaseId: first.leaseId!, status: 'rejected', uiLabel: '唯一备注', error: 'UI confirmed no message was sent' });
  const retry = f.store.enqueue(input); assert.equal(retry.id, task.id); assert.equal(retry.status, 'queued');
  const second = f.store.claimDelivery()!; f.store.authorizeDelivery(task.id);
  f.store.receipt({ id: task.id, leaseId: second.leaseId!, status: 'uncertain', uiLabel: '唯一备注', error: 'UI disappeared after clicking Send' });
  assert.equal(f.store.enqueue(input).status, 'uncertain'); assert.equal(f.store.claimDelivery(), undefined);
});

test('group mentions follow the stable member username through renames, queueing and retries', t => {
  const f = fixture(t);
  f.config.multiUser = true;
  f.config.database = { accountDirectory: 'wxid_self_fixture', selfUsername: 'wxid_self', ownerUsername: 'wxid_owner' };
  const contact = { peerId: 'room', uiLabel: '测试群', identityNote: 'synthetic group', kind: 'group' as const,
    username: '123@chatroom', actorUsername: 'wxid_j', actorName: '旧昵称',
    members: [{ username: 'wxid_j', name: '小J' }, { username: 'wxid_other', name: '小J' }] };
  f.config.contacts.push(contact);
  const input = { peerId: 'room', clientId: 'renamed-member', kind: 'text' as const, text: '回复', context: '', profile: 'control' as const,
    mention: { username: 'wxid_j', name: '历史昵称' } };
  const queued = f.store.enqueue(input);
  assert.deepEqual(queued.mention, { username: 'wxid_j', name: '小J' });
  assert.throws(() => f.store.enqueue({ ...input, mention: { username: 'wxid_other', name: '小J' } }), /different group recipient/);
  const first = f.store.claimDelivery()!; f.store.authorizeDelivery(first.id);
  f.store.receipt({ id: first.id, leaseId: first.leaseId!, status: 'rejected', uiLabel: '测试群', error: 'Not sent' });
  contact.members[0].name = '改过名的小J';
  const retry = f.store.enqueue(input);
  assert.equal(retry.id, first.id);
  assert.equal(retry.peerId, 'room');
  assert.deepEqual(retry.mention, { username: 'wxid_j', name: '改过名的小J' });
  contact.members[0].name = '领取时的新名字';
  const claimed = f.store.claimDelivery()!;
  assert.deepEqual(claimed.mention, { username: 'wxid_j', name: '领取时的新名字' });
  assert.deepEqual(f.store.getDelivery(first.id).mention, claimed.mention);
  assert.notEqual(claimed.leaseId, first.leaseId);
});

test('group mentions require one current username match and a departed member cannot block the next delivery', t => {
  const f = fixture(t);
  f.config.multiUser = true;
  f.config.database = { accountDirectory: 'wxid_self_fixture', selfUsername: 'wxid_self', ownerUsername: 'wxid_owner' };
  const contact = { peerId: 'room', uiLabel: '测试群', identityNote: 'synthetic group', kind: 'group' as const,
    username: '123@chatroom', members: [{ username: 'wxid_j', name: '小J' }] };
  f.config.contacts.push(contact);
  const input = { peerId: 'room', clientId: 'missing-member', kind: 'text' as const, text: '回复', context: '', profile: 'control' as const,
    mention: { username: 'wxid_j', name: '旧名字' } };
  contact.members.push({ username: 'wxid_j', name: '重复条目' });
  assert.throws(() => f.store.enqueue(input), /not uniquely identified/);
  contact.members.pop();
  const obsolete = f.store.enqueue(input);
  const next = f.store.enqueue({ ...input, peerId: 'owner', clientId: 'next', mention: null });
  contact.members = [{ username: 'wxid_other', name: '小J' }];
  assert.equal(f.store.claimDelivery()!.id, next.id);
  assert.equal(f.store.getDelivery(obsolete.id).status, 'rejected');
  assert.equal(f.store.getDelivery(obsolete.id).mention?.username, 'wxid_j');
  assert.throws(() => f.store.enqueue(input), /not uniquely identified/);
});

test('late negative receipts preserve the expired lease outcome and cannot affect another active delivery', t => {
  const f = fixture(t); let at = 1000;
  const store = createDesktopStore(f.config, () => at);
  const task = store.enqueue({ peerId: 'owner', clientId: 'expired', kind: 'text', text: '回复', context: '', profile: 'control' });
  const first = store.claimDelivery(100)!; store.authorizeDelivery(task.id);
  at += 101;
  const late = { id: task.id, leaseId: first.leaseId!, status: 'rejected' as const, uiLabel: '唯一备注', error: 'Recovery found an expired lease' };
  assert.equal(store.receipt(late).status, 'uncertain');
  assert.equal(store.status().sendPaused,true);
  store.resume(); // Simulate the explicit manual inspection before another send.
  const next = store.enqueue({ peerId: 'owner', clientId: 'next', kind: 'text', text: '另一个回复', context: '', profile: 'control' });
  const active = store.claimDelivery()!; store.authorizeDelivery(next.id);
  assert.equal(store.receipt({ ...late, status: 'uncertain' }).status, 'uncertain');
  store.assertUiAccess(active.leaseId);
  assert.equal(store.getDelivery(next.id).status, 'ready');
  assert.throws(() => store.receipt({ ...late, leaseId: active.leaseId! }), /active authorized/);
  assert.throws(() => store.receipt({ ...late, status: 'sent', screenshotPath: f.screenshotPath, observedText: '回复' }), /active authorized/);
});

test('negative receipts from a previous attempt cannot finalize the retried delivery', t => {
  const f = fixture(t), input = { peerId: 'owner', clientId: 'retry-lease', kind: 'text' as const, text: '回复', context: '', profile: 'control' as const };
  const task = f.store.enqueue(input), first = f.store.claimDelivery()!; f.store.authorizeDelivery(task.id);
  const failure = { id: task.id, leaseId: first.leaseId!, status: 'rejected' as const, uiLabel: '唯一备注', error: 'Not sent' };
  assert.equal(f.store.receipt(failure).status, 'rejected');
  assert.equal(f.store.receipt(failure).status, 'rejected');
  f.store.enqueue(input);
  const second = f.store.claimDelivery()!; f.store.authorizeDelivery(task.id);
  assert.throws(() => f.store.receipt(failure), /active authorized/);
  f.store.assertUiAccess(second.leaseId);
  assert.equal(f.store.getDelivery(task.id).status, 'ready');
});

test('recovery covers four model judgments with one bounded lease extension and resets only for a new attempt', t => {
  const f = fixture(t); let at = 1000;
  const store = createDesktopStore(f.config, () => at);
  const input = { peerId: 'owner', clientId: 'recovery-lease', kind: 'text' as const, text: '回复', context: '', profile: 'control' as const };
  const task = store.enqueue(input), first = store.claimDelivery(90_000)!; store.authorizeDelivery(task.id);
  at += 5000;
  const extendedUntil = at + 600_000;
  assert.equal(store.extendDelivery(first.leaseId!).leaseUntil, extendedUntil);
  at += 250_000;
  store.assertUiAccess(first.leaseId);
  assert.equal(store.extendDelivery(first.leaseId!).leaseUntil, extendedUntil, 'one lease gets only one recovery extension');
  store.receipt({ id: task.id, leaseId: first.leaseId!, status: 'rejected', uiLabel: '唯一备注', error: 'Not sent' });
  store.enqueue(input);
  const second = store.claimDelivery(10_000)!; store.authorizeDelivery(task.id);
  at += 1000;
  const retryUntil = at + 600_000;
  assert.equal(store.extendDelivery(second.leaseId!).leaseUntil, retryUntil);
  at += 1000;
  assert.equal(store.extendDelivery(second.leaseId!).leaseUntil, retryUntil);
  at = retryUntil;
  assert.equal(store.getDelivery(task.id).status, 'uncertain');
  assert.throws(() => store.extendDelivery(second.leaseId!), /暂停/);
});

test('recovery preserves a longer existing lease instead of shortening it to ten minutes', t => {
  const f = fixture(t); let at = 1000;
  const store = createDesktopStore(f.config, () => at);
  const task = store.enqueue({ peerId: 'owner', clientId: 'long-lease', kind: 'text', text: '回复', context: '', profile: 'control' });
  const claim = store.claimDelivery(900_000)!; store.authorizeDelivery(task.id);
  at += 5000;
  assert.equal(store.extendDelivery(claim.leaseId!).leaseUntil, claim.leaseUntil);
});

test('monitor persists completed and failed dispatches, and does not replay a previously processing event', async t => {
  const f = fixture(t); const first = f.incoming('1'); f.store.takeIncoming(); f.incoming('2'); f.incoming('3');
  const seen: number[] = [];
  const monitor = createDesktopMonitor(f.config, { onSessionExpired() {}, onMessage: async msg => {
    seen.push(msg.message_id!); if (seen.length === 1) throw new Error('dispatch failed'); monitor.stop();
  } }, { pollMs: 2 });
  await monitor.run(); assert.equal(seen.length, 2); assert.ok(!seen.includes(first.seq));
  assert.deepEqual(f.store.status().incoming.map(r => [r.status, r.count]), [['failed',1],['processed',1],['processing',1]]);
});

test('desktop incoming media uses a private snapshot and does not fetch or delete the original attachment', async t => {
  const f = fixture(t), source = join(f.config.exchangeDirectory, 'received.png'); writeFileSync(source, png);
  f.store.incoming({ peerId: 'owner', uiLabel: '唯一备注', sourceMessageId: 'photo-1', text: '', screenshotPath: f.screenshotPath,
    attachment: { kind: 'image', path: source } });
  const message = f.store.takeIncoming()!.message; writeFileSync(source, 'changed');
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Local media must not use HTTP'); });
  const prepared = await prepareMediaForCodex(message.localMedia!);
  assert.deepEqual(readFileSync(prepared.imagePaths[0]), png); cleanupTempFiles(prepared.tempFiles);
  assert.equal(readFileSync(source, 'utf8'), 'changed');
  assert.deepEqual(readFileSync(message.localMedia!.localPath!), png);
  const outside = join(f.root, 'private.png'); writeFileSync(outside, png);
  assert.throws(() => f.store.incoming({ peerId: 'owner', uiLabel: '唯一备注', sourceMessageId: 'photo-2', text: '', screenshotPath: f.screenshotPath, attachment: { kind: 'image', path: outside } }), /exchange directory/);
});

test('the local MCP bridge exposes a disabled status but cannot ingest or claim live traffic', async t => {
  const f = fixture(t), disabled = { ...f.config, enabled: false };
  const status = await desktopCommand('status', {}, disabled);
  assert.ok('enabled' in status); assert.equal(status.enabled, false);
  await assert.rejects(desktopCommand('incoming', { peerId: 'owner', uiLabel: '唯一备注', sourceMessageId: '1', text: 'x', screenshotPath: f.screenshotPath }, disabled), /尚未启用/);
  await assert.rejects(desktopCommand('next-delivery', {}, disabled), /尚未启用/);
});

test('a failed screenshot cannot prevent a security stop from being persisted',t=>{
  const f=fixture(t);
  f.store.pause('verification required; screenshot service unavailable',undefined,'security');
  const restarted=createDesktopStore(f.config);
  assert.equal(restarted.status().receivePaused,true);
  assert.equal(restarted.status().alert.screenshotUnavailable,true);
  assert.equal(restarted.claimDelivery(),undefined);
  assert.throws(()=>f.incoming('blocked'),/暂停/);
});

test('manual takeover holds generation and sending, preserves intake, and never clears the safety latch',t=>{
  const f=fixture(t),path=join(f.root,'manual-control.json');
  writeFileSync(path,JSON.stringify({active:true,sessionId:'human-1'}));
  f.incoming('during-takeover');
  assert.equal(f.store.status().manualControl.active,true);
  assert.equal(f.store.status().receivePaused,false);assert.equal(f.store.status().sendPaused,true);
  assert.equal(f.store.takeIncoming(),undefined);assert.equal(f.store.claimDelivery(),undefined);
  assert.throws(()=>f.store.enqueue({peerId:'owner',clientId:'hold',kind:'text',text:'x',context:'',profile:'control'}),/暂停/);
  writeFileSync(path,JSON.stringify({active:false,sessionId:'human-1',endedAt:1}));
  assert.ok(f.store.takeIncoming());
  f.store.pause('security check required',f.screenshotPath,'security');
  writeFileSync(path,JSON.stringify({active:false,sessionId:'human-2',endedAt:2}));
  assert.equal(f.store.status().receivePaused,true);
});
