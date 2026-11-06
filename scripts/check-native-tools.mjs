// Evaluation threads live only in the runtime; reports remain in acceptance/.
process.env.WCB_CODEX_EPHEMERAL = '1';
// Exercise the installed official Codex and our relay against a local fake
// Responses endpoint. No subscription login, remote model, or WeChat sends.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';

const root = mkdtempSync(join(tmpdir(), 'wcb-native-protocol-'));
process.env.WCB_DATA_DIR = root;
process.env.WCB_MEDIA_ROOT = root;
const build = process.env.WCB_BUILD_DIR || '../dist';
const { createConversationStore } = await import(`${build}/src/conversation.js`);
const { runAppServerCodex } = await import(`${build}/src/codex/app-server.js`);
const { COMPANION_BASE, COMPANION_CONFIG } = await import(`${build}/src/companion-profile.js`);
const { loadPersonaSnapshot } = await import(`${build}/src/persona.js`);
const { assembleEntryPrompt } = await import(`${build}/src/prompt.js`);
const persona = loadPersonaSnapshot(true, resolve('personas/ruanruan'));
const entry = assembleEntryPrompt(persona, { kind: 'default', reason: 'test', options: {} }, [], true, 'companion');
const journal = createConversationStore('test-bot', 'owner');
journal.record('out', { client_id: 'news', item_list: [{ type: 1, text_item: { text: '城市数字化标准体系文件发布' } }] });
mkdirSync(join(root, '图片'));
writeFileSync(join(root, '图片', 'scene.jpg'), 'synthetic');
writeFileSync(join(root, '素材索引.json'), JSON.stringify({ media_assets: [
  { asset_id: 'rr_image_0001', kind: 'image', character_id: 'ruanruan_v1', title: '学院风', file: '图片/scene.jpg', tags: ['学院风'] }] }));
let calls = 0;
const requests = [];
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  if (!req.url.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
  const input = JSON.parse(body); requests.push(input); const call = ++calls;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const event = (type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
  const id = `response-${call}`;
  event('response.created', { response: { id, status: 'in_progress', output: [] } });
  let item;
  if (call <= 2) {
    item = { type: 'function_call', id: `fc-${call}`, call_id: `call-${call}`,
      name: call === 1 ? 'memory_recall' : 'character_scene',
      arguments: JSON.stringify({ query: call === 1 ? '城市数字化' : '学院风' }), status: 'completed' };
    event('response.output_item.added', { output_index: 0, item: { ...item, arguments: '' } });
    event('response.function_call_arguments.delta', { output_index: 0, item_id: item.id, delta: item.arguments });
  } else {
    if (call >= 4) await new Promise(resolve => setTimeout(resolve, 600));
    const text = call === 3 ? '就是刚发的那条标准体系新闻。给你看这张。\n[[ASSET:rr_image_0001]]'
      : JSON.stringify(input.input).includes('我说的是明天') ? '收到补充：明天再聊' : '尚未收到补充的草稿';
    item = { type: 'message', id: `msg-${call}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    event('response.output_item.added', { output_index: 0, item: { ...item, content: [] } });
    event('response.content_part.added', { output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    event('response.output_text.delta', { output_index: 0, item_id: item.id, content_index: 0, delta: text });
  }
  event('response.output_item.done', { output_index: 0, item });
  event('response.completed', { response: { id, status: 'completed', output: [item],
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 0 } } } });
  res.end();
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const port = server.address().port;
mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'codex-home'));
writeFileSync(join(root, 'AGENTS.md'), 'POISON_PROJECT_INSTRUCTIONS');
writeFileSync(join(root, 'codex-home', 'config.toml'), 'developer_instructions = "POISON_GLOBAL_DEVELOPER"\n');
// Use the installed model's capability metadata, including its advertised
// speed tier, rather than an unknown model's permissive fallback metadata.
const cache = JSON.parse(readFileSync(join(homedir(), '.codex', 'models_cache.json'), 'utf8'));
const metadata = cache.models.find(model => model.slug === 'gpt-6.1-terra');
assert.ok(metadata, 'Installed Terra model metadata is required for this protocol check');
const catalog = join(root, 'models.json');
writeFileSync(catalog, JSON.stringify({ models: [metadata] }));
mkdirSync(join(root, 'codex-home', 'skills', 'irrelevant'), { recursive: true });
writeFileSync(join(root, 'codex-home', 'skills', 'irrelevant', 'SKILL.md'), '---\nname: irrelevant\ndescription: POISON_SKILL_CATALOG\n---\nUnrelated development work.\n');
const executable = execFileSync('which', ['codex'], { encoding: 'utf8' }).trim();
const provider = `model_providers.local={name="local",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",requires_openai_auth=false}`;
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
writeFileSync(join(root, 'bin', 'codex'), `#!/bin/sh\nexec ${quote(executable)} "$@" -c 'model_provider="local"' -c ${quote(provider)} -c ${quote(`model_catalog_json=${JSON.stringify(catalog)}`)}\n`, { mode: 0o700 });
let stderr = '';
const child = spawn(process.execPath, [resolve('scripts/codex-runtime.mjs')], {
  env: { ...process.env, CODEX_HOME: join(root, 'codex-home'), PATH: `${join(root, 'bin')}:${process.env.PATH}` },
  stdio: ['ignore', 'ignore', 'pipe'],
});
child.stderr.on('data', chunk => { stderr += chunk; });
try {
  for (let n = 0; n < 100 && !existsSync(join(root, 'codex-runtime.sock')); n++) await new Promise(r => setTimeout(r, 100));
  assert.ok(existsSync(join(root, 'codex-runtime.sock')), stderr.slice(-1200));
  const result = await runAppServerCodex({ prompt: '解释刚发的新闻，并挑一张学院风素材', model: 'gpt-6.1-terra',
    profile: 'companion', baseInstructions: COMPANION_BASE, threadConfig: COMPANION_CONFIG, serviceTier: 'fast', ...entry,
    cwd: root, mode: 'plan', reasoningEffort: 'medium', timeoutMs: 25000,
    conversation: { accountId: 'test-bot', peerId: 'owner' } }, join(root, 'codex-runtime.sock'));
  assert.equal(result.error, undefined, stderr.slice(-1500));
  assert.equal(calls, 3);
  assert.match(JSON.stringify(requests[1]), /城市数字化标准体系文件发布/);
  assert.match(JSON.stringify(requests[2]), /rr_image_0001/);
  assert.match(JSON.stringify(requests[2]), /ruanruan_v1/);
  assert.equal(result.mediaCandidates[0].asset_id, 'rr_image_0001');
  assert.match(result.replyText, /标准体系新闻/);
  const first = requests[0];
  const instructionText = JSON.stringify({ instructions: first.instructions, input: first.input });
  assert.ok(instructionText.includes('你在微信中扮演阮阮'));
  assert.ok(!instructionText.includes('You are Codex'), 'generic Codex base instructions leaked');
  assert.doesNotMatch(instructionText, /POISON_|WCB_MEMORY_V1/);
  const advertisedTools = JSON.stringify({ tools: first.tools, input: first.input });
  assert.doesNotMatch(advertisedTools, /"name":"(?:exec_command|shell_command|spawn_agent|apply_patch)"/);
  assert.match(advertisedTools, /memory_recall/);
  assert.match(advertisedTools, /memory_update/);
  assert.equal(first.service_tier, 'priority', 'Fast must reach the model request as its advertised tier id');
  console.log(JSON.stringify({ instructionChars: instructionText.length, serviceTier: first.service_tier,
    reasoning: first.reasoning, tools: first.tools?.map(t => t.name || t.type) }));
  let offered = false;
  const steered = await runAppServerCodex({ prompt: '晚上聊', model: 'gpt-6.1-terra', cwd: root, mode: 'plan',
    profile: 'companion', baseInstructions: COMPANION_BASE, developerInstructions: entry.developerInstructions,
    threadConfig: COMPANION_CONFIG, timeoutMs: 20000,
    nextInput: () => { if (offered) return; offered = true; return { text: '我说的是明天', ids: ['in:steer'] }; },
  }, join(root, 'codex-runtime.sock'));
  assert.equal(steered.error, undefined);
  assert.deepEqual(steered.acceptedInputIds, ['in:steer']);
  assert.equal(steered.replyText, '收到补充：明天再聊');
  console.log(JSON.stringify({ officialCodex: true, localModelRequests: calls, subscriptionCalls: 0,
    dynamicRecall: 'passed', dynamicScene: 'passed', steer: 'passed', relay: 'passed', result: 'passed' }));
} finally {
  child.kill('SIGTERM'); await once(child, 'exit').catch(() => {});
  server.closeAllConnections(); server.close();
  rmSync(root, { recursive: true, force: true });
}
