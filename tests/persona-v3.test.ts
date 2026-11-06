import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPersonaSnapshot } from '../src/persona.js';
import { buildCodexArgs } from '../src/codex/bridge.js';
import { createMemoryStore, MEMORY_MARKER, runWithMemory } from '../src/memory.js';
import { createInteractionStore, MOOD_TTL_MS } from '../src/persona-state.js';
import { rankMemories } from '../src/memory-recall.js';

function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'persona-v3-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const result = (update: unknown, text = '好，知道了。') => ({
  replyText: text + '\n' + MEMORY_MARKER + JSON.stringify(update), commands: [], fileChanges: [],
});

test('v3 loads every authored layer in new and resumed inputs and fingerprints the actual files', t => {
  const root = fixture(t);
  mkdirSync(join(root, 'persona'));
  writeFileSync(join(root, 'persona.md'), '阮阮核心人格 v3\n自己的主意');
  for (const name of ['BACKSTORY.md', 'RELATIONSHIP.md', 'STYLE.md']) writeFileSync(join(root, 'persona', name), `内容：${name}`);
  const snapshot = loadPersonaSnapshot(false, root)!;
  assert.equal(snapshot.version, 'ruanruan-core-v3');
  assert.equal(snapshot.files.length, 4);
  assert.equal(snapshot.bytes, Buffer.byteLength(snapshot.instructions));
  for (const threadId of [undefined, 'existing-thread']) {
    const args = buildCodexArgs({ prompt: '你好', cwd: root, mode: 'plan', threadId,
      developerInstructions: snapshot.instructions, personaContext: snapshot });
    for (const file of snapshot.files) assert.ok(args.join('\n').includes(file.name));
  }
  writeFileSync(join(root, 'persona', 'STYLE.md'), '改变语气内容');
  assert.notEqual(loadPersonaSnapshot(false, root)!.fingerprint, snapshot.fingerprint);
  rmSync(join(root, 'persona', 'STYLE.md'));
  assert.throws(() => loadPersonaSnapshot(false, root), /ENOENT/);
});

test('observations stay provisional, have user evidence, and cannot overwrite facts', t => {
  const memory = createMemoryStore('owner', fixture(t));
  memory.record('别每回都总结，直接接话就行', result({ upsert: [
    { id: 'voice', kind: 'observation', text: '这次闲聊似乎更希望直接接话，暂不概括成所有场景的偏好', evidence: '直接接话就行' },
  ], remove: [] }));
  let note = memory.load().notes[0];
  assert.equal(note.status, 'tentative');
  assert.ok(Date.parse(note.expiresAt!) > Date.now());
  assert.ok(memory.turnContext('你怎么看我的沟通习惯').includes('这次闲聊'));
  memory.record('工作时可以总结，闲聊时不必', result({ upsert: [
    { id: 'voice', kind: 'observation', text: '区分工作与闲聊，之前的理解需缩小范围', evidence: '工作时可以总结，闲聊时不必' },
    { id: 'explicit', kind: 'fact', text: '工作时可以总结，闲聊时不必', evidence: '工作时可以总结，闲聊时不必' },
  ], remove: [] }));
  assert.match(memory.load().notes.find(n => n.id === 'voice')!.text, /缩小范围/);
  const rejected = memory.record('嗯', result({ upsert: [
    { id: 'explicit', kind: 'observation', text: '用户总是不喜欢总结', evidence: '嗯' },
  ], remove: [] }));
  assert.equal(rejected.memorySaved, false);
  assert.equal(memory.load().notes.find(n => n.id === 'explicit')!.kind, 'fact');
  const state = memory.load();
  state.notes.find(n => n.id === 'voice')!.expiresAt = '2000-01-01T00:00:00Z'; memory.save(state);
  assert.ok(!memory.prepareTurn('你怎么看我').metadata.recalledMemoryIds.includes('voice'));
});

test('shared experiences preserve summaries and evidence while user facts stay literal', t => {
  const memory = createMemoryStore('owner', fixture(t));
  memory.record('你刚才那句太像客服了，普通点就好', result({ upsert: [
    { id: 'shared', kind: 'exchange', text: '这次用户指出客服腔，阮阮接受并调整了表达', evidence: '是有点端着，我改' },
    { id: 'life', kind: 'character', text: '角色聊到想让小店放自己喜欢的歌', evidence: '小店想放我自己喜欢的歌' },
  ], remove: [] }, '是有点端着，我改。小店想放我自己喜欢的歌。'));
  const notes = memory.load().notes;
  assert.match(notes[0].text, /接受并调整/);
  assert.equal(notes[0].source?.quote, '是有点端着，我改');
  assert.equal(notes[0].status, 'recorded');
  assert.equal(notes[1].status, 'fictional');
  assert.equal(notes[1].source?.speaker, 'assistant');
  assert.ok(memory.prepareTurn('刚才的交流').metadata.stateKeys.includes('recentEvent'));
});

test('recent events and mixed feelings survive reopening but their afterglow expires', t => {
  const root = fixture(t);
  const store = createInteractionStore(root);
  store.update('我刚刚开玩笑的', '刚才确实有点在意，听你说清楚就好了', {
    recentEvent: { text: '刚才的玩笑已经说明白', evidence: '我刚刚开玩笑的' },
    afterglow: { text: '还留一点别扭，但已经愿意继续聊', evidence: '刚才确实有点在意' },
    mood: { value: 'mixed', reason: '在意和缓和并存', evidence: '听你说清楚就好了' },
  }, 1000);
  const restored = createInteractionStore(root);
  assert.ok(restored.snapshot(1001).afterglow);
  assert.equal(restored.snapshot(1000 + MOOD_TTL_MS).afterglow, undefined);
  assert.ok(restored.snapshot(1000 + MOOD_TTL_MS).recentEvent);
  restored.update('好，翻篇', '行', { recentEvent: null, afterglow: null, mood: null }, 2000);
  assert.equal(restored.snapshot(2001).recentEvent, undefined);
});

test('local recall is bounded, metadata omits private text, and a fresh thread does not dump all notes', t => {
  const memory = createMemoryStore('owner', fixture(t));
  memory.save({ version: 1, handoff: '尚未完成的事', recent: Array.from({ length: 12 }, (_, i) => ({
    at: new Date().toISOString(), user: `旧话${i}`, assistant: '答复'.repeat(1000),
  })), notes: Array.from({ length: 16 }, (_, i) => ({ id: `fish${i}`, kind: 'fact',
    text: '钓鱼用玉米。'.repeat(120), updatedAt: '2026-10-26T00:00:00Z' })) });
  const turn = memory.prepareTurn('钓鱼试玉米');
  assert.ok(turn.metadata.recalledMemoryIds.length <= 5);
  assert.ok(turn.metadata.contextBytes < 10000);
  assert.ok(!JSON.stringify(turn.metadata).includes('钓鱼用玉米'));
  assert.doesNotMatch(memory.prepareTurn('刚才你在干嘛').text, /尚未完成的事/);
  const bootstrap = memory.context();
  assert.ok(!bootstrap.includes('旧话0'));
  assert.ok(bootstrap.includes('旧话11'));
  assert.ok(!bootstrap.includes('fish0'));
  assert.ok(!bootstrap.includes('尚未完成的事'));
  assert.ok(Buffer.byteLength(bootstrap) < 10000);
  assert.equal(rankMemories([{ id: 'x', kind: 'observation', text: '短暂看法', expiresAt: '2000-01-01' }], '你怎么看我').length, 0);
});

test('restart resumes an existing thread with current persona, source memories and state, once per user turn', async t => {
  const root = fixture(t);
  const memory = createMemoryStore('owner', root);
  memory.record('下周钓鱼试玉米', result({ upsert: [
    { id: 'bait', kind: 'fact', text: '下周钓鱼试玉米', evidence: '下周钓鱼试玉米' },
  ], remove: [], interaction: { openThread: { text: '等下周再问钓鱼结果', evidence: '下周钓鱼试玉米' } } }));
  const restored = createMemoryStore('owner', root);
  const session: any = { threadId: 'saved-thread', memoryVersion: 1, state: 'idle', workingDirectory: root };
  let calls = 0;
  await runWithMemory({ prompt: '钓鱼用什么饵来着', cwd: root, mode: 'plan', developerInstructions: '阮阮核心人格 v3' },
    session, restored, () => {}, async options => {
      calls++;
      assert.equal(options.threadId, 'saved-thread');
      assert.ok(options.injectDeveloperInstructionsOnResume);
      assert.ok(options.prompt.includes('下周钓鱼试玉米'));
      assert.ok(options.prompt.includes('等下周再问钓鱼结果'));
      return { ...result({ upsert: [], remove: [] }), threadId: 'saved-thread' };
    });
  assert.equal(calls, 1);
  assert.equal(session.threadId, 'saved-thread');
});
