import test from 'node:test';
import assert from 'node:assert/strict';
import { splitMessage } from '../src/utils/chunk.js';

test('splitMessage keeps short text intact', () => {
  assert.deepEqual(splitMessage('hello', 10), ['hello']);
});

test('splitMessage breaks long text into multiple chunks', () => {
  const result = splitMessage('a'.repeat(12), 5);
  assert.deepEqual(result, ['aaaaa', 'aaaaa', 'aa']);
});
