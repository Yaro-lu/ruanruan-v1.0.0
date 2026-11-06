import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'chat-batching-'));
process.env.WCB_DATA_DIR = root;
const { createJob, writeStatus } = await import('../src/jobs.js');
const { handleMessage, watchJob } = await import('../src/main.js');
test.after(() => rmSync(root, { recursive: true, force: true }));

for (const scenario of ['alice', 'bob', 'superseded']) {
  const actorId = scenario === 'superseded' ? 'alice' : scenario;
  test(`late input handling: ${scenario}`, async () => {
    const account: any = { accountId: `batch-${scenario}`, userId: 'room', transport: 'qq' };
    const context: any = { kind: 'group', conversationId: 'room', conversationName: '群', actorId: 'alice', actorName: '同名' };
    // Pause job launching in this offline fixture; incoming messages and final
    // delivery still pass through the real dispatcher and completion watcher.
    const session: any = { state: 'processing', threadId:`existing-${scenario}`, workingDirectory: root, chatMode: 'companion', queuePaused: true, chatContext: context,
      pendingRequest: {userText:'今天好烦',fromUserId:'room',contextToken:'ctx',chatContext:context,media:{kind:'image',localPath:'/offline/original.png'},messageIds:['in:original']} };
    const job = createJob({ accountId: account.accountId, kind: 'codex', userText: '今天好烦', fromUserId: 'room', contextToken: 'ctx',
      options: { profile: 'companion', cwd: root, mode: 'plan', prompt: '今天好烦',
        conversation:{accountId:account.accountId,peerId:'room',messageIds:['in:original']} }, session: { ...session }, tempFiles: [] });
    session.activeJobId = job.id;
    const messages: string[] = [];
    const sender: any = { inThread: (_: unknown, action: () => Promise<unknown>) => action(),
      sendText: async (_peer: string, _context: string, text: string) => { messages.push(text); },
      startTyping: () => ({ stop: async () => {} }) };
    const store: any = { save() {} };
    writeStatus(job.id, { state: 'running', phase: 'generating', updatedAt: Date.now() });
    for (const [index, text] of ['还没说完', '其实是我自己的问题', '听我讲完再说'].entries()) {
      await handleMessage({ message_type: 1, message_id: `${actorId}-${index}`, from_user_id: 'room', context_token: 'new',
        chatContext: { ...context, actorId }, item_list: [{ type: 1, text_item: { text } }] } as any,
      account, session, store, sender, { workingDirectory: root });
    }
    const replyText = '今天上班怎么啦';
    writeStatus(job.id, { state: 'completed', phase: 'done', updatedAt: Date.now(), result: { replyText, commands: [], fileChanges: [],
      superseded: scenario === 'superseded',
      characterReview: scenario === 'superseded' ? undefined : { status: 'approved', checks: 1, elapsedMs: 0, issues: [], model: 'offline-fixture', inputTokens: 0, outputTokens: 0,
        approvedReplyHash: createHash('sha256').update(replyText).digest('hex') } } });
    await watchJob(job.id, account, session, store, sender, { workingDirectory: root });
    assert.deepEqual(messages, actorId === 'alice' ? [] : [replyText]);
    if(scenario==='superseded')assert.equal(session.rotateBeforeNext,true);
    else if(actorId==='alice') {
      assert.notEqual(session.rotateBeforeNext,true);assert.equal(session.threadId,`existing-${scenario}`);
      assert.equal(session.threadFeedback.delivery.status,'incomplete');
    }
    const queue = new Map<string, any[]>(JSON.parse(readFileSync(join(root, 'message-queue.json'), 'utf8')));
    assert.equal(queue.get(account.accountId)!.length, 1);
    assert.equal(queue.get(account.accountId)![0].userText, (scenario === 'superseded' ? '今天好烦\n' : '') + '还没说完\n其实是我自己的问题\n听我讲完再说');
    if (scenario === 'superseded') assert.equal(queue.get(account.accountId)![0].media.localPath,'/offline/original.png');
    assert.equal(queue.get(account.accountId)![0].chatContext.actorId, actorId);
  });
}
