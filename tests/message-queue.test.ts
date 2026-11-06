import test from 'node:test';
import assert from 'node:assert/strict';

import { dequeueQueuedMessage, enqueueQueuedMessage, getQueuedMessageCount,
  enqueueChatMessage, messageBatchDelay, MESSAGE_BATCH_WINDOW_MS,nextChatBatchIndex,requeueSupersededBatch } from '../src/message-queue.js';

test('queued messages are returned in FIFO order', () => {
  const queues = new Map<string, string[]>();

  assert.equal(enqueueQueuedMessage(queues, 'acct-1', 'first'), 1);
  assert.equal(enqueueQueuedMessage(queues, 'acct-1', 'second'), 2);
  assert.equal(getQueuedMessageCount(queues, 'acct-1'), 2);

  assert.equal(dequeueQueuedMessage(queues, 'acct-1'), 'first');
  assert.equal(dequeueQueuedMessage(queues, 'acct-1'), 'second');
  assert.equal(dequeueQueuedMessage(queues, 'acct-1'), undefined);
  assert.equal(getQueuedMessageCount(queues, 'acct-1'), 0);
});

test('queues are isolated per account', () => {
  const queues = new Map<string, string[]>();

  enqueueQueuedMessage(queues, 'acct-1', 'first');
  enqueueQueuedMessage(queues, 'acct-2', 'other');

  assert.equal(dequeueQueuedMessage(queues, 'acct-2'), 'other');
  assert.equal(dequeueQueuedMessage(queues, 'acct-1'), 'first');
});

const chat = (userText: string, contextToken = 'first', media?: unknown) =>
  ({ userText, contextToken, fromUserId: 'owner', media, receivedAt: undefined as number | undefined });

test('adjacent burst text becomes one durable request with the latest delivery context', () => {
  const queues = new Map<string, ReturnType<typeof chat>[]>();
  enqueueChatMessage(queues, 'owner', chat('今天去了个店'), 1000);
  const secondAt = 1000 + MESSAGE_BATCH_WINDOW_MS / 2;
  enqueueChatMessage(queues, 'owner', chat('难吃得离谱', 'latest'), secondAt);
  assert.equal(getQueuedMessageCount(queues, 'owner'), 1);
  const restored = new Map<string, ReturnType<typeof chat>[]>(JSON.parse(JSON.stringify([...queues])));
  const batch = dequeueQueuedMessage(restored, 'owner')!;
  assert.equal(batch.userText, '今天去了个店\n难吃得离谱');
  assert.equal(batch.contextToken, 'latest');
  assert.equal(messageBatchDelay(batch, secondAt), MESSAGE_BATCH_WINDOW_MS);
  assert.equal(messageBatchDelay(batch, secondAt + MESSAGE_BATCH_WINDOW_MS), 0);
});

test('attachments and adjacent text become one sender batch while conversations and pauses remain separate', () => {
  const queues = new Map<string, ReturnType<typeof chat>[]>();
  enqueueChatMessage(queues, 'a', chat('文字1'), 1000);
  enqueueChatMessage(queues, 'b', chat('另一个联系人'), 1100);
  enqueueChatMessage(queues, 'a', chat('图片说明', 'ctx', { image: true }), 1200);
  enqueueChatMessage(queues, 'a', chat('文字2'), 1300);
  enqueueChatMessage(queues, 'a', chat('很久后的另一个话题'), 1300+MESSAGE_BATCH_WINDOW_MS+1);
  enqueueChatMessage(queues, 'a', { ...chat('不同发送者'), fromUserId: 'other' }, 1400+MESSAGE_BATCH_WINDOW_MS+1);
  assert.deepEqual(queues.get('a')!.map(m => m.userText), ['文字1\n图片说明\n文字2', '很久后的另一个话题', '不同发送者']);
  assert.equal(queues.get('b')!.length, 1);
  assert.equal(messageBatchDelay(queues.get('a')![0], 1300), MESSAGE_BATCH_WINDOW_MS);
  assert.deepEqual(queues.get('a')![0].media,{image:true});
});

test('interleaved group members have independent sliding silence deadlines',()=>{
  const queues=new Map<string,any[]>();
  const group=(actorId:string,text:string)=>({...chat(text),chatContext:{kind:'group' as const,conversationId:'room@chatroom',conversationName:'群',actorId,actorName:'同名昵称'}});
  enqueueChatMessage(queues,'room',group('alice','A第一句'),1000);
  enqueueChatMessage(queues,'room',group('bob','B第一句'),1500);
  enqueueChatMessage(queues,'room',group('alice','A还在说'),2500);
  const queue=queues.get('room')!;
  assert.equal(queue.length,2);
  assert.equal(queue[0].userText,'A第一句\nA还在说');
  assert.equal(nextChatBatchIndex(queue,undefined,3500),1);
  assert.equal(messageBatchDelay(queue[1],3500),0);
  assert.equal(messageBatchDelay(queue[0],3500),1000);
  enqueueChatMessage(queues,'room',group('alice','A继续'),4000);
  assert.equal(messageBatchDelay(queue[0],4000),2000);
  assert.equal(messageBatchDelay(queue[1],4000),0);
});

test('a continuous stream is not split until the sender has stopped for two seconds',()=>{
  const queues=new Map<string,ReturnType<typeof chat>[]>();
  for(let i=0;i<20;i++) {
    enqueueChatMessage(queues,'a',chat(String(i)),i*1500);
    assert.equal(queues.get('a')!.length,1);
    assert.equal(messageBatchDelay(queues.get('a')![0],i*1500+1500),500);
  }
  assert.equal(messageBatchDelay(queues.get('a')![0],19*1500+2000),0);
});

test('multiple images and their caption retain one ordered batch',()=>{
  const queues=new Map<string,ReturnType<typeof chat>[]>();
  enqueueChatMessage(queues,'a',chat('','ctx',{image:'one'}),1000);
  enqueueChatMessage(queues,'a',chat('','ctx',{image:'two'}),2000);
  enqueueChatMessage(queues,'a',chat('你看看这是谁'),3000);
  assert.equal(queues.get('a')!.length,1);
  assert.deepEqual(queues.get('a')![0].media,[{image:'one'},{image:'two'}]);
  assert.equal(messageBatchDelay(queues.get('a')![0],4999),1);
  assert.equal(messageBatchDelay(queues.get('a')![0],5000),0);
});

test('legacy queued records stay immediately runnable and empty tokens do not discard a usable context', () => {
  const queues = new Map([['a', [chat('旧版落盘消息')]]]);
  assert.equal(messageBatchDelay(queues.get('a')![0], 1), 0);
  enqueueChatMessage(queues, 'a', chat('新消息'), 1000);
  enqueueChatMessage(queues, 'a', chat('后半句', ''), 1100);
  assert.equal(queues.get('a')!.length, 2);
  assert.equal(queues.get('a')![1].contextToken, 'first');
});

test('a superseded image draft rejoins the same speaker’s complete batch without delaying others', () => {
  const context={kind:'group' as const,conversationId:'room',conversationName:'群',actorId:'alice',actorName:'同名',participation:'direct' as const};
  const original:any={...chat('看这张图','desktop:1',{image:'original'}),chatContext:context,messageIds:['in:1'],profileHint:'companion'};
  const accepted={...original,userText:'补一句',media:undefined,messageIds:['in:2']};
  const bob={...original,userText:'别人的问题',chatContext:{...context,actorId:'bob'},messageIds:['in:3'],receivedAt:1200};
  const next={...original,userText:'我还没说完',media:{image:'next'},messageIds:['in:4'],receivedAt:1800,
    contextToken:'desktop:4',offeredTo:'old-job',chatContext:{...context,participation:'ambient'}};
  const queue=[bob,next];
  assert.equal(requeueSupersededBatch(queue,original,[accepted]),true);
  assert.equal(queue[0],bob);
  assert.equal(queue[1].userText,'看这张图\n补一句\n我还没说完');
  assert.deepEqual(queue[1].messageIds,['in:1','in:2','in:4']);
  assert.deepEqual(queue[1].media,[{image:'original'},{image:'next'}]);
  assert.equal(queue[1].contextToken,'desktop:4');
  assert.equal(queue[1].offeredTo,undefined);
  assert.equal(queue[1].chatContext.participation,'direct');
  assert.equal(messageBatchDelay(queue[1],2000),1800);
  assert.equal(messageBatchDelay(queue[0],2000),1200);
});
