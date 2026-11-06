import test from 'node:test';
import assert from 'node:assert/strict';

import { calculateTranscriptionTimeoutMs } from '../src/media/transcribe.js';

test('calculateTranscriptionTimeoutMs keeps a minimum timeout for short audio', () => {
  assert.equal(calculateTranscriptionTimeoutMs(10), 120_000);
});

test('calculateTranscriptionTimeoutMs scales up for multi-minute audio', () => {
  assert.equal(calculateTranscriptionTimeoutMs(223), 506_000);
});
