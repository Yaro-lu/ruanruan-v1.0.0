import test from 'node:test';
import assert from 'node:assert/strict';
import { searchFishingKnowledge, FISHING_KNOWLEDGE_SOURCE } from '../src/fishing-knowledge.js';

test('focused fish and bait questions retrieve relevant entries with pinned provenance', () => {
  const fish = searchFishingKnowledge({ query: '昂刺鱼晚上用什么饵', limit: 1 });
  assert.match(fish.excerpts[0].title, /黄颡鱼/);
  assert.match(fish.excerpts[0].text, /蚯蚓/);
  assert.ok(fish.excerpts[0].sourceUrl.includes(FISHING_KNOWLEDGE_SOURCE.revision));
  assert.match(fish.excerpts[0].sourceUrl, /#L\d+$/);
  const bait = searchFishingKnowledge({ query: '老三样配方比例', limit: 1 });
  assert.match(bait.excerpts[0].title, /野钓综合饵/);
  assert.match(bait.excerpts[0].text, /野战蓝鲫 50%/);
});

test('retrieval splits individual lures and keeps terminology available without loading every file', () => {
  const lure = searchFishingKnowledge({ query: 'VIB怎么收线', limit: 1 });
  assert.match(lure.excerpts[0].title, /VIB/);
  assert.match(lure.excerpts[0].text, /匀速.*跳底/);
  assert.doesNotMatch(lure.excerpts[0].text, /蛙形 Frog|米诺 Minnow/);
  const terms = searchFishingKnowledge({ query: '炒粉是什么意思', limit: 1 });
  assert.equal(terms.excerpts[0].topic, 'terms');
  assert.match(terms.excerpts[0].text, /水滴轮炸线/);
});

test('quarantined species, legal claims and absolute fish guarantees are never returned', () => {
  for (const query of ['罗非鱼', '鲶鱼', '泥鳅', '黑鱼草区', '连续阴天', '大雨过后', '红虫', '气压骤降']) {
    const result = searchFishingKnowledge({ query, limit: 5, maxChars: 8000 });
    for (const excerpt of result.excerpts) {
      assert.doesNotMatch(excerpt.text, /Oreochromis mossambicus|Silurus asotus|泥鳅|score:|必在附近|必有亲鱼|全天都有口|疯狂进食|什么鱼都吃|效果远超/);
      assert.ok(!(excerpt.topic === 'species' && /· (罗非鱼|鲶鱼)$/.test(excerpt.title)));
    }
    assert.equal(result.referenceOnly, true);
  }
});

test('unknown queries return no invented spots and character budget preserves complete entries', () => {
  assert.deepEqual(searchFishingKnowledge({ query: '给我写季度工作总结' }).excerpts, []);
  assert.deepEqual(searchFishingKnowledge({ query: '' }).excerpts, []);
  assert.deepEqual(searchFishingKnowledge({ query: '翘嘴', maxChars: 0 }).excerpts, []);
  const result = searchFishingKnowledge({ query: '鲫鱼冬季饵料配方水草', maxChars: 600, limit: 3 });
  assert.ok(result.excerpts.length > 0 && result.excerpts.length <= 3);
  assert.ok(result.excerpts.reduce((sum, item) => sum + item.text.length, 0) <= 600);
  assert.ok(result.moreAvailable);
  assert.match(result.guidance, /不是实时天气/);
});
