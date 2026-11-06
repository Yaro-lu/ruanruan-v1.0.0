import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversationMessage } from '../src/conversation.js';
const root = mkdtempSync(join(tmpdir(), 'sharing-choice-'));
process.env.WCB_DATA_DIR = root;
const { createMemoryStore } = await import('../src/memory.js');
test.after(() => rmSync(root, { recursive: true, force: true }));
const at = Date.now();
function save(memory: ReturnType<typeof createMemoryStore>, kind: 'choice' | 'boundary' | undefined,
  sharing: 'declined' | 'open', text: string, stamp = at) {
  const user = '好，你自己决定。';
  const rows: ConversationMessage[] = [
    { id: `in:${stamp}`, seq: 1, at: stamp, direction: 'in', text: user, payload: {}, profile: 'companion' },
    { id: `out:${stamp}`, seq: 2, at: stamp + 1, direction: 'out', text, payload: {}, profile: 'companion' },
  ];
  return memory.character.commit({ stance: { kind, topic: '照片分享', scope: 'topic', sharing,
    meaning: text, userQuote: user, replyQuote: text } }, rows, memory);
}

test('a temporary refusal remains in history without being pinned as current policy, including legacy records', () => {
  const memory = createMemoryStore('choice');
  assert.equal(save(memory, undefined, 'declined', '这次不想发。').stances, 1);
  const context = memory.character.context([], at + 1000);
  assert.deepEqual(context, {boundaries: []});
  assert.equal(memory.character.snapshot([], at + 1000)[0].kind, 'choice');
  assert.equal(memory.character.snapshot([], at + 8 * 86400000).length, 0);
});

test('a later voluntary choice replaces the old choice without fabricating a relationship event', () => {
  const memory = createMemoryStore('changed-mind');
  save(memory, 'choice', 'declined', '这次不想发。');
  save(memory, 'choice', 'open', '现在又想给你看看了。', at + 1000);
  const context = memory.character.context([], at + 2000);
  const history=memory.character.snapshot([], at + 2000);
  assert.equal(history.length, 1); assert.equal(history[0].sharing, 'open');
  assert.deepEqual(context, {boundaries: []});
  assert.equal(context.boundaries.length, 0); assert.equal(memory.relationship.snapshot().axes.openness.boundaries.length, 0);
});

test('standing boundaries outlive the history window; a one-off choice does not revoke them', () => {
  const memory = createMemoryStore('boundary');
  save(memory, 'boundary', 'declined', '以后不发这种私人照片。');
  save(memory, 'choice', 'open', '这张普通日常照可以。', at + 1000);
  assert.equal(memory.character.context([], at + 8 * 86400000).boundaries.length, 1);
  save(memory, 'boundary', 'open', '这个限制我自己决定取消了。', at + 8 * 86400000);
  assert.equal(memory.character.context([], at + 8 * 86400000 + 1000).boundaries.length, 0);
});
