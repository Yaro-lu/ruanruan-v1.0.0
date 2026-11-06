import test from 'node:test';
import assert from 'node:assert/strict';
import { controlCommand } from '../src/task-control.js';

test('explicit control commands bypass conversation without matching quoted discussion', () => {
  assert.equal(controlCommand('停止'), 'stop');
  assert.equal(controlCommand('/stop'), 'stop');
  assert.equal(controlCommand('帮我升级 Codex CLI'), 'update');
  assert.equal(controlCommand('更新cli到最新版'), 'update');
  assert.equal(controlCommand('/resume'), 'resume');
  assert.equal(controlCommand('我不想升级CLI'), undefined);
  assert.equal(controlCommand('怎么升级 CLI？'), undefined);
  assert.equal(controlCommand('不要停止任务'), undefined);
  for (const text of ['停止', '帮我升级 Codex CLI', '继续任务', '查看进度']) {
    assert.equal(controlCommand(text, false), undefined, 'character conversation must not execute natural-language shortcuts');
  }
  assert.equal(controlCommand('/stop', false), 'stop');
  assert.equal(controlCommand('/progress', false), 'progress');
  assert.equal(controlCommand('/update-cli', false), 'update');
});
