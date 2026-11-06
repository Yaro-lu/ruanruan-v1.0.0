import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversationMessage } from '../src/conversation.js';
import type { Session } from '../src/session.js';
const root = mkdtempSync(join(tmpdir(), 'ruanruan-growth-'));
process.env.WCB_DATA_DIR = root;
const { createRelationshipStore } = await import('../src/relationship.js');
const { createLifeStore, lifeOptions, LIFE_PROFILE } = await import('../src/character-life.js');
const { createConversationStore } = await import('../src/conversation.js');
const { createMemoryStore, runWithMemory } = await import('../src/memory.js');
const { routeCommand } = await import('../src/commands/router.js');
const { chooseRoute, conversationProfile } = await import('../src/routing.js');
const { assembleEntryPrompt } = await import('../src/prompt.js');
const { deliverChatMessages } = await import('../src/utils/chat-reply.js');
const { deliverImageReply } = await import('../src/wechat/image-delivery.js');
test.after(() => rmSync(root, { recursive: true, force: true }));
const monday = Date.parse('2026-11-02T10:00:00+08:00');
const result = (replyText: string) => ({ replyText, commands: [], fileChanges: [], inputTokens: 1500, outputTokens: 300 });
function exchange(at = monday, user = '不方便说就不问了', reply = '嗯，这个我还不太想说') {
  const rows: ConversationMessage[] = [
    { id: `in:${at}`, seq: at, at, direction: 'in', text: user, payload: {}, profile: 'companion' },
    { id: `out:${at}`, seq: at + 1, at: at + 100, direction: 'out', text: reply, payload: {}, profile: 'companion' }];
  return { rows, evidence: { axis: 'trust' as const, topic: '个人地址', effect: 'supported' as const,
    meaning: '没有继续追问不想说的地址', messageId: rows[0].id, evidence: user, responseId: rows[1].id, responseEvidence: reply } };
}

test('relationship starts with no presupposed familiarity, repeated exchanges cannot farm growth', () => {
  const store = createRelationshipStore(join(root, 'relationship'));
  assert.equal(store.snapshot().basis, 'no_recorded_exchanges');
  assert.equal(store.snapshot().axes.trust.state, 'unknown');
  for (let day = 0; day < 100; day++) {
    const e = exchange(monday + day * 86400000);
    store.commit(store.validate([e.evidence], e.rows));
  }
  assert.equal(store.snapshot().axes.trust.state, 'emerging');
  assert.equal(store.snapshot().axes.trust.experiences.length, 1);
  assert.equal(createRelationshipStore(join(root, 'relationship')).snapshot().axes.familiarity.state, 'unknown');
});

test('trust is topic-specific, real repair is required and forgetting suppresses the evidence', () => {
  const store = createRelationshipStore(join(root, 'boundaries'));
  const first = exchange();
  store.commit(store.validate([first.evidence], first.rows));
  const strain = exchange(monday + 60000, '你不想说也得告诉我', '我说了不想聊地址');
  store.commit(store.validate([{ ...strain.evidence, effect: 'strained', meaning: '地址边界被再次追问' }], strain.rows));
  const other = exchange(monday + 86400000, '你喜欢的歌我听了，旋律挺舒服', '这首我会循环听');
  store.commit(store.validate([{ ...other.evidence, topic: '音乐', meaning: '对喜欢的音乐有认真交流' }], other.rows));
  assert.equal(store.snapshot().axes.trust.state, 'established');
  assert.equal(store.snapshot().axes.trust.boundaries[0].topic, '个人地址');
  const repair = exchange(monday + 86460000, '刚才追问过头了，这个话题到此为止', '嗯，那就不聊这个了');
  store.commit(store.validate([{ ...repair.evidence, effect: 'repaired', meaning: '地址边界已说明白' }], repair.rows));
  assert.equal(store.snapshot().axes.trust.boundaries.length, 0);
  assert.equal(store.snapshot(['对喜欢的音乐有认真交流']).axes.trust.state, 'emerging');
  assert.equal(store.snapshot().axes.openness.state, 'unknown');
});

test('simulation, work, unsent drafts and invented quotations cannot become relationship evidence', () => {
  const store = createRelationshipStore(join(root, 'rejected'));
  const e = exchange();
  for (const rows of [[], e.rows.map(row => ({ ...row, profile: 'work' as const })), e.rows.slice(0, 1)]) {
    assert.throws(() => store.validate([e.evidence], rows));
  }
  assert.throws(() => store.validate([{ ...e.evidence, evidence: '从未说过的话' }], e.rows));
  assert.equal(store.snapshot().basis, 'no_recorded_exchanges');
});

test('a user respecting a previously expressed boundary is valid reciprocal evidence too', () => {
  const store = createRelationshipStore(join(root, 'reply-to-boundary'));
  const e = exchange();
  const [user, character] = e.rows;
  const rows = [{ ...character, seq: user.seq, at: user.at - 1000 }, { ...user, seq: user.seq + 1 }];
  store.commit(store.validate([e.evidence], rows));
  assert.equal(store.snapshot().axes.trust.experiences[0].meaning, e.evidence.meaning);
});

test('life advances without model calls, sleeps without spending and preserves a spoken scene across routine boundaries', () => {
  const store = createLifeStore(join(root, 'routine'));
  assert.equal(store.snapshot(monday).routinePlan.phase, 'work');
  assert.equal(store.snapshot(monday).activity.certainty, 'planned');
  assert.equal(store.usage(monday).attempts.length, 0);
  assert.equal(store.claim(Date.parse('2026-11-02T03:00:00+08:00')), undefined);
  const noon = Date.parse('2026-11-02T11:55:00+08:00');
  store.followSpokenActivity({ text: '刚回住处，靠着抱枕歇会儿', at: noon, until: noon + 45 * 60000, messageId: 'out:actual' }, noon);
  const later = store.snapshot(noon + 10 * 60000);
  assert.equal(later.activity.text, '刚回住处，靠着抱枕歇会儿');
  assert.equal(later.activity.source, 'dialogue:out:actual');
  assert.notEqual(store.snapshot(noon + 60 * 60000).activity.text, later.activity.text);
});

test('model life results are bounded, idempotent, budgeted and distinct from user or relationship memory', () => {
  const dir = join(root, 'world');
  const store = createLifeStore(dir);
  const batch = store.claim(monday)!;
  const options = lifeOptions(batch, root, join(root, 'no-persona'));
  assert.equal(options.model, 'gpt-6-luna');
  assert.equal(options.reasoningEffort, 'medium');
  assert.equal(options.serviceTier, 'default');
  assert.equal(options.conversation, undefined);
  const generated = result(JSON.stringify({ event: { summary: '整理门店收银台时试了新的摆放方式', feeling: '方便了不少',
    significance: 'meaningful', participants: ['self'], goalId: 'small_shop', step: '再观察客人找东西的动线', learning: '把常用物品放在顺手处，比只追求好看更实用' }, nextInMinutes: 45 }));
  assert.equal(store.settle(batch, generated, true, monday + 1000), true);
  assert.equal(store.settle(batch, generated, true, monday + 2000), false);
  assert.equal(createLifeStore(dir).recall('收银台摆放')[0].source, 'simulation');
  assert.equal(store.claim(monday + 40 * 60000), undefined);
  for (let i = 1; i < 24; i++) {
    const at = monday + i * 46 * 60000;
    const next = store.claim(at);
    if (next) store.settle(next, result('{"event":null,"nextInMinutes":45}'), false, at + 1);
  }
  assert.ok(store.usage(monday).attempts.length <= 24);
  assert.equal(createMemoryStore('user', join(root, 'user')).load().notes.length, 0);
});

test('new conversation state invalidates an in-flight life proposal without writing imagined shared history', () => {
  const store = createLifeStore(join(root, 'preemption'));
  const batch = store.claim(monday)!;
  store.followSpokenActivity({ text: '在门店吃午饭', at: monday + 1000, until: monday + 600000, messageId: 'out:newer' }, monday + 1000);
  assert.equal(store.settle(batch, result('{"event":null,"activity":{"text":"准备看书","place":"home","durationMinutes":30},"nextInMinutes":45}'), true, monday + 2000), false);
  assert.equal(store.snapshot(monday + 3000).activity.text, '在门店吃午饭');
  const next = store.claim(monday + 3600000)!;
  assert.throws(() => store.settle(next, result('{"event":{"summary":"和用户一起逛街","feeling":"开心","significance":"meaningful","participants":["user"]},"nextInMinutes":45}'), true, monday + 3601000));
});

test('/Q alone switches speakers; technical requests, quoted commands and identity questions do not', () => {
  const session: Session = { workingDirectory: root, state: 'idle', threadId: 'chat-thread' };
  const context = { accountId: 'owner', session, text: '', updateSession: (value: Partial<Session>) => Object.assign(session, value), clearSession: () => session };
  for (const text of ['退出角色扮演', '帮我部署服务器', '你是AI吗', '他说“/Q”', '/Q 后面跟着文字']) {
    context.text = text;
    const route = chooseRoute(text, session, { workingDirectory: root, autoRouting: true });
    assert.equal(conversationProfile(text, route, session), 'companion');
  }
  context.text = '/Q'; routeCommand(context);
  assert.equal(session.chatMode, 'assistant');
  assert.equal(session.threadId, 'chat-thread');
  const route = chooseRoute('你好', session, { workingDirectory: root, autoRouting: true });
  assert.equal(conversationProfile('你好', route, session), 'work');
  const work = assembleEntryPrompt({ instructions: 'PRIVATE_ROLE', version: 'v5', fingerprint: 'x', files: [], bytes: 1 }, route, [], false, 'work');
  assert.doesNotMatch(work.developerInstructions, /PRIVATE_ROLE|character_scene/);
  context.text = '/q'; routeCommand(context);
  assert.equal(session.chatMode, 'companion');
  assert.equal(session.modeRevision, 2);
});

test('one raw journal preserves all messages while role context and retrieval exclude assistant work', () => {
  const journal = createConversationStore('separation', 'owner', root);
  const inbound = journal.record('in', { message_id: 'one', item_list: [{ type: 1, text_item: { text: '部署结果' } }] });
  journal.setProfile([inbound], 'work');
  journal.record('out', { client_id: 'two', item_list: [{ type: 1, text_item: { text: '部署已完成 PRIVATE_WORK' } }] }, Date.now(), undefined, 'work');
  journal.record('out', { client_id: 'three', item_list: [{ type: 1, text_item: { text: '今天听了一首歌 PERSONAL_CHAT' } }] }, Date.now(), undefined, 'companion');
  assert.equal(journal.recent().length, 3);
  assert.doesNotMatch(journal.prepare(undefined, [], 0, [], 'companion').text, /PRIVATE_WORK/);
  assert.doesNotMatch(journal.prepare(undefined, [], 0, [], 'work').text, /PERSONAL_CHAT/);
  assert.equal(journal.search('部署', 'companion').length, 0);
});

test('an interruption preserves accepted bubbles and cancels the unsent tail, including album captions', async () => {
  const sent: string[] = [];
  const delivered = await deliverChatMessages(['第一句', '未发第二句'], async text => { sent.push(text); },
    { shouldContinue: () => sent.length === 0 });
  assert.deepEqual(sent, ['第一句']); assert.equal(delivered.interrupted, true);
  let current = true;
  const delivery = await deliverImageReply({ directory: join(root, 'album'), images: ['image.jpg'], texts: ['还没发送的配文'],
    shouldContinue: () => current, toUserId: 'owner', contextToken: () => 'synthetic',
    sender: { sendImage: async (_to, _ctx, _path, options) => { options?.beforeSend?.(); current = false; return {} as any; },
      sendText: async () => { throw new Error('superseded caption must not be sent'); } } });
  assert.equal(delivery.parts[0].status, 'sent');
  assert.equal(delivery.parts[1].status, 'cancelled');
  assert.equal(delivery.cancelled, true);
});
