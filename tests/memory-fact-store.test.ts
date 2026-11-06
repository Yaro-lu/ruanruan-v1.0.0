import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryFactStore, type FactInput, type MemoryScope } from '../src/memory-fact-store.js';

const root = mkdtempSync(join(tmpdir(), 'ruanruan-fact-store-'));
test.after(() => rmSync(root, { recursive: true, force: true }));
const group: MemoryScope = { kind: 'group', id: 'account:group' };
const privateScope: MemoryScope = { kind: 'private', id: 'account:A' };
const t1 = '2024-01-01T00:00:00.000Z', t2 = '2025-01-01T00:00:00.000Z', t3 = '2025-02-01T00:00:00.000Z';
const input = (extra: Partial<FactInput> = {}): FactInput => ({ scope: group, subjectId: 'person:A', subjectName: '小A',
  attribute: '过敏:虾', value: '虾过敏', source: { messageId: 'm1', speakerId: 'person:A', at: t1, quote: '我对虾过敏' },
  recordedAt: t1, ...extra });

test('one fact merges evidence, replay is idempotent, subject and speaker stay separate', () => {
  const store = createMemoryFactStore(join(root, 'dedupe'));
  const first = store.upsert(input());
  assert.equal(first.action, 'created');
  assert.equal(store.upsert(input()).action, 'duplicate');
  assert.equal(store.revision(), 1);
  const second = store.upsert(input({ source: { messageId: 'm2', speakerId: 'person:C', at: t2, quote: '小A对虾过敏' } }));
  assert.equal(second.action, 'merged');
  assert.equal(second.fact?.id, first.fact?.id);
  assert.equal(second.fact?.subjectId, 'person:A');
  assert.equal(second.fact?.source.speakerId, 'person:C');
  assert.equal(second.fact?.evidenceCount, 2);
  assert.equal(store.search({ scope: group }).length, 1);
});

test('a migrated forget event never deletes freshly relearned evidence when replayed', () => {
  const store=createMemoryFactStore(join(root,'forget-event'));
  store.upsert(input());
  const forgotten={scope:group,subjectIds:['person:A'],attributes:['过敏:虾'],recordedAt:t2,eventId:'legacy-delete-1'};
  assert.equal(store.forget(forgotten).count,1);
  const fresh=store.upsert(input({source:{messageId:'fresh',at:t3,quote:'再记一下，我对虾过敏'},allowReintroduce:true})).fact!;
  const revision=store.revision();
  assert.equal(store.forget(forgotten).count,0);
  assert.equal(store.revision(),revision);
  assert.equal(store.get(fresh.id,{scope:group})?.status,'active');
  // First encounter of an old event after upgrade also leaves later evidence alone.
  assert.equal(store.forget({...forgotten,eventId:'another-old-event'}).count,0);
  assert.equal(store.get(fresh.id,{scope:group})?.status,'active');
});

test('forgetting an empty subject slot blocks delayed import but permits fresh explicit evidence', () => {
  const store=createMemoryFactStore(join(root,'empty-forget'));
  store.forget({scope:group,subjectIds:['person:A'],attributes:['过敏:虾'],recordedAt:t2,eventId:'early-forget'});
  assert.equal(store.upsert(input()).action,'suppressed');
  assert.equal(store.upsert(input({source:{messageId:'new',at:t3,quote:'现在重新记住虾过敏'},allowReintroduce:true})).action,'created');
});

test('named-subject filtering happens before limiting the candidate list', () => {
  const store=createMemoryFactStore(join(root,'subject-limit'));
  for(let i=0;i<25;i++)store.upsert(input({subjectId:`person:${i.toString().padStart(2,'0')}`,subjectName:`朋友${i}`}));
  store.upsert(input({subjectId:'person:z',subjectName:'目标同学'}));
  assert.deepEqual(store.knownSubjects({scope:group,query:'这个虾酱送目标同学好吗',limit:16}).map(row=>row.subjectId),['person:z']);
});

test('same names and unified people preserve source audience and query scope is mandatory', () => {
  const store = createMemoryFactStore(join(root, 'scope'));
  store.upsert(input({ scope: privateScope }));
  store.upsert(input({ subjectId: 'person:B', value: '虾不过敏' }));
  assert.equal(store.search({ scope: group, subjectIds: ['person:A'] }).length, 0);
  assert.equal(store.constraints({ scope: privateScope, subjectIds: ['person:A'] })[0].value, '虾过敏');
  assert.equal(store.search({ scopes: [group, privateScope] }).length, 2);
  assert.equal(store.search({ scope: group, subjectIds: [] }).length, 0);
  assert.throws(() => store.search({}), /visibility scope/);
  assert.equal(store.knownSubjects({ scope: group })[0].subjectId, 'person:B');
});

test('identical legacy IDs from different people do not suppress or revise each other', () => {
  const store = createMemoryFactStore(join(root, 'legacy-person'));
  const note = { id: 'same-legacy-id', kind: 'fact', text: '虾过敏', fact: { subject: 'user', attribute: '过敏:虾' },
    updatedAt: t2, source: { messageId: 'source-A', at: t2, quote: '我对虾过敏' } };
  store.importLegacy([note], { scope: group, subjectId: 'person:A' });
  const other = { ...note, text: '虾不过敏', updatedAt: t1, source: { messageId: 'source-B', at: t1, quote: '我对虾不过敏' } };
  assert.equal(store.importLegacy([other], { scope: group, subjectId: 'person:B' }).imported, 1);
  store.forget({ scope: group, subjectIds: ['person:A'], legacyIds: [note.id] });
  assert.equal(store.search({ scope: group })[0].subjectId, 'person:B');
});

test('location, residence, plans and hearsay coexist; explicit move keeps timed history', () => {
  const store = createMemoryFactStore(join(root, 'time'));
  const home = store.upsert(input({ attribute: '常住地', value: '上海' })).fact!;
  store.upsert(input({ attribute: '所在城市', value: '南京', source: { messageId: 'visit', at: t2, quote: '我今天在南京' }, validTo: t3 }));
  store.upsert(input({ attribute: '常住地', value: '南京', assertion: 'plan', source: { messageId: 'plan', at: t2, quote: '准备搬去南京' } }));
  assert.equal(store.search({ scope: group, includeHistory: true }).filter(row => row.attribute === '常住地' && row.assertion === 'fact')[0].value, '上海');
  assert.throws(() => store.upsert(input({ attribute: '常住地', value: '南京', assertion: 'reported', supersedes: home.id,
    source: { messageId: 'rumor', speakerId: 'person:C', at: t2, quote: '听说他搬南京了' } })), /same subject/);
  const move = input({ attribute: '常住地', value: '南京', supersedes: home.id,
    source: { messageId: 'move', at: t3, quote: '我已经搬到南京住了' } });
  const moved = store.upsert(move).fact!;
  assert.equal(store.upsert(move).action, 'duplicate');
  assert.equal(store.search({ scope: group, query: '常住地', at: t2 }).find(row => row.assertion === 'fact')?.value, '上海');
  assert.equal(store.search({ scope: group, query: '常住地' }).find(row => row.assertion === 'fact')?.value, '南京');
  const old = store.search({ scope: group, includeHistory: true }).find(row => row.id === home.id)!;
  assert.equal(old.validTo, t3); assert.equal(old.supersededBy, moved.id); assert.equal(moved.supersedes, home.id);
  assert.throws(() => store.upsert(input({ scope: privateScope, attribute: '常住地', supersedes: moved.id })), /same subject/);
});

test('stable constraints recall without a historical-keyword query and documents are not top-20 truncated', () => {
  const store = createMemoryFactStore(join(root, 'recall'));
  store.upsert(input({ topics: ['饮食'], recordedAt: t1 }));
  for (let i = 0; i < 24; i++) store.upsert(input({ attribute: `爱好:${i}`, value: `活动${i}`, stable: false,
    source: { messageId: `hobby${i}`, at: t2, quote: `活动${i}` } }));
  assert.equal(store.constraints({ scope: group, subjectIds: ['person:A'] })[0].attribute, '过敏:虾');
  assert.equal(store.search({ scope: group, query: '虾过敏' })[0].value, '虾过敏');
  assert.equal(store.search({ scope: group, topics: ['饮食'] })[0].value, '虾过敏');
  assert.equal(store.documents({ scope: group }).length, 25);
});

test('legacy import maps subjects conservatively and forget clears revisions and semantic documents', () => {
  const store = createMemoryFactStore(join(root, 'legacy'));
  const note = { id: 'allergy', kind: 'fact', text: '妹妹虾过敏', fact: { subject: '妹妹', attribute: '过敏:虾' },
    updatedAt: t1, source: { messageId: 'legacy-message', at: t1, quote: '妹妹虾过敏' } };
  const context = { scope: group, subjectId: 'person:A' };
  assert.equal(store.importLegacy([note], context).imported, 1);
  assert.equal(store.importLegacy([note], context).skipped, 1);
  store.importLegacy([note], { ...context, subjectId: 'person:B' });
  const people = store.knownSubjects({ scope: group });
  assert.equal(people.length, 2); assert.notEqual(people[0].subjectId, people[1].subjectId);
  const removed = store.forget({ scope: group, subjectIds: [people[0].subjectId], legacyIds: ['allergy'], recordedAt: t2 });
  assert.equal(removed.count, 1);
  assert.equal(store.documents({ scope: group }).length, 1);
  const scopeA = store.search({ scope: group, subjectIds: [people[0].subjectId] });
  assert.equal(scopeA.length, 0);
  const forgottenContext = { ...context, resolveSubject: () => people[0].subjectId };
  assert.equal(store.importLegacy([note], forgottenContext).suppressed, 1);
});

test('forget by source clears all revisions in this scope, delayed imports cannot revive them', () => {
  const store = createMemoryFactStore(join(root, 'forget'));
  const first = store.upsert(input()).fact!;
  const corrected = store.upsert(input({ value: '虾不过敏', supersedes: first.id,
    source: { messageId: 'correction', at: t2, quote: '是妹妹过敏 我自己不过敏' } })).fact!;
  store.upsert(input({ scope: privateScope }));
  const result = store.forget({ scope: group, sourceMessageIds: ['m1'], recordedAt: t3 });
  assert.deepEqual(new Set(result.ids), new Set([first.id, corrected.id]));
  assert.equal(store.search({ scope: group, includeHistory: true }).length, 0);
  assert.equal(store.search({ scope: privateScope }).length, 1);
  assert.equal(store.upsert(input()).action, 'suppressed');
  assert.equal(store.upsert(input({ allowReintroduce: true })).action, 'suppressed');
  const fresh = store.upsert(input({ allowReintroduce: true,
    source: { messageId: 'fresh', at: '2025-03-01T00:00:00.000Z', quote: '重新记住我对虾过敏' } }));
  assert.equal(fresh.action, 'created');
  assert.equal(store.upsert(input()).action, 'suppressed');
  assert.throws(() => store.forget({ scope: group }), /requires/);
});

test('a known future plan is visible without pretending the future activity already happened', () => {
  const store = createMemoryFactStore(join(root, 'future-plan'));
  const future = '2099-01-01T00:00:00.000Z';
  store.upsert(input({ attribute: '旅行', value: '南京', assertion: 'plan', validFrom: future }));
  store.upsert(input({ attribute: '所在城市', value: '南京', validFrom: future }));
  assert.deepEqual(store.search({ scope: group }).map(row => row.assertion), ['plan']);
});

test('legacy correction evidence becomes separate historical values and can be replayed idempotently', () => {
  const store = createMemoryFactStore(join(root, 'legacy-history'));
  const context = { scope: group, subjectId: 'person:A' };
  const note = { id: 'home', kind: 'fact', text: '搬到南京了', fact: { subject: 'user', attribute: '常住地' }, updatedAt: t3,
    source: { messageId: 'new-home', at: t3, quote: '搬到南京了' },
    priorSources: [{ messageId: 'old-home', at: t1, quote: '我住上海' }, { messageId: 'middle-home', at: t2, quote: '我搬苏州了' }] };
  assert.equal(store.importLegacy([note], context).imported, 3);
  assert.equal(store.search({ scope: group }).length, 1);
  assert.equal(store.search({ scope: group, at: t1 })[0].value, '我住上海');
  assert.equal(store.search({ scope: group, at: t2 })[0].value, '我搬苏州了');
  assert.deepEqual(store.search({ scope: group })[0].sources.map(source => source.quote), ['搬到南京了']);
  assert.equal(store.importLegacy([note], context).skipped, 3);
  assert.equal(store.search({ scope: group, includeHistory: true }).length, 3);
});
