import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const root = mkdtempSync(join(tmpdir(), 'ruanruan-atomic-regression-'));
process.env.WCB_DATA_DIR = root;
const { createMemoryStore } = await import('../src/memory.js');
const { createWechatTools } = await import('../src/wechat-tools.js');
const { createConversationStore } = await import('../src/conversation.js');
const { commitConsolidation } = await import('../src/consolidation.js');
const { factId } = await import('../src/memory-facts.js');
const { deliveredSceneContext } = await import('../src/media-context.js');
test.after(() => rmSync(root, { recursive: true, force: true }));
const scope = (subject: string, attribute: string, evidence: string) => ({ subject, attribute, evidence });

test('forgetting a relative preserves name, diet and corrected user facts across store and thread replacement', async () => {
  const account = 'selective', peer = 'owner', memory = createMemoryStore(account), journal = createConversationStore(account, peer);
  async function update(text: string, args: any) {
    const id = journal.record('in', { message_id: randomUUID(), item_list: [{ type: 1, text_item: { text } }] }, Date.now(), undefined, 'companion');
    const host = createWechatTools(account, peer, { currentUser: text, messageIds: [id] });
    return host.call('memory_update', { ...args, instruction: text }) as Promise<any>;
  }
  const first = await update('叫我阿川，记住我不吃香菜，花生过敏。', { operation: 'remember', facts: [
    scope('user', '称呼', '叫我阿川'), scope('user', '忌口:香菜', '我不吃香菜'), scope('user', '过敏:花生', '花生过敏')] });
  assert.equal(first.saved, true); assert.equal(memory.load().notes.length, 3);
  const allergy = memory.load().notes.find(note => note.fact?.attribute === '过敏:花生')!;
  await update('纠正一下，是我妹妹花生过敏，我自己不过敏。', { operation: 'remember', facts: [
    { ...scope('user', '过敏:花生', '我自己不过敏'), id: allergy.id }, scope('妹妹', '过敏:花生', '妹妹花生过敏')] });
  const sister = memory.load().notes.find(note => note.fact?.subject === '妹妹')!;
  const forgotten = await update('只忘掉妹妹的过敏，其他别动。', { operation: 'forget', id: sister.id });
  assert.equal(forgotten.removed, true);
  const restored = createMemoryStore(account);
  assert.equal(restored.load().notes.length, 3);
  assert.match(JSON.stringify(restored.recall('阿川香菜')), /阿川|香菜/);
  const recall: any = await createWechatTools(account, peer).call('memory_recall', { query: '妹妹花生香菜阿川' });
  assert.doesNotMatch(JSON.stringify(recall), /妹妹花生过敏/);
  assert.match(journal.prepare(undefined, [], 0, restored.load().forgotten).text, /阿川|香菜/);
  assert.doesNotMatch(journal.prepare(undefined, [], 0, restored.load().forgotten).text, /妹妹花生过敏/);
  assert.match(JSON.stringify(restored.recall('花生')), /我自己不过敏/);
  await update('忘掉我的称呼，其他保留。', { operation: 'forget', id: first.notes[0].id });
  assert.equal(restored.recall('阿川').length, 0);
  await update('我叫阿川，重新记住我的称呼。', { operation: 'remember', facts: [scope('user', '称呼', '我叫阿川')] });
  assert.match(JSON.stringify(createMemoryStore(account).recall('阿川')), /我叫阿川/);
  assert.ok(restored.load().forgotten?.some(old => old.fact?.subject === '妹妹'));
  assert.ok(!restored.load().forgotten?.some(old => old.fact?.attribute === '称呼'));
});

test('legacy compound facts must be split with real citations before selective deletion', async () => {
  const memory = createMemoryStore('legacy');
  memory.remember('old', '叫我阿川，不吃香菜，妹妹花生过敏', 'old-source');
  memory.recallFacts('妹妹'); // Simulate a compound fact already projected into the central store.
  const host = createWechatTools('legacy', 'owner', { currentUser: '忘掉妹妹的过敏，其他保留。' });
  const args = { operation: 'forget', instruction: '忘掉妹妹的过敏，其他保留。', id: 'old' };
  const response: any = await host.call('memory_update', args);
  assert.equal(response.status, 'split_required'); assert.equal(response.removed, false);
  await assert.rejects(host.call('memory_update', { ...args, operation: 'split', facts: [scope('user', '称呼', '小王')] }));
  const split: any = await host.call('memory_update', { ...args, operation: 'split', facts: [
    scope('user', '称呼', '叫我阿川'), scope('user', '忌口:香菜', '不吃香菜'), scope('妹妹', '过敏:花生', '妹妹花生过敏')] });
  assert.equal(split.saved, true);
  const id = split.notes.find((note: any) => note.fact.subject === '妹妹').id;
  await host.call('memory_update', { ...args, id });
  assert.equal(memory.load().notes.length, 2);
  assert.match(JSON.stringify(memory.load().notes), /阿川/);
  assert.match(JSON.stringify(memory.load().notes), /香菜/);
  assert.doesNotMatch(JSON.stringify(memory.recall('花生')), /妹妹花生过敏/);
  assert.ok(!memory.factContext.store.search({scope:memory.factContext.scope}).some(row=>row.attribute==='legacy:old'));
});

test('old receipts cannot revive a forgotten fact and one explicit relearning cannot revive a different subject', () => {
  const memory = createMemoryStore('relearn');
  const source = { id: 'one', seq: 1, at: Date.now() - 10000, direction: 'in' as const, text: '叫我阿川，妹妹花生过敏', payload: {} };
  const notes = memory.rememberFacts([scope('user', '称呼', '叫我阿川'), scope('妹妹', '过敏:花生', '妹妹花生过敏')], [source]);
  for (const note of notes) memory.forget(note.id);
  assert.throws(() => memory.rememberFacts([scope('妹妹', '过敏:花生', '妹妹花生过敏')], [source], false), /尚未保存/);
  memory.rememberFacts([scope('user', '称呼', '叫我阿川')], [{ ...source, at: Date.now() }]);
  assert.equal(memory.load().notes.length, 1);
  assert.ok(memory.load().forgotten?.some(old => old.fact?.subject === '妹妹'));
});

test('a conflict residue preserves its intensity without resurfacing a forgotten fact in the cause', () => {
  const memory=createMemoryStore('forgotten-conflict'),now=Date.now(),quote='我的具体住址是秘密街道37号';
  memory.remember('private-address',quote,'address-source',now);
  memory.socialObserve('owner','pressure',quote,{intent:'conflict',effect:'harassment',mode:'reply',userQuote:quote},now);
  assert.match(JSON.stringify(memory.relationshipContext('owner',now)),/秘密街道37号/);
  memory.forget('private-address');
  const context=memory.relationshipContext('owner',now);
  assert.doesNotMatch(JSON.stringify(context),/秘密街道37号/);
  assert.ok(context.affinity!.conflict!.intensity>0);
});

test('background consolidation commits valid facts without becoming a second relationship writer', () => {
  const account = 'partial', memory = createMemoryStore(account), now = Date.now();
  const messages = [
    { seq: 1, id: 'bot', at: now, direction: 'out' as const, profile: 'companion' as const, text: '门牌我暂时不说啦', payload: {} },
    { seq: 2, id: 'user', at: now + 1, direction: 'in' as const, profile: 'companion' as const, text: '好，不问。记住我不吃香菜', payload: {} }];
  const outcome = commitConsolidation(account, { after: 0, through: 2, messages }, { commands: [], fileChanges: [], replyText: JSON.stringify({
    upsert: [{ kind: 'fact', fact: { subject: 'user', attribute: '忌口:香菜' }, evidence: '我不吃香菜', messageId: 'user' }],
    state: [{ key: 'activity', text: '在公园', evidence: '我在公园', messageId: 'user', validForMinutes: 10 }],
    relationship: [{ axis: 'trust', topic: '住址', effect: 'supported', meaning: '不再追问门牌', messageId: 'bot', evidence: '门牌我暂时不说啦',
      responseId: 'user', responseEvidence: '好，不问。' }] }) });
  assert.equal(outcome.saved, 1); assert.equal(outcome.rejected.length, 1);
  assert.equal(memory.load().notes[0].id, factId({ subject: 'user', attribute: '忌口:香菜' }));
  assert.equal(memory.relationship.snapshot().axes.trust.experiences.length, 0);
  assert.equal(memory.continuity.meta().through, 2);
  assert.equal(memory.continuity.snapshot().active.length, 0);
  assert.match(readFileSync(join(memory.dir, 'consolidation-rejected.jsonl'), 'utf8'), /state/);
});

test('accepted scene context distinguishes latest image, latest video and a turn with no new media', () => {
  const journal = createConversationStore('media', 'owner');
  const record = (id: string, direction: 'in' | 'out', text: string, extra = {}) => journal.record(direction,
    { message_id: id, client_id: id, item_list: [{ type: 1, text_item: { text } }], ...extra }, Date.now(), undefined, 'companion');
  record('image1', 'out', '', { local_media: { asset_id: 'rr_image_0001', kind: 'image', caption: '之前在外面拍的' } });
  record('image2', 'out', '', { local_media: { asset_id: 'rr_image_0002', kind: 'image', caption: '这张是在厨房拿着厨具玩' } });
  record('detail', 'out', '就是拿着玩，饭还没做');
  record('video', 'out', '', { local_media: { asset_id: 'rr_video_0001', kind: 'video' } });
  record('request', 'in', '看看你现在的事'); record('no-photo', 'out', '没有合适的理货照片');
  const current = record('followup', 'in', '刚才照片是哪儿');
  const scene = deliveredSceneContext(journal.recentMedia(), journal.recent(), [current]);
  assert.equal(scene.latestImageId, 'rr_image_0002'); assert.equal(scene.latestVideoId, 'rr_video_0001');
  assert.equal(scene.mediaSentSincePreviousInput, false);
  assert.equal(scene.moments[1].established[0].text, '就是拿着玩，饭还没做');
});
