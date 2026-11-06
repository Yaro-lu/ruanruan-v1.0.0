import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../src/session.js';
const root = mkdtempSync(join(tmpdir(), 'editable-prompts-'));
process.env.WCB_DATA_DIR = root;
const { loadPersonaSnapshot, loadCharacterBackground, DEFAULT_PROMPT_DIRECTORY } = await import('../src/persona.js');
const { CHARACTER_PERSPECTIVE_CONTRACT, CHARACTER_VOICE_CONTRACT, CHARACTER_SCENE_CONTRACT } = await import('../src/companion-profile.js');
const { assembleEntryPrompt } = await import('../src/prompt.js');
const { createMemoryStore } = await import('../src/memory.js');
const { runConversationTurn } = await import('../src/chat-retry.js');
const { hasCharacterApproval } = await import('../src/character-review.js');
const { createLifeStore, lifeOptions } = await import('../src/character-life.js');
test.after(() => rmSync(root, { recursive: true, force: true }));
function fixture() {
  const dir = mkdtempSync(join(root, 'case-'));
  writeFileSync(join(dir, 'GENERATE.md'), '# 可以自由改标题\n\n## 固定背景\n\n背景甲：住杭州。\n\n## 表达方式\n\n表达甲：按自己想法说话。');
  writeFileSync(join(dir, 'REVIEW.md'), '审查甲：只检查确定事实。');
  return dir;
}
const response = (replyText: string) => ({ replyText, commands: [], fileChanges: [] });

test('two editable prompts take precedence and review text never becomes generation instructions', () => {
  const dir = fixture();
  writeFileSync(join(dir, 'persona.md'), '旧人设不得注入');
  const snapshot = loadPersonaSnapshot(true, dir)!;
  assert.equal(snapshot.version, 'ruanruan-core-v6');
  assert.deepEqual(snapshot.files.map(row => row.name), ['GENERATE.md', 'REVIEW.md']);
  assert.doesNotMatch(snapshot.instructions, /旧人设|审查甲/);
  assert.equal(snapshot.reviewInstructions, '审查甲：只检查确定事实。');
  assert.equal(snapshot.characterFacts, '背景甲：住杭州。');
  const entry = assembleEntryPrompt(snapshot, { kind: 'manual', reason: 'fixture', options: {} }, [], true);
  assert.ok(entry.developerInstructions.startsWith(snapshot.instructions));
  assert.doesNotMatch(entry.developerInstructions, /审查甲|角色自我介绍|不以满足请求/);
  assert.equal(entry.reviewInstructions, snapshot.reviewInstructions);
  assert.equal(entry.characterFacts, snapshot.characterFacts);
});

test('editing either file is picked up, and incomplete editable layouts do not silently fall back', () => {
  const dir = fixture(), first = loadPersonaSnapshot(true, dir)!;
  writeFileSync(join(dir, 'REVIEW.md'), '审查乙');
  const second = loadPersonaSnapshot(true, dir)!;
  assert.notEqual(first.fingerprint, second.fingerprint); assert.equal(second.instructions, first.instructions);
  writeFileSync(join(dir, 'GENERATE.md'), '# 换个标题也行\n\n新的生成要求');
  assert.equal(loadPersonaSnapshot(true, dir)!.instructions, '# 换个标题也行\n\n新的生成要求');
  writeFileSync(join(dir, 'REVIEW.md'), ''); assert.throws(() => loadPersonaSnapshot(true, dir), /提示词文件为空/);
  rmSync(join(dir, 'REVIEW.md')); assert.throws(() => loadPersonaSnapshot(true, dir), /ENOENT/);
});

test('generation and review use their own current file on consecutive turns without changing the memory flow', async () => {
  const dir = fixture(), memory = createMemoryStore('editable', dir);
  const session: Session = { state: 'idle', workingDirectory: dir, memoryVersion: 1, companionVersion: 6 };
  let generations = 0, reviews = 0;
  for (const [index, marker] of ['甲', '乙'].entries()) {
    if (index) {
      writeFileSync(join(dir, 'GENERATE.md'), '生成乙\n\n## 固定背景\n\n背景乙\n\n## 表达方式\n\n表达乙');
      writeFileSync(join(dir, 'REVIEW.md'), '审查乙：不评价文风。');
    }
    const persona = loadPersonaSnapshot(true, dir)!;
    const entry = assembleEntryPrompt(persona, { kind: 'manual', reason: 'fixture', options: {} }, [], true);
    const result = await runConversationTurn({ ...entry, personaContext: persona, cwd: dir, mode: 'plan', profile: 'companion', prompt: '你好' },
      session, memory, () => {}, async call => {
        if (call.profile === 'companion') {
          generations++; assert.match(call.developerInstructions!, new RegExp(`表达${marker}`));
          assert.doesNotMatch(call.developerInstructions!, new RegExp(`审查${marker}`));
          assert.equal(call.injectDeveloperInstructionsOnResume, index > 0);
          return { ...response('你好。\n<<<RUANRUAN_STATE>>>{}'), threadId: 'existing-character-thread' };
        }
        reviews++; assert.equal(call.developerInstructions, persona.reviewInstructions);
        const data = JSON.parse(call.prompt.slice(call.prompt.indexOf('\n') + 1, call.prompt.lastIndexOf('\n')));
        assert.equal(data.context.characterFacts, persona.characterFacts); assert.equal(data.context.persona, undefined);
        return response('{"verdict":"pass","issues":[]}');
      });
    assert.ok(hasCharacterApproval(result)); assert.equal(session.threadId, 'existing-character-thread');
  }
  assert.deepEqual([generations, reviews], [2, 2]);
  assert.equal(memory.load().notes.length, 0, 'unsent fixture replies do not become business memory');
});

test('background life reads the same fixed background and keeps the causal action branch', () => {
  const dir = fixture();
  assert.equal(loadCharacterBackground(dir), '背景甲：住杭州。');
  const life = createLifeStore(join(dir, 'life')), at = Date.parse('2026-11-02T10:00:00+08:00');
  const batch = life.claim(at, true)!; assert.ok(batch.causal);
  const options = lifeOptions(batch, dir, dir);
  assert.match(options.prompt, /背景甲/); assert.doesNotMatch(options.prompt, /表达甲|审查甲/);
  assert.match(options.prompt, /可执行行动availableActions/); assert.equal(options.profile, 'consolidation');
});

test('numbered character headings keep facts separate from dialogue rules and examples', () => {
  const dir = fixture();
  writeFileSync(join(dir, 'GENERATE.md'), '# 阮阮 · 角色生成提示词\n\n## 一、 核心任务与输出铁律\n台词规则\n\n## 二、 人物档案与日常\n21岁，住杭州，月薪6000元。\n\n## 三、 性格与选择\n性格规则\n\n## 七、 核心语感示例\n假设台词');
  const persona = loadPersonaSnapshot(true, dir)!;
  assert.equal(persona.characterFacts, '21岁，住杭州，月薪6000元。');
  assert.equal(loadCharacterBackground(dir), persona.characterFacts);
  const life = createLifeStore(join(dir, 'life'));
  const options = lifeOptions(life.claim(Date.parse('2026-11-04T10:00:00+08:00'), true)!, dir, dir);
  assert.match(options.prompt, /月薪6000元/);
  assert.doesNotMatch(options.prompt, /台词规则|性格规则|假设台词/);
  const entry = assembleEntryPrompt(persona, { kind: 'manual', reason: 'fixture', options: {} }, [], true);
  assert.match(entry.developerInstructions, /<<<RUANRUAN_STATE>>>/);
  assert.match(entry.developerInstructions, /<<<RUANRUAN_BREAK>>>/);
  assert.match(entry.developerInstructions, /imageRequestId=requestId/);
});

test('the deployed prompt keeps the perspective, voice and scene sections available to existing callers', () => {
  const persona = loadPersonaSnapshot(true, DEFAULT_PROMPT_DIRECTORY)!;
  assert.match(CHARACTER_PERSPECTIVE_CONTRACT, /视角锁定/);
  assert.match(CHARACTER_VOICE_CONTRACT, /群聊/);
  assert.match(CHARACTER_SCENE_CONTRACT, /character_scene/);
  assert.match(persona.characterFacts!, /月薪6000元/);
  assert.doesNotMatch(persona.characterFacts!, /<<<RUANRUAN_STATE>>>|我看你才像AI/);
});

test('new and resumed turns read fresh shared life metrics and the current person relationship; review sees the same snapshot', async t => {
  const at = Date.parse('2026-11-04T10:00:00+08:00');
  t.mock.method(Date, 'now', () => at);
  const dir = fixture(), memory = createMemoryStore('metrics-context', dir);
  const other = createMemoryStore('other-context', dir);
  memory.life.claim(at, true);
  const session: Session = { state: 'idle', workingDirectory: dir, memoryVersion: 1, companionVersion: 6 };
  const persona = loadPersonaSnapshot(true, dir)!;
  const entry = assembleEntryPrompt(persona, { kind: 'manual', reason: 'fixture', options: {} }, [], true);
  const worlds: ReturnType<typeof memory.life.snapshot>[] = [];
  for (let index = 0; index < 2; index++) {
    if (index) {
      assert.equal(memory.life.metrics.spend('fixture-cup', 23, 'shopping', '杯子', at), true);
      memory.life.metrics.exert('fixture-day', -7, '上班有点累 但杯子很好看', at, 5);
      memory.socialObserve('peer', 'fixture-kindness', '我记得你喜欢蓝色',
        { intent: 'chat', effect: 'bonding', mode: 'reply', userQuote: '我记得你喜欢蓝色' }, at);
    }
    const expected = memory.life.snapshot(at).metrics;
    const expectedRelationship = memory.relationshipContext('peer', at);
    let actorContext = '';
    const result = await runConversationTurn({ ...entry, personaContext: persona, cwd: dir, mode: 'plan',
      profile: 'companion', prompt: '今天怎么样', conversation: { accountId: 'metrics-context', peerId: 'peer' } },
      session, memory, () => {}, async call => {
        if (call.profile === 'companion') {
          actorContext = call.prompt;
          const current = call.turnFacts!.state as any;
          const world = current.life;
          const encoded = JSON.parse(actorContext.split(/【持续生活与相处状态[^\n]*\n/u)[1].split('\n')[0]);
          assert.equal(encoded.life.metrics.finance.cash, expected.finance.cash);
          assert.deepEqual(world.metrics, expected);
          assert.equal(world.resources.energy, expected.energy);
          assert.deepEqual(current.interaction.relationship, expectedRelationship);
          worlds.push(world);
          return { ...response('嗯\n<<<RUANRUAN_STATE>>>{}'), threadId: 'mocked-metrics-thread' };
        }
        const context = JSON.parse(call.prompt.slice(call.prompt.indexOf('\n') + 1, call.prompt.lastIndexOf('\n'))).context;
        assert.deepEqual(context.facts.state.life.metrics, expected);
        assert.deepEqual(context.facts.state.interaction.relationship, expectedRelationship);
        assert.equal(context.metrics, undefined, 'normal review reuses the actor snapshot instead of reading it twice');
        return response('{"verdict":"pass","issues":[]}');
      });
    assert.ok(hasCharacterApproval(result));
    assert.deepEqual(other.life.snapshot(at).metrics, expected, 'life values are shared across people');
    assert.equal(other.relationshipContext('peer', at).affinity!.affection, 0, 'relationship values remain personal');
  }
  assert.equal(worlds[1].metrics.finance.cash, worlds[0].metrics.finance.cash - 23);
  assert.equal(worlds[1].metrics.energy, worlds[0].metrics.energy - 7);
  assert.equal(worlds[1].metrics.mood.value, worlds[0].metrics.mood.value + 7);
});
