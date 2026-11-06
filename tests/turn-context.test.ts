import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CodexRunOptions } from '../src/codex/bridge.js';
import type { Session } from '../src/session.js';
import type { CharacterTurnFacts } from '../src/turn-context.js';
const root = mkdtempSync(join(tmpdir(), 'turn-context-'));
process.env.WCB_DATA_DIR = root;
const { characterContextPrompt, needsPastMemory } = await import('../src/turn-context.js');
const { createMemoryStore, runWithMemory } = await import('../src/memory.js');
const { createConversationStore } = await import('../src/conversation.js');
test.after(() => rmSync(root, { recursive: true, force: true }));

test('state patches carry current numeric values and removals; new threads and compaction receive a complete snapshot', () => {
  const original: CharacterTurnFacts = { now: '2026-11-05 12:00', timezone: 'Asia/Shanghai', notes: [], recent: [],
    state: { interaction: { relationship: { affinity: { affection: 120, conflict: { intensity: 20 } } } },
      life: { activity: { text: '固定的生活场景' }, metrics: { energy: 80, mood: { value: 5 }, finance: { spendable: 500 } } } } };
  const latest = structuredClone(original);
  latest.state = { interaction: { relationship: { affinity: { affection: 121 } } },
    life: { activity: { text: '固定的生活场景' }, metrics: { energy: 70, mood: { value: 2 }, finance: { spendable: 480 } } } };
  const snapshot = { threadId: 'a', state: original.state };
  const patch = characterContextPrompt(latest, snapshot, 'a');
  assert.match(patch, /变化部分/); assert.doesNotMatch(patch, /固定的生活场景/);
  for (const expected of ['"energy":70', '"value":2', '"spendable":480', '"affection":121', '"conflict":null']) assert.ok(patch.includes(expected));
  assert.match(characterContextPrompt(latest, snapshot, 'b'), /固定的生活场景/);
  assert.match(characterContextPrompt(latest, snapshot, 'a', 1000), /固定的生活场景/);
  assert.equal((original.state.life as any).metrics.energy, 80, 'rendering must not mutate saved state');
});

test('ordinary replies avoid semantic retrieval while explicit recollection carries its evidence', async () => {
  const memory = createMemoryStore('recall-policy');
  const session: Session = { workingDirectory: root, state: 'idle' };
  let retrievals = 0;
  memory.semantic = (() => ({ search: async () => { retrievals++; return { hits: [{ id: 'old', text: '周六约了钓鱼' }], status: 'lexical', elapsedMs: 0 }; } })) as any;
  const options: CodexRunOptions = { cwd: root, mode: 'plan', profile: 'companion', prompt: '今天上班忙死了',
    personaContext: { version: 'ruanruan-core-v6', fingerprint: 'fixture', files: [], bytes: 1 },
    conversation: { accountId: 'recall-policy', peerId: 'owner', messageIds: [] } };
  await runWithMemory(options, session, memory, () => {}, async () => ({ replyText: '怎么啦', threadId: 'test', commands: [], fileChanges: [] }));
  assert.equal(retrievals, 0);
  await runWithMemory({ ...options, prompt: '你还记得上次的约定吗' }, session, memory, () => {}, async call => {
    assert.match(call.prompt, /周六约了钓鱼/);
    assert.equal(call.turnFacts?.recalled?.length, 1);
    return { replyText: '周六钓鱼', threadId: 'test', commands: [], fileChanges: [] };
  });
  assert.equal(retrievals, 1);
  assert.equal(needsPastMemory('看看这张图'), false);
});

test('generation retains complete review facts while only appending changed state to the continuing thread', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-05T04:00:00Z') });
  const memory = createMemoryStore('live-values', join(root, 'live-values'));
  const session: Session = { workingDirectory: root, state: 'idle' };
  const options: CodexRunOptions = { cwd: root, mode: 'plan', profile: 'companion', prompt: '在干嘛',
    conversation: { accountId: 'live-values', peerId: 'owner', messageIds: [] } };
  const calls: CodexRunOptions[] = [];
  const runner = async (call: CodexRunOptions) => { calls.push(call); return { replyText: '歇会儿', threadId: 'continued', commands: [], fileChanges: [] }; };
  await runWithMemory(options, session, memory, () => {}, runner);
  const before = (calls[0].turnFacts!.state.life as any).metrics;
  memory.life.metrics.exert('movement', -8, '搬货', Date.now(), -6);
  memory.life.metrics.spend('snack', 10, '小食', '小食');
  await runWithMemory({ ...options, prompt: '累不累' }, session, memory, () => {}, runner);
  const after = (calls[1].turnFacts!.state.life as any).metrics;
  assert.match(calls[0].prompt, /完整快照/); assert.match(calls[1].prompt, /变化部分/);
  assert.equal(after.energy, before.energy - 8); assert.equal(after.mood.value, before.mood.value - 6);
  assert.equal(after.finance.spendable, before.finance.spendable - 10);
  assert.ok(calls[1].prompt.includes(`"energy":${after.energy}`));
  assert.ok(calls[1].prompt.includes(`"spendable":${after.finance.spendable}`));
  assert.ok((calls[1].turnFacts!.state.life as any).activity, 'review still receives unchanged scene facts');
  session.threadId = undefined;
  await runWithMemory({ ...options, prompt: '继续聊' }, session, memory, () => {}, runner);
  assert.match(calls[2].prompt, /完整快照/);
});

test('incremental recall invalidates corrected source text and profile, but not image annotations or new messages', async () => {
  const journal = createConversationStore('source-revision', 'owner');
  const memory = createMemoryStore('source-revision');
  const first = journal.record('in', { message_id: 'first', item_list: [{ type: 1, text_item: { text: '我喜欢香菜' } }] }, Date.now(), undefined, 'companion');
  const revision = journal.sourceRevision();
  assert.match(JSON.stringify((await memory.semantic('owner').search('香菜')).hits), /我喜欢香菜/);
  journal.annotateReceivedMedia(first, [{ subject: { relation: 'self' } }]);
  journal.record('in', { message_id: 'second', item_list: [{ type: 1, text_item: { text: '你好' } }] }, Date.now(), undefined, 'companion');
  assert.equal(journal.sourceRevision(), revision);
  const db = new DatabaseSync(journal.path);
  try { db.prepare('UPDATE messages SET text=? WHERE id=?').run('我不喜欢香菜', first); } finally { db.close(); }
  assert.ok(journal.sourceRevision() > revision);
  assert.match(JSON.stringify((await memory.semantic('owner').search('香菜')).hits), /我不喜欢香菜/);
  journal.setProfile([first], 'control');
  assert.doesNotMatch(JSON.stringify((await memory.semantic('owner').search('香菜')).hits), /我不喜欢香菜/);
});
