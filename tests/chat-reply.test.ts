import test from 'node:test';
import assert from 'node:assert/strict';
import { planChatReply } from '../src/utils/chat-reply.js';
import { CHAT_BREAK } from '../src/persona.js';
import { buildCodexArgs } from '../src/codex/bridge.js';

test('ordinary paragraphs stay in one message', () => {
  assert.deepEqual(planChatReply('一句话\n\n第二段', true), { messages: ['一句话\n\n第二段'], burst: false });
});
test('explicit short message breaks become at most four messages without losing content', () => {
  const r=planChatReply(['一','二','三','四','五'].join(`\n${CHAT_BREAK}\n`), true);
  assert.deepEqual(r, {messages:['一','二','三','四\n\n五'],burst:true});
});
test('cooldown folds message breaks into a single reply', () => {
  assert.deepEqual(planChatReply(`一\n${CHAT_BREAK}\n二`,false),{messages:['一\n\n二'],burst:false});
});
test('a delimiter in fenced code is preserved literally', () => {
  const text='```text\n'+CHAT_BREAK+'\n```';
  assert.deepEqual(planChatReply(text,true),{messages:[text],burst:false});
});
test('persona reaches new and resumed Codex as one quoted configuration value', () => {
  const persona='叫“阮阮”\n含 "引号" 和反斜线 \\';
  for(const threadId of [undefined,'test-thread']) {
    const args=buildCodexArgs({cwd:'/tmp',mode:'plan',prompt:'你好',threadId,developerInstructions:persona});
    const setting=args.find(x=>x.startsWith('developer_instructions='));
    assert.equal(JSON.parse(setting!.slice('developer_instructions='.length)),persona);
  }
});

test('old sessions receive the updated persona in the resumed input, not just CLI config', () => {
  const args=buildCodexArgs({cwd:'/tmp',mode:'plan',prompt:'你叫什么名字？',threadId:'old-thread',developerInstructions:'你叫阮阮。'});
  assert.match(args.at(-1)!, /你叫阮阮/);
  assert.ok(args.at(-1)!.endsWith('你叫什么名字？'));
  assert.equal(args.at(-2),'old-thread');
});
