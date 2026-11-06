import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';
import type { EmbeddingConfig } from '../src/embeddings.js';
import type { MemoryDocument } from '../src/semantic-memory.js';

const root = mkdtempSync(join(tmpdir(), 'embedding-profiles-'));
process.env.WCB_DATA_DIR = root;
const { createEmbedder, embeddingConfig, embeddingProfile, LEGACY_EMBEDDING_PROFILE } = await import('../src/embeddings.js');
const { createSemanticMemory } = await import('../src/semantic-memory.js');
test.after(() => rmSync(root, { recursive: true, force: true }));

const legacy: EmbeddingConfig = { apiKey: 'test-only', baseUrl: 'https://api.openai.com/v1',
  model: 'text-embedding-3-small', dimensions: 1536, queryTimeoutMs: 250 };
const custom: EmbeddingConfig = { ...legacy, baseUrl: 'https://example.invalid/v1', provider: 'fixture',
  model: 'encoder-a', dimensions: 3, maxDistance: 0.01 };
const note = (id: string, text = '咖啡选拿铁'): MemoryDocument => ({ id, kind: 'fact', text, at: 1,
  sourceIds: [`in:${id}`], provenance: 'confirmed' });
const calls: { model: string; input: string[] }[] = [];
const fakeFetch: typeof fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body));
  calls.push(body);
  return new Response(JSON.stringify({ data: body.input.map((text: string, index: number) => {
    const position = /咖啡|needle/u.test(text) ? 0 : 1;
    const encoded = body.model === 'encoder-b' ? 1 - position : position;
    return { index, embedding: Array.from({ length: body.dimensions }, (_, j) => j === encoded ? 1 : 0) };
  }), usage: { total_tokens: 5 } }));
};
const originalFetch = globalThis.fetch;
test.beforeEach(() => { calls.length = 0; globalThis.fetch = fakeFetch; });
test.afterEach(() => { globalThis.fetch = originalFetch; });

test('legacy config remains valid and another compatible provider requires its actual dimension', () => {
  const directory = join(root, 'config'); mkdirSync(join(directory, 'providers'), { recursive: true });
  const path = join(directory, 'providers', 'openai-embeddings.json');
  writeFileSync(path, JSON.stringify({ apiKey: legacy.apiKey, baseUrl: legacy.baseUrl, model: legacy.model }));
  assert.equal(embeddingConfig(directory)?.dimensions, 1536);
  writeFileSync(path, JSON.stringify({ ...custom, baseUrl: `${custom.baseUrl}/`, documentPrefix: 'passage: ', queryPrefix: 'query: ', sendDimensions: false }));
  const config = embeddingConfig(directory)!;
  assert.equal(config.dimensions, 3);
  assert.equal(config.baseUrl, custom.baseUrl);
  assert.equal(config.documentPrefix, 'passage: ');
  assert.equal(config.sendDimensions, false);
  writeFileSync(path, JSON.stringify({ apiKey: 'test-only', baseUrl: custom.baseUrl, model: custom.model }));
  assert.equal(embeddingConfig(directory), undefined, 'a new model must not silently inherit 1536 dimensions');
  writeFileSync(path, JSON.stringify({ ...custom, dimensions: 3.5 }));
  assert.equal(embeddingConfig(directory), undefined);
});

test('embedding identity includes the encoder recipe but excludes credentials and request policy', () => {
  assert.equal(embeddingProfile(legacy).id, LEGACY_EMBEDDING_PROFILE.id);
  const profile = embeddingProfile(custom);
  assert.equal(embeddingProfile({ ...custom, apiKey: 'rotated', proxyUrl: 'http://proxy.invalid', queryTimeoutMs: 3000, maxDistance: 0.5 }).id, profile.id);
  for (const change of [{ provider: 'other' }, { baseUrl: 'https://another.invalid/v1' }, { model: 'encoder-b' },
    { modelRevision: 'v2' }, { dimensions: 4 }, { documentPrefix: 'passage: ' }, { queryPrefix: 'query: ' },
    { normalization: 'l2' as const }, { preprocessingVersion: 'clean-v2' }, { chunkVersion: 'chat-v3' }, { sendDimensions: false }])
    assert.notEqual(embeddingProfile({ ...custom, ...change }).id, profile.id, JSON.stringify(change));
  assert.doesNotMatch(JSON.stringify(profile), /test-only|apiKey|proxyUrl/);
});

test('compatible API adapter handles query/document instructions, optional dimensions and normalization', async () => {
  const requests: any[] = [];
  const client = createEmbedder({ ...custom, documentPrefix: 'passage: ', queryPrefix: 'query: ',
    normalization: 'l2', sendDimensions: false }, async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push(body);
    return new Response(JSON.stringify({ data: body.input.map((_text: string, index: number) => ({ index, embedding: [3, 4, 0] })).reverse() }));
  });
  try {
    assert.deepEqual((await client.embed(['one', 'two'])).vectors, [[0.6, 0.8, 0], [0.6, 0.8, 0]]);
    await client.embed(['where'], 1000, undefined, 'query');
    assert.deepEqual(requests.map(request => request.input), [['passage: one', 'passage: two'], ['query: where']]);
    assert.ok(requests.every(request => !('dimensions' in request)));
  } finally { await client.close(); }
});

test('different models at equal dimensions keep independent vectors and query caches', async () => {
  const index = createSemanticMemory(root, 'spaces');
  index.sync([note('coffee'), note('stars', '喜欢看星星')]);
  assert.equal((await index.index(custom)).indexed, 2);
  const first = await index.search('needle', { config: custom });
  assert.equal(first.status, 'hybrid'); assert.equal(first.hits[0].id, 'coffee');
  assert.equal((await index.search('needle', { config: custom })).status, 'hybrid_cached');
  const other = { ...custom, model: 'encoder-b' };
  const before = calls.length;
  assert.equal((await index.search('needle', { config: other })).status, 'lexical');
  assert.equal(calls.length, before, 'a missing space must not query the old vectors');
  assert.equal(index.stats(custom).indexed, 2, 'starting migration preserves the old space');
  assert.equal(index.stats(other).indexed, 0);
  assert.equal((await index.index(other)).indexed, 2);
  const second = await index.search('needle', { config: other });
  assert.equal(second.status, 'hybrid'); assert.equal(second.hits[0].id, 'coffee');
  assert.equal((await index.search('needle', { config: custom })).status, 'hybrid_cached');
  assert.equal(index.stats(other).documents, 2, 'one shared source document set serves both spaces');
  index.sync([note('coffee', '咖啡改为美式'), note('stars', '喜欢看星星')]);
  assert.equal(index.stats(custom).indexed, 1); assert.equal(index.stats(other).indexed, 1);
  await index.index(other);
  assert.deepEqual(calls.at(-1)?.input, ['咖啡改为美式'], 'only changed sources are embedded again');
  const larger = { ...other, dimensions: 4 };
  assert.equal((await index.index(larger)).indexed, 2);
  assert.equal((await index.search('needle', { config: larger })).hits[0].id, 'coffee');
  assert.equal(index.stats(custom).indexed, 1, 'a dimension change does not erase earlier profiles');
});

test('new profile backfill cannot restore documents deleted during its API call', async () => {
  const index = createSemanticMemory(root, 'profile-race');
  index.sync([note('a')]); await index.index(custom);
  globalThis.fetch = async (...args) => { index.sync([]); return fakeFetch(...args); };
  const other = { ...custom, model: 'encoder-b' };
  assert.equal((await index.index(other)).indexed, 0);
  assert.equal(index.stats(custom).indexed, 0);
  assert.equal(index.stats(other).documents, 0);
});

test('additive legacy migration retains old raw documents and vectors without re-embedding', async () => {
  const index = createSemanticMemory(root, 'legacy');
  const db = new DatabaseSync(index.path, { allowExtension: true });
  const doc = note('old');
  try {
    sqliteVec.load(db);
    db.exec('CREATE TABLE documents(rowid INTEGER PRIMARY KEY,id TEXT UNIQUE,hash TEXT,value TEXT); CREATE VIRTUAL TABLE vectors USING vec0(embedding float[1536] distance_metric=cosine)');
    db.prepare('INSERT INTO documents VALUES(1,?,?,?)').run(doc.id, 'original-hash', JSON.stringify(doc));
    db.prepare('INSERT INTO vectors(rowid,embedding) VALUES(?,?)').run(1n, new Float32Array([1, ...Array(1535).fill(0)]));
  } finally { db.close(); }
  assert.equal(index.stats(legacy).indexed, 1);
  assert.equal((await index.search('咖啡', { config: legacy })).hits[0].id, doc.id);
  assert.equal(calls.length, 1, 'migration calls no embedding API; only this query does');
  assert.equal((await index.index(legacy)).indexed, 0);
  const check = new DatabaseSync(index.path);
  try { assert.deepEqual(JSON.parse(String(check.prepare('SELECT value FROM documents WHERE id=?').get(doc.id)!.value)), doc); }
  finally { check.close(); }
});

test('expired documents are absent from embedding batches and all profile candidate slots', async () => {
  const index = createSemanticMemory(root, 'expiry');
  const now = Date.now(), clock = Date.now;
  index.sync([note('live'), { ...note('already-expired', 'expired-only'), expiresAt: new Date(now - 1).toISOString() },
    ...Array.from({ length: 20 }, (_, i) => ({ ...note(`future-${i}`), expiresAt: new Date(now + 1000).toISOString() }))]);
  assert.equal(index.stats(custom).documents, 21);
  await index.index(custom);
  assert.ok(!calls[0].input.some(text => text.includes('expired-only')));
  const other = { ...custom, model: 'encoder-b' };
  await index.index(other);
  Date.now = () => now + 2000;
  try {
    assert.equal((await index.index(other)).indexed, 0);
    const result = await index.search('needle', { config: other });
    assert.deepEqual(result.hits.map(doc => doc.id), ['live']);
    assert.equal(index.stats(custom).indexed, 1);
    assert.equal(index.stats(other).indexed, 1);
  } finally { Date.now = clock; }
});

test('Chinese FTS retrieves split compounds and does not parse unrelated document JSON', async () => {
  const index = createSemanticMemory(root, 'fts');
  index.sync([note('target', '我喜欢钓鲫鱼'), ...Array.from({ length: 300 }, (_, i) => note(`other-${i}`, `星际航线${i}`))]);
  const db = new DatabaseSync(index.path);
  try { db.prepare("UPDATE documents SET value='unrelated-json-is-not-read' WHERE id<>'target'").run(); }
  finally { db.close(); }
  const result = await index.search('钓鱼');
  assert.equal(result.status, 'lexical');
  assert.deepEqual(result.hits.map(doc => doc.id), ['target']);
  assert.equal(result.lexicalCandidates, 1);
  const bounded = createSemanticMemory(root, 'bounded-fts');
  bounded.sync(Array.from({ length: 300 }, (_, i) => note(`coffee-${i}`)));
  assert.equal((await bounded.search('咖啡')).lexicalCandidates, 128);
});
