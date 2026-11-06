import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assembleEntryPrompt } from '../src/prompt.js';
import { loadPersonaSnapshot } from '../src/persona.js';
import { chooseRoute } from '../src/routing.js';
import { createMemoryStore, MEMORY_MARKER, runWithMemory } from '../src/memory.js';
import { buildCodexArgs } from '../src/codex/bridge.js';
import type { Session } from '../src/session.js';
import type { CatalogCandidate } from '../src/media-catalog.js';

test('persona conversation and the explicitly selected normal assistant have separate prompts', () => {
  const session: Session = { state: 'idle', workingDirectory: '/tmp' };
  const route = chooseRoute('你好', session, { workingDirectory: '/tmp', autoRouting: true });
  const chat = assembleEntryPrompt(undefined, route, [], false);
  const work = assembleEntryPrompt(undefined, chooseRoute('检查磁盘', session, { workingDirectory: '/tmp', autoRouting: true }), [], false, 'work');
  assert.match(chat.developerInstructions, /character_scene/);
  assert.doesNotMatch(chat.turnContext, /只读排查|任务进度协议|待确认修改方案|task:/);
  assert.doesNotMatch(chat.turnContext, /推荐未命中/);
  assert.match(work.turnContext, /不修改业务文件/);
  for (const text of ['看看你在干嘛', '你刚才想什么呢', '给我看看你', '看看今天的新闻']) {
    const entry = assembleEntryPrompt(undefined, chooseRoute(text, session, { workingDirectory: '/tmp', autoRouting: true }), [], false);
    assert.equal(entry.turnContext, chat.turnContext, text);
  }
});

test('media, routing and burst changes do not change the developer prefix or repeat it in history', async t => {
  const root = mkdtempSync(join(tmpdir(), 'wcb-prefix-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'persona.md'), '阮阮核心人格 v2\n你叫阮阮，喜欢分享自己的想法。');
  const persona = loadPersonaSnapshot(true, root)!;
  assert.equal(loadPersonaSnapshot(false, root)!.instructions, persona.instructions);
  const session: Session = { state: 'idle', workingDirectory: root, memoryVersion: 1 };
  const memory = createMemoryStore('owner', root);
  const candidate: CatalogCandidate = { asset_id: 'rr_image_0001', kind: 'image', title: '抱猫', file: '图片/cat.jpg', tags: ['猫'] };
  let fixed: string | undefined;
  const inputs = ['你好', '发张猫的照片', '检查磁盘，先不要改', '修改项目配置', '你好'];
  for (const [index, user] of inputs.entries()) {
    const route = chooseRoute(user, session, { workingDirectory: root, autoRouting: true });
    const entry = assembleEntryPrompt(persona, route, index === 1 ? [candidate] : [], index % 2 === 0, 'companion');
    await runWithMemory({ prompt: user, cwd: root, mode: 'plan', profile: 'companion', ...entry }, session, memory, () => {}, async options => {
      fixed ??= options.developerInstructions;
      assert.equal(options.developerInstructions, fixed);
      assert.equal(options.injectDeveloperInstructionsOnResume, false);
      assert.ok(options.prompt.includes(JSON.stringify({speaker:'对方',text:user})));
      assert.ok(options.prompt.endsWith('按本轮生成提示词接续下一轮微信台词，并沿用内部接续协议。'));
      assert.equal(options.currentUser,user,'tools still receive the exact incoming message');
      assert.ok(!options.prompt.includes('【本轮微信入口配置】'));
      assert.match(options.prompt, /持续生活/);
      assert.equal(options.prompt.includes(candidate.asset_id), false);
      if (index > 0) assert.ok(!buildCodexArgs(options).at(-1)!.includes('喜欢分享自己的想法'));
      assert.doesNotMatch(options.developerInstructions!, /任务进度协议|proposedModification/);
      return { replyText: '好呀\n' + MEMORY_MARKER + '{"upsert":[],"remove":[]}',
        threadId: 'continuous', commands: [], fileChanges: [] };
    });
  }
  assert.equal(session.threadId, 'continuous');
  assert.equal(memory.load().recent.length, 0, 'unsent model drafts do not become delivered history');
});

test('new and resumed calls preserve native model compaction defaults and the same thread', () => {
  for (const threadId of [undefined, 'existing']) {
    const args = buildCodexArgs({ prompt: '你好', cwd: '/tmp', mode: 'plan', threadId });
    assert.ok(!args.some(arg => arg.startsWith('model_auto_compact_token_limit=')));
    if (threadId) assert.equal(args.at(-2), threadId);
  }
});
