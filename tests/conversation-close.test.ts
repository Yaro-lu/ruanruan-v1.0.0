import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversationMessage } from '../src/conversation.js';
import type { CodexRunOptions } from '../src/codex/bridge.js';
import type { Session } from '../src/session.js';

const root = mkdtempSync(join(tmpdir(), 'wcb-close-'));
process.env.WCB_DATA_DIR = root;
const { isRepeatedFarewell, replyTextForDelivery, planChatReply, deliverChatMessages } = await import('../src/utils/chat-reply.js');
const { createMemoryStore } = await import('../src/memory.js');
const { createConversationStore } = await import('../src/conversation.js');
const { runConversationTurn } = await import('../src/chat-retry.js');
const { hasCharacterApproval } = await import('../src/character-review.js');
const { COMPANION_CONFIG } = await import('../src/companion-profile.js');
test.after(() => rmSync(root, { recursive: true, force: true }));

test('closing requires a recent actual farewell and no new content or mode boundary', () => {
  const now = Date.now();
  const row = (seq: number, direction: 'in' | 'out', text: string): ConversationMessage =>
    ({ seq, id: String(seq), at: now, direction, text, payload: {}, profile: 'companion' });
  const previous = row(1, 'out', '嗯，晚安。'), current = row(2, 'in', '拜拜');
  assert.equal(isRepeatedFarewell([previous, current], ['2'], now), true);
  for (const text of ['晚安，对了你明天上班吗', '再见是什么意思？', '你是不是不想聊了', '嗯', '/Q', '[图片]', '“拜拜”']) {
    assert.equal(isRepeatedFarewell([previous, { ...current, text }], ['2'], now), false, text);
  }
  assert.equal(isRepeatedFarewell([previous, current, row(3, 'in', '对了，明天上班吗')], ['2'], now), false);
  assert.equal(isRepeatedFarewell([previous, current, row(3, 'in', '对了，明天上班吗')], ['2', '3'], now), false);
  assert.equal(isRepeatedFarewell([previous, current], ['missing'], now), false);
  assert.equal(isRepeatedFarewell([{ ...previous, profile: 'work' }, current], ['2'], now), false);
  assert.equal(isRepeatedFarewell([{ ...previous, at: now - 16 * 60000 }, current], ['2'], now), false);
  assert.equal(isRepeatedFarewell([row(1, 'out', '今天有点累'), current], ['2'], now), false);
});

test('intentional close spends no model calls, sends nothing, and a new question resumes normally', async () => {
  const memory = createMemoryStore('close'), journal = createConversationStore('close', 'peer');
  const record = (direction: 'in' | 'out', text: string, id: string) => journal.record(direction,
    { message_id: id, client_id: id, item_list: [{ type: 1, text_item: { text } }] }, Date.now(), undefined, 'companion');
  record('out', '晚点聊。', 'previous');
  const incoming = record('in', '拜拜', 'close');
  const options: CodexRunOptions = { prompt: '拜拜', cwd: root, mode: 'plan', profile: 'companion',
    personaContext: { version: 'ruanruan-core-v6', fingerprint: 'test', files: [], bytes: 0 },
    conversation: { accountId: 'close', peerId: 'peer', messageIds: [incoming] } };
  const session: Session = { state: 'idle', workingDirectory: root, threadId: 'existing', memoryVersion: 1 };
  const stateBefore = JSON.stringify(memory.load());
  const result = await runConversationTurn(options, session, memory, () => {}, async () => { throw new Error('must not call'); });
  assert.equal(result.replyDisposition, 'no_reply'); assert.ok(hasCharacterApproval(result));
  assert.equal(session.threadId, 'existing'); assert.equal(JSON.stringify(memory.load()), stateBefore);
  assert.equal(journal.recent().length, 2, 'no invented outgoing record');
  const plan = planChatReply(replyTextForDelivery(result), true);
  assert.deepEqual(plan.messages, []);
  await deliverChatMessages(plan.messages, async () => { throw new Error('must not send'); });
  assert.notEqual(replyTextForDelivery({ replyText: '' }), '', 'empty output remains distinct from deliberate silence');
  assert.equal(hasCharacterApproval({ ...result, replyText: 'new text' }), false);

  const next = record('in', '对了，你想开什么店？', 'question');
  let actors = 0, reviewers = 0;
  const answer = await runConversationTurn({ ...options, prompt: '对了，你想开什么店？',
    conversation: { ...options.conversation!, messageIds: [next] } }, session, memory, () => {}, async call => {
    assert.equal(call.threadConfig?.personality, 'none');
    if (call.profile === 'companion') { actors++; return { replyText: '还没想好卖什么。', commands: [], fileChanges: [] }; }
    reviewers++; return { replyText: '{"verdict":"pass","issues":[]}', commands: [], fileChanges: [] };
  });
  assert.equal(actors, 1); assert.equal(reviewers, 1); assert.ok(hasCharacterApproval(answer));
  assert.equal(answer.replyDisposition, undefined);
  assert.equal(COMPANION_CONFIG.personality, undefined, 'shared background configuration is unchanged');
});

test('work mode never uses companion closing or personality options', async () => {
  const memory = createMemoryStore('work');
  const session: Session = { state: 'idle', workingDirectory: root, memoryVersion: 1 };
  let calls = 0;
  const answer = await runConversationTurn({ prompt: '拜拜', cwd: root, mode: 'plan', profile: 'work' }, session, memory, () => {}, async call => {
    calls++; assert.equal(call.threadConfig?.personality, undefined);
    return { replyText: '再见。', commands: [], fileChanges: [] };
  });
  assert.equal(calls, 1); assert.equal(answer.replyDisposition, undefined);
});
