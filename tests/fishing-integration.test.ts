import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodexRunOptions, CodexRunResult } from '../src/codex/bridge.js';
import type { DesktopDelivery } from '../src/desktop/store.js';

const root = mkdtempSync(join(tmpdir(), 'fishing-integration-'));
process.env.WCB_DATA_DIR = root;
process.env.WCB_FISHING_GROUP_ID = '90000000001@chatroom';
process.env.WCB_FISHING_GROUP_NAME = '离线钓鱼测试群';
const { withFishingRoom, withoutFishingState, fishingMemoryPolicy, createFishingTools, FISHING_ROOM_ID, FISHING_MEMORY_POLICY } = await import('../src/fishing.js');
const { createWechatTools } = await import('../src/wechat-tools.js');
const { createMemoryStore } = await import('../src/memory.js');
const { reviewCharacterReply, hasCharacterApproval } = await import('../src/character-review.js');
const { createDesktopStore } = await import('../src/desktop/store.js');
const { createDesktopSender } = await import('../src/desktop/channel.js');
const { createConversationStore, isLongTermMemorySource } = await import('../src/conversation.js');
test.after(() => rmSync(root, { recursive: true, force: true }));

const accountId = 'desktop-ruanruan-chat-0123456789abcdef01234567';
const base: CodexRunOptions = { profile: 'companion', cwd: root, mode: 'plan', prompt: '鲫鱼用什么饵',
  developerInstructions: '原来的人格和语气', characterFacts: '原来的生活状态', reviewInstructions: '原来的审核规则',
  personaContext: { version: 'ruanruan-core-v6', fingerprint: 'test', files: [], bytes: 1 },
  conversation: { accountId, peerId: 'group', roomId: FISHING_ROOM_ID } };
const response = (replyText: string): CodexRunResult => ({ replyText, commands: [], fileChanges: [] });

test('room capabilities preserve personality and cannot leak to private chats, other rooms or control', async () => {
  const scoped = withFishingRoom(base);
  assert.match(scoped.developerInstructions!, /原来的人格和语气/);
  assert.match(scoped.developerInstructions!, /不突然变成专家客服/);
  assert.match(scoped.characterFacts!, /原来的生活状态/);
  assert.match(scoped.reviewInstructions!, /原来的审核规则/);
  assert.match(scoped.reviewInstructions!, /fishingEvidence/);
  for (const changed of [
    { ...base, conversation: { ...base.conversation!, roomId: undefined } },
    { ...base, conversation: { ...base.conversation!, roomId: 'other@chatroom' } },
    { ...base, conversation: { ...base.conversation!, accountId: 'official-control' } },
    { ...base, profile: 'work' as const },
  ]) assert.equal(withFishingRoom(changed), changed);
  for (const [account, room] of [[accountId, undefined], [accountId, 'other@chatroom'], ['official-control', FISHING_ROOM_ID]]) {
    const tools = createFishingTools(account!, room);
    assert.deepEqual(tools.specs, []);
    await assert.rejects(tools.call('fishing_knowledge', { query: '鲫鱼' }), /未启用/);
  }
});

test('normal dynamic tool path retrieves bounded knowledge and refuses to memorize tool results', async () => {
  const tools = createWechatTools(accountId, 'group', { roomId: FISHING_ROOM_ID,
    directory: root, memoryRoot: root, mediaRoot: join(root, 'no-media'), currentUser: '记住我只玩路亚' });
    assert.deepEqual(tools.specs.filter(s => s.name.startsWith('fishing_')).map(s => s.name), ['fishing_assess', 'fishing_knowledge', 'fishing_weather']);
    const found: any = await tools.call('fishing_knowledge', { query: '鲫鱼饵料' });
    assert.equal(found.referenceOnly, true); assert.ok(found.excerpts.length > 0);
    assert.equal(tools.fishingEvidence.length, 1);
    await assert.rejects(tools.call('memory_update', { operation: 'remember', facts: [
      { subject: 'user', attribute: '饵料', evidence: '鲫鱼喜欢蚯蚓' },
    ] }), /用户原话/);
    const saved: any = await tools.call('memory_update', { operation: 'remember', facts: [
      { subject: 'user', attribute: '钓法', evidence: '我只玩路亚' },
    ] });
    assert.equal(saved.saved, true);
});

test('follow-ups in the fishing room inherit the memory boundary without another tool call', () => {
  const draft: CodexRunResult = { ...response('那就试试这个配方'), characterUpdate: {
    state: [{ key: 'plan', text: '去浦口钓鱼', replyQuote: '试试', validForMinutes: 30 }],
    social: { intent: 'chat', effect: 'none', mode: 'reply', userQuote: base.prompt },
  } };
  assert.equal(withoutFishingState(draft, base).characterUpdate?.state, undefined);
  assert.deepEqual(fishingMemoryPolicy(base), FISHING_MEMORY_POLICY);
  const elsewhere = { ...base, conversation: { ...base.conversation!, roomId: 'other@chatroom' } };
  assert.equal(withoutFishingState(draft, elsewhere), draft);
  assert.equal(fishingMemoryPolicy(elsewhere), undefined);
});

test('review sees tool facts but neither generation nor review corrections can persist them as life state', async () => {
  const draft: CodexRunResult = { ...response('看预报浦口明天北风 先别把鱼获想得太美'),
    fishingEvidence: [{ tool: 'fishing_weather', data: { location: '南京浦口', current: { wind: '北风' } } }],
    characterUpdate: { state: [{ key: 'activity', text: '我在浦口钓鱼', replyQuote: '浦口', validForMinutes: 30 }],
      social: { intent: 'chat', effect: 'none', mode: 'reply', userQuote: base.prompt } } };
  const result = await reviewCharacterReply(withFishingRoom(base), draft, createMemoryStore(accountId), async call => {
    const data = JSON.parse(call.prompt.split('\n')[1]);
    assert.equal(data.proposedUpdate.state, undefined);
    assert.equal(data.context.fishingEvidence[0].tool, 'fishing_weather');
    return response(JSON.stringify({ verdict: 'pass', issues: [], corrections: {
      state: [{ key: 'activity', text: '在浦口钓鱼', replyQuote: '浦口', validForMinutes: 30 }],
    } }));
  });
  assert.ok(hasCharacterApproval(result));
  assert.equal(result.characterUpdate?.state, undefined);
  assert.equal(result.characterUpdate?.stance, undefined);
  assert.equal(result.characterUpdate?.social?.mode, 'reply');
  assert.equal(result.characterReview?.stateReconciled, true);
});

test('confirmed delivery journals the exclusion atomically; unrelated replies remain eligible', async () => {
  const config = { version: 1 as const, enabled: true, accountId: 'desktop-test', ownerPeerId: 'owner',
    exchangeDirectory: join(root, 'exchange'), queueDirectory: join(root, 'queue'),
    contacts: [{ peerId: 'owner', uiLabel: '离线模拟', identityNote: 'test only' }] };
  const deliveries = new Map<string, DesktopDelivery>();
  const store = { ...createDesktopStore(config), enqueue(input: Parameters<ReturnType<typeof createDesktopStore>['enqueue']>[0]) {
    const delivery: DesktopDelivery = { ...input, mention: input.mention ?? undefined, id: input.clientId,
      accountId: config.accountId, uiLabel: '离线模拟', status: 'sent', evidence: { observedAt: Date.now() } };
    deliveries.set(delivery.id, delivery); return delivery;
  }, getDelivery(id: string) { return deliveries.get(id)!; } };
  const sender = createDesktopSender(config, { store, journalDirectory: root });
  await sender.inThread(undefined, () => sender.sendText('owner', '', '工具返回的饵料建议', 'fishing'), 'companion', FISHING_MEMORY_POLICY);
  await sender.inThread(undefined, () => sender.sendText('owner', '', '今天上班好累', 'ordinary'), 'companion');
  const rows = createConversationStore(config.accountId, 'owner', root).recent();
  assert.equal(rows.length, 2);
  assert.equal(isLongTermMemorySource(rows[0]), false);
  assert.equal(isLongTermMemorySource(rows[1]), true);
});
