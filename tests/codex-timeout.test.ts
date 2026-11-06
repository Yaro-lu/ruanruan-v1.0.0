import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodex } from '../src/codex/bridge.js';

test('timeout remains an error even after an intermediate reply; completed runs succeed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wcb-timeout-'));
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${dir}:${originalPath}`;
    const output = JSON.stringify({ type: 'thread.started', thread_id: 'retained-thread' }) + '\n'
      + JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Still working' } }) + '\n';
    writeFileSync(join(dir, 'codex'), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output)});\nif (process.argv.at(-1) === 'hang') setInterval(() => {}, 1000);\n`, { mode: 0o700 });
    const result = await runCodex({ cwd: dir, prompt: 'hang', mode: 'plan', timeoutMs: 1000 });
    assert.equal(result.error, 'Codex timed out after 1000ms');
    assert.equal(result.threadId, 'retained-thread');
    assert.equal(result.replyText, 'Still working');
    const completed = await runCodex({ cwd: dir, prompt: 'finish', mode: 'plan', timeoutMs: 1000 });
    assert.equal(completed.error, undefined);
    assert.equal(completed.replyText, 'Still working');
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
