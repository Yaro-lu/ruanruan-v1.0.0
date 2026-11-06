import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProxyAgent } from 'undici';
import { DATA_DIR } from './constants.js';
import { embeddingConfig } from './embeddings.js';
import { runCodex, type CodexRunOptions, type CodexRunResult } from './codex/bridge.js';
import {tokenUsage} from './usage.js';

export function lifeRuntime(directory = DATA_DIR) {
  let value: { backend?: string; apiModel?: string; codexModel?: string } = {};
  try { value = JSON.parse(readFileSync(join(directory, 'providers', 'heartbeat.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Invalid heartbeat configuration'); }
  if (value.backend !== undefined && !['api', 'codex'].includes(value.backend)) throw new Error('Invalid heartbeat backend');
  const provider = value.backend === 'api' ? 'api' : 'codex';
  return { provider, model: provider === 'api' ? value.apiModel ?? 'gpt-6.1-sol' : value.codexModel ?? 'gpt-6-luna',
    reasoningEffort: 'medium', serviceTier: 'default' } as const;
}

// The same life prompt and outcome validation are used on both providers.
// Routing is explicit. An API failure does not secretly spend Codex quota too.
export async function runLife(options: CodexRunOptions & { maxOutputTokens?: number }, request: typeof fetch = fetch, codex = runCodex): Promise<CodexRunResult> {
  if (options.generationProvider !== 'api') return { ...await codex(options), generationProvider: 'codex', providerModel: options.model };
  const started = Date.now(), credentials = embeddingConfig();
  if (!credentials) throw new Error('OpenAI credentials unavailable for heartbeat');
  const dispatcher = request === fetch && credentials.proxyUrl ? new ProxyAgent(credentials.proxyUrl) : undefined;
  try {
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(options.timeoutMs || 120000);
      response = await request(`${credentials.baseUrl}/responses`, {
        method: 'POST', redirect: 'error', signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
        headers: { authorization: `Bearer ${credentials.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: options.model ?? 'gpt-6.1-sol', reasoning: { effort: options.reasoningEffort ?? 'medium' },
          instructions: [options.baseInstructions, options.developerInstructions].filter(Boolean).join('\n\n'),
          input: `请用 JSON 输出。\n${options.prompt}`, text: { format: { type: 'json_object' } }, max_output_tokens: options.maxOutputTokens ?? 2048,
          service_tier: 'default', store: false }),
        ...(dispatcher ? { dispatcher } : {}),
      });
    } catch { throw new Error(options.signal?.aborted ? 'Heartbeat cancelled' : 'Heartbeat API network request failed or timed out'); }
    if (!response.ok) throw new Error(`Heartbeat API HTTP ${response.status}`);
    const body = await response.json() as any;
    const replyText = (body.output ?? []).filter((item: any) => item.type === 'message')
      .flatMap((item: any) => item.content ?? []).filter((item: any) => item.type === 'output_text')
      .map((item: any) => item.text).join('\n');
    if (body.status !== 'completed' || !replyText) throw new Error('Heartbeat API returned incomplete output');
    JSON.parse(replyText);
    return { replyText, commands: [], fileChanges: [], generationProvider: 'api', providerModel: body.model,
      ...tokenUsage(body.usage),
      ...(body.usage?{usageDetails:{source:'provider-response',scope:'provider_response',raw:[body.usage],observedCalls:1}}:{}),
      inputTokens: body.usage?.input_tokens, cachedInputTokens: body.usage?.input_tokens_details?.cached_tokens,
      outputTokens: body.usage?.output_tokens, reasoningOutputTokens: body.usage?.output_tokens_details?.reasoning_tokens,
      timing: { elapsedMs: Date.now() - started, transport: 'api' } };
  } finally { await dispatcher?.destroy(); }
}
