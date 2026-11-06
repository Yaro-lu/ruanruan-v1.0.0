import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore, runWithMemory } from '../src/memory.js';
import { createContinuityStore, continuityContext } from '../src/continuity.js';
import { rankMemories } from '../src/memory-recall.js';
import { createWechatTools } from '../src/wechat-tools.js';
import { workSession, acceptThread, type Session } from '../src/session.js';
import { assembleEntryPrompt } from '../src/prompt.js';
import { chooseRoute, conversationProfile } from '../src/routing.js';
import type { ConversationMessage } from '../src/conversation.js';
import type { CodexRunOptions } from '../src/codex/bridge.js';
import { commitConsolidation, pendingConsolidation } from '../src/consolidation.js';
import { createConversationStore } from '../src/conversation.js';
import { randomUUID } from 'node:crypto';
import { conversationOptions } from '../src/companion-profile.js';

function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'companion-v4-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const row = (id: string, text: string, direction: 'in' | 'out' = 'out', at = 1000): ConversationMessage =>
  ({ id, text, direction, at, seq: 1, payload: {}, profile: 'companion' });

test('activity expires into past experience and does not remain a present-tense fact', t => {
  const store = createContinuityStore(fixture(t));
  const messages = [row('out:1', '我正歇着吃冰淇淋呢')];
  store.commit(store.validate([{ key: 'activity', text: '吃冰淇淋', messageId: 'out:1', evidence: '吃冰淇淋', until: 601000 }], messages), 1);
  assert.equal(store.snapshot(2000).active[0].text, '吃冰淇淋');
  assert.equal(store.snapshot(2 * 3600000).active.length, 0);
  assert.equal(store.snapshot(2 * 3600000).previousActivity?.text, '吃冰淇淋');
  const relative = store.validate([{ key: 'activity', text: '吃冰淇淋', messageId: 'out:1', evidence: '吃冰淇淋', validForMinutes: 10 }], messages);
  assert.equal(relative[0].until, 601000);
  assert.throws(() => store.validate([{ key: 'feeling', text: '手冷', messageId: 'out:1', evidence: '手冷', until: 2000 }], messages));
  assert.throws(() => store.validate([{ key: 'activity', text: '吃冰淇淋', messageId: 'out:1', evidence: '吃冰淇淋', until: 86401000 }], messages));
});

test('time gap uses the previous input, not the just-received message or last output', t => {
  const store = createContinuityStore(fixture(t));
  const context = continuityContext(store, [row('in:1', '冷不冷', 'in', 1000), row('out:1', '还好', 'out', 2000), row('in:2', '继续', 'in', 7201000)], ['in:2'], 7201000);
  assert.equal(context.minutesSincePreviousInput, 120);
  assert.equal(context.timezone, 'Asia/Shanghai');
});

test('recall allows zero hits and short Chinese compounds can match separated words', () => {
  const notes = [{ id: 'job', kind: 'task', text: '已经修改服务器配置并重启' }, { id: 'fish', kind: 'fact', text: '周六钓鲫鱼用玉米' }];
  assert.deepEqual(rankMemories(notes, '好冷啊'), []);
  assert.deepEqual(rankMemories(notes, '钓鱼').map(note => note.id), ['fish']);
  assert.deepEqual(rankMemories(notes, '天气').map(note => note.id), []);
});

test('plain conversation migrates once, keeps native history, and never saves an undelivered draft', async t => {
  const memory = createMemoryStore('bot', fixture(t));
  const session: Session = { workingDirectory: '/tmp', state: 'idle', threadId: 'old-work-contaminated', memoryVersion: 1 };
  const calls: CodexRunOptions[] = [];
  const runner = async (options: CodexRunOptions) => { calls.push(options); return { threadId: 'clean-chat', replyText: '就想吃嘛', commands: [], fileChanges: [] }; };
  const options: CodexRunOptions = { profile: 'companion', prompt: '这么冷还吃冰淇淋', cwd: '/tmp', mode: 'plan', developerInstructions: '人格' };
  const first = await runWithMemory(options, session, memory, () => {}, runner);
  const second = await runWithMemory({ ...options, prompt: '行吧' }, session, memory, () => {}, runner);
  assert.equal(first.replyText, '就想吃嘛');
  assert.equal(second.error, undefined);
  assert.equal(calls[0].threadId, undefined);
  assert.equal(calls[1].threadId, 'clean-chat');
  assert.doesNotMatch(calls[0].developerInstructions!, /WCB_MEMORY|每轮必须/);
  assert.match(calls[1].prompt, /时间与连续状态/);
  assert.deepEqual(memory.load().recent, []);
  assert.deepEqual(memory.load().notes, []);
});

test('a resumed photo follow-up receives the latest accepted scene and refreshed rules without resetting history', async t => {
  const account = `scene-test-${randomUUID()}`, peer = 'owner';
  const memory = createMemoryStore(account, fixture(t));
  const journal = createConversationStore(account, peer);
  t.after(() => rmSync(journal.path, { force: true }));
  const scene = { asset_id: 'rr_image_0053', kind: 'image', title: '室内低头近景',
    description: '室内，穿蓝白外套，靠着靠垫。', tags: ['室内', '蓝白外套', '靠垫'],
    subject: { relation: 'self', name: '阮阮' },
    provenance: { origin: 'user_provided_library', liveCapture: false, format: 'video_frame' } };
  const session: Session = { workingDirectory: '/tmp', state: 'idle', threadId: 'existing-scene',
    companionVersion: 5, memoryVersion: 1, developerInstructionsHash: 'previous-rules' };
  const config = { workingDirectory: '/tmp', autoRouting: true };
  const entry = assembleEntryPrompt(undefined, chooseRoute('你现在是躺在哪里呀', session, config), [], true, 'companion');
  // This send happens after entry assembly: execution must read the accepted
  // journal rather than a snapshot that existed when the request was queued.
  const picture = journal.record('out', { client_id: 'photo', local_media: scene,
    item_list: [{ type: 2, image_item: {} }] }, Date.now(), session.threadId, 'companion');
  const caption = '靠着抱枕歇会儿，跟你聊聊天';
  journal.annotateMedia(picture, { caption });
  journal.record('out', { client_id: 'caption', item_list: [{ type: 1, text_item: { text: caption } }] }, Date.now(), session.threadId, 'companion');
  const input = journal.record('in', { message_id: 'followup', item_list: [{ type: 1, text_item: { text: '你现在是躺在哪里呀' } }] }, Date.now(), undefined, 'companion');
  let calls = 0;
  const options: CodexRunOptions = { ...entry, profile: 'companion', prompt: '你现在是躺在哪里呀', cwd: '/tmp', mode: 'plan',
    conversation: { accountId: account, peerId: peer, messageIds: [input] } };
  const runner = async (options: CodexRunOptions) => {
    assert.equal(options.threadId, 'existing-scene');
    assert.equal(options.injectDeveloperInstructionsOnResume, calls++ === 0);
    assert.match(options.prompt, /最近已确认发送的相册画面/);
    const completeFacts = JSON.stringify(options.turnFacts);
    assert.match(completeFacts, /靠着抱枕歇会儿/);
    assert.match(completeFacts, /"liveCapture":false/);
    assert.match(completeFacts, /"relation":"self"/);
    assert.match(completeFacts, /"active":\[\]/);
    if (calls === 1) assert.match(options.prompt, /靠着抱枕歇会儿/);
    else assert.doesNotMatch(options.prompt, /靠着抱枕歇会儿/, 'unchanged media stays in the resumed thread rather than being appended again');
    assert.ok(options.prompt.includes(JSON.stringify({speaker:'对方',text:'你现在是躺在哪里呀'})));
    assert.equal(options.currentUser,'你现在是躺在哪里呀');
    return { threadId: 'existing-scene', replyText: '在住处歇着呢', commands: [], fileChanges: [] };
  };
  await runWithMemory(options, session, memory, () => {}, runner);
  await runWithMemory(options, session, memory, () => {}, runner);
  assert.equal(session.threadId, 'existing-scene');
  assert.deepEqual(memory.load().notes, [], 'mock output must not turn a scene into a real-world memory');
  assert.equal(journal.recentMedia()[0].caption, caption);
  const boundary = journal.latestSequence();
  await runWithMemory({ ...options, conversation: { ...options.conversation!, after: boundary } }, session, memory, () => {}, async o => {
    assert.doesNotMatch(o.prompt, /rr_image_0053|靠着抱枕歇会儿/);
    return { threadId: 'existing-scene', replyText: '嗯', commands: [], fileChanges: [] };
  });
});

test('consolidation rejects invented source, keeps user evidence and does not restore forgotten memory', t => {
  const memory = createMemoryStore('bot', fixture(t));
  const source = row('in:1', '周六我去钓鱼', 'in');
  assert.throws(() => memory.applyDelivered([{ id: 'fish', kind: 'fact', text: '喜欢钓鱼', evidence: '喜欢钓鱼', messageId: 'in:1' }], [source]));
  memory.applyDelivered([{ id: 'fish', kind: 'fact', text: '永久喜欢钓鱼', evidence: '周六我去钓鱼', messageId: 'in:1' }], [source]);
  assert.equal(memory.load().notes[0].text, '周六我去钓鱼');
  assert.equal(memory.load().notes[0].source?.messageId, 'in:1');
  memory.forget('fish');
  memory.applyDelivered([{ id: 'fish', kind: 'fact', text: '周六我去钓鱼', evidence: '周六我去钓鱼', messageId: 'in:1' }], [source]);
  assert.deepEqual(memory.load().notes, []);
});

test('background batch preserves grounded entries while reporting rejected entries', t => {
  const account = `consolidation-test-${randomUUID()}`;
  const memory = createMemoryStore(account), journal = createConversationStore(account, 'owner');
  t.after(() => { rmSync(memory.dir, { recursive: true, force: true }); rmSync(journal.path, { force: true }); });
  for (let i = 0; i < 4; i++) {
    journal.record('in', { message_id: String(i), item_list: [{ type: 1, text_item: { text: '我不吃香菜' } }] }, Date.now(), undefined, 'companion');
    journal.record('out', { client_id: String(i), item_list: [{ type: 1, text_item: { text: '记得啦' } }] }, Date.now(), undefined, 'companion');
  }
  const batch = pendingConsolidation(account, 'owner')!;
  assert.equal(batch.messages.length, 8);
  const source = batch.messages[0];
  const outcome = commitConsolidation(account, batch, { commands: [], fileChanges: [], replyText: JSON.stringify({
    upsert: [{ kind: 'fact', fact: { subject: 'user', attribute: '忌口:香菜' }, text: '我不吃香菜', messageId: source.id, evidence: '我不吃香菜' }],
    state: [{ key: 'activity', text: '吃饭', messageId: source.id, evidence: '我在吃饭', until: source.at + 1000 }],
  }) });
  assert.equal(outcome.saved, 1);
  assert.equal(outcome.rejected.length, 1);
  assert.equal(outcome.rejected[0].section, 'state');
  assert.equal(memory.continuity.snapshot().active.length, 0);
  assert.equal(memory.continuity.meta().through, batch.through);
  assert.equal(memory.load().notes[0].source?.messageId, source.id);
  assert.equal(pendingConsolidation(account, 'owner'), undefined);
});

test('explicit memory updates apply immediately and require the current user instruction', async t => {
  const root = fixture(t);
  const host = createWechatTools('bot', 'owner', { memoryRoot: root, currentUser: '记住我不吃香菜', messageId: 'in:1' });
  await host.call('memory_update', { operation: 'remember', id: 'food', instruction: '记住我不吃香菜', evidence: '我不吃香菜' });
  assert.equal(createMemoryStore('bot', root).load().notes[0].text, '我不吃香菜');
  await assert.rejects(host.call('memory_update', { operation: 'remember', id: 'invented', instruction: '记住我不吃香菜', evidence: '我还喜欢钓鱼' }));
  const forget = createWechatTools('bot', 'owner', { memoryRoot: root, currentUser: '忘记我不吃香菜' });
  await forget.call('memory_update', { operation: 'forget', id: 'food', instruction: '忘记我不吃香菜' });
  assert.equal(forget.forgotten, true);
  assert.deepEqual(createMemoryStore('bot', root).load().notes, []);
});

test('new explicit facts get a stable server id when the model omits the id', async t => {
  const root = fixture(t);
  const host = createWechatTools('bot', 'owner', { memoryRoot: root, currentUser: '记住我周六钓鲫鱼，用玉米', messageId: 'in:1' });
  const args = { operation: 'remember', instruction: '记住我周六钓鲫鱼，用玉米', evidence: '我周六钓鲫鱼，用玉米' };
  const a: any = await host.call('memory_update', args);
  const b: any = await host.call('memory_update', { ...args, id: '' });
  assert.equal(a.saved, true); assert.equal(a.id, b.id);
  assert.equal(createMemoryStore('bot', root).load().notes.length, 1);
});

test('natural corrections retain current user evidence instead of requiring the exact word 改成', async t => {
  const root = fixture(t), memory = createMemoryStore('bot', root);
  memory.remember('fishing_day', '周六去钓鱼', 'previous-input');
  const currentUser = '改一下，周六不去，改周日。鱼和饵不变';
  const host = createWechatTools('bot', 'owner', { memoryRoot: root, currentUser, messageId: 'correction-input' });
  const result: any = await host.call('memory_update', { operation: 'remember', id: 'fishing_day',
    instruction: currentUser, evidence: '周六不去，改周日' });
  assert.equal(result.saved, true);
  const note = memory.load().notes.find(row => row.id === 'fishing_day')!;
  assert.equal(note.text, '周六不去，改周日');
  assert.equal(note.source?.messageId, 'correction-input');
  const paraphrased: any = await host.call('memory_update', { operation: 'remember', id: 'fishing_day',
    instruction: '记住改为周日', evidence: '周六不去，改周日' });
  assert.equal(paraphrased.saved, true, 'authorization comes from the actual user message, not a repeated model argument');
  await assert.rejects(createWechatTools('bot', 'owner', { memoryRoot: root, currentUser: '晚上好' })
    .call('memory_update', { operation: 'forget', id: 'fishing_day', instruction: '忘掉钓鱼' }), /用户明确的遗忘/);
  await assert.rejects(host.call('memory_update', { operation: 'remember', id: 'fishing_day',
    instruction: currentUser, evidence: '周日去钓鲫鱼，用玉米' }), /本轮原话/);
});

test('a partial fact correction remains complete after transient state expires, reload and forgetting', async t => {
  const root = fixture(t), memory = createMemoryStore('bot', root);
  memory.remember('fishing', '周六钓鲫鱼，用玉米', 'first-input', 1000);
  memory.remember('fishing', '周六不去，改周日。鱼和饵不变', 'correction-input', 2000);
  // Reprocessing the same delivered evidence must not duplicate its lineage.
  memory.remember('fishing', '周六不去，改周日。鱼和饵不变', 'correction-input', 2000);
  memory.clearRecent();
  const restored = createMemoryStore('bot', root);
  assert.deepEqual(restored.continuity.snapshot().active, []);
  assert.equal(restored.load().recent.length, 0);
  const note = restored.recall('钓鲫鱼用什么饵')[0];
  assert.equal(note.text, '周六不去，改周日。鱼和饵不变');
  assert.equal(note.source?.messageId, 'correction-input');
  assert.deepEqual(note.priorSources?.map(source => source.quote), ['周六钓鲫鱼，用玉米']);
  const prompt = restored.prepareTurn('钓鲫鱼的安排', true).text;
  assert.match(prompt, /周六不去，改周日/);
  assert.match(prompt, /周六钓鲫鱼，用玉米/);
  assert.match(prompt, /用户对自己经历的纠正优先/);
  const host = createWechatTools('bot', 'owner', { memoryRoot: root, directory: root });
  const recalled: any = await host.call('memory_recall', { query: '鲫鱼玉米' });
  assert.equal(recalled.notes[0].source.messageId, 'correction-input');
  assert.equal(recalled.notes[0].priorSources[0].messageId, 'first-input');
  restored.forget('fishing');
  assert.deepEqual(restored.recall('钓鲫鱼'), []);
  assert.ok(restored.load().forgotten?.some(row => row.text === '周六钓鲫鱼，用玉米'));
});

test('a correction without a valid target asks for the original memory id instead of saving a disconnected fragment', async t => {
  const root = fixture(t), memory = createMemoryStore('bot', root);
  memory.remember('fishing', '周日钓鲫鱼，用玉米', 'original-input');
  const currentUser = '再改一下，改成蚯蚓，鱼和日期都不动。';
  const host = createWechatTools('bot', 'owner', { memoryRoot: root, currentUser, messageId: 'correction-input' });
  const args = { operation: 'remember', instruction: currentUser, evidence: '改成蚯蚓，鱼和日期都不动' };
  const missing: any = await host.call('memory_update', args);
  assert.equal(missing.saved, false);
  assert.equal(missing.status, 'correction_requires_existing_id');
  assert.equal(missing.notes[0].id, 'fishing');
  const unknown: any = await host.call('memory_update', { ...args, id: 'invented_new_id' });
  assert.equal(unknown.saved, false);
  assert.equal(memory.load().notes.length, 1);
  const saved: any = await host.call('memory_update', { ...args, id: 'fishing' });
  assert.equal(saved.saved, true);
  assert.equal(memory.load().notes.length, 1);
  assert.equal(memory.load().notes[0].text, args.evidence);
  assert.equal(memory.load().notes[0].priorSources?.[0].quote, '周日钓鲫鱼，用玉米');
});

test('a batched or steered fact retains the actual source message and timestamp', async t => {
  const root = fixture(t), journal = createConversationStore('bot', 'owner', root);
  const first = journal.record('in', { message_id: 'one', item_list: [{ type: 1, text_item: { text: '记住我周六钓鲫鱼' } }] }, 1000, undefined, 'companion');
  const second = journal.record('in', { message_id: 'two', item_list: [{ type: 1, text_item: { text: '还在吗' } }] }, 2000, undefined, 'companion');
  const host = createWechatTools('bot', 'owner', { directory: root, memoryRoot: root,
    currentUser: '记住我周六钓鲫鱼\n还在吗', messageIds: [first, second] });
  await host.call('memory_update', { operation: 'remember', instruction: '记住我周六钓鲫鱼', evidence: '我周六钓鲫鱼' });
  const note = createMemoryStore('bot', root).load().notes[0];
  assert.equal(note.source?.messageId, first);
  assert.equal(note.source?.at, new Date(1000).toISOString());
  const third = journal.record('in', { message_id: 'three', item_list: [{ type: 1, text_item: { text: '记住我用玉米作饵' } }] }, 3000, undefined, 'companion');
  host.appendUser('记住我用玉米作饵', [third]);
  await host.call('memory_update', { operation: 'remember', instruction: '记住我用玉米作饵', evidence: '我用玉米作饵' });
  assert.equal(createMemoryStore('bot', root).load().notes.at(-1)?.source?.messageId, third);
});

test('automatic chat uses Terra medium Fast, preserving manual and work choices', () => {
  const session: Session = { workingDirectory: '/tmp', state: 'idle' };
  const config = { workingDirectory: '/tmp', autoRouting: true };
  const route = chooseRoute('你好', session, config);
  assert.equal(conversationOptions(route, 'companion').reasoningEffort, 'medium');
  assert.equal(conversationOptions(route, 'companion').model, 'gpt-6.1-terra');
  assert.equal(conversationOptions(route, 'work').reasoningEffort, 'medium');
  assert.equal(conversationOptions(route, 'work').model, 'gpt-6.1-terra');
  const manual = chooseRoute('你好', { ...session, reasoningEffort: 'high' }, config);
  assert.equal(conversationOptions(manual, 'companion').reasoningEffort, 'high');
});

test('work thread updates cannot replace the chat thread or its context budget', () => {
  const session: Session = { workingDirectory: '/tmp', state: 'idle', threadId: 'chat', contextTokens: 1200,
    companionVersion: 5, workContext: { threadId: 'work', contextTokens: 7000 } };
  const work = workSession(session);
  assert.equal(work.threadId, 'work');
  assert.equal(work.contextTokens, 7000);
  work.threadId = 'work-new'; work.contextTokens = 9000;
  acceptThread(session, work, true);
  assert.equal(session.threadId, 'chat');
  assert.equal(session.contextTokens, 1200);
  assert.equal(session.workContext?.threadId, 'work-new');
});

test('technical topics stay in character and only explicit assistant mode selects work', () => {
  const session: Session = { workingDirectory: '/tmp', state: 'idle' };
  const config = { workingDirectory: '/tmp', autoRouting: true };
  for (const [text, expected] of [['看看服务器日志', 'companion'], ['城市数字化是什么', 'companion'], ['你今天上班吗', 'companion']] as const) {
    const route = chooseRoute(text, session, config);
    assert.equal(conversationProfile(text, route, session), expected);
    assert.equal(conversationProfile(text, route, { chatMode: 'assistant' }), 'work');
    assert.equal(route.options.model, 'gpt-6.1-terra');
  }
  const prompt = assembleEntryPrompt(undefined, chooseRoute('在干嘛', session, config), [], true, 'companion');
  assert.doesNotMatch(prompt.developerInstructions, /WCB_MEMORY|proposedModification|工作进度协议/);
});
