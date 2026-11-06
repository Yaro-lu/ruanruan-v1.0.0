import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ProxyAgent, type Dispatcher } from 'undici';
import { DATA_DIR } from './constants.js';

export interface EmbeddingConfig {
  // Providers use the OpenAI-compatible /embeddings wire format. Model names
  // and vector spaces are independent of the chat completion provider.
  apiKey: string; baseUrl: string; model: string; dimensions: number;
  queryTimeoutMs: number; proxyUrl?: string;
  provider?: string; modelRevision?: string;
  documentPrefix?: string; queryPrefix?: string;
  normalization?: 'none' | 'l2'; preprocessingVersion?: string; chunkVersion?: string;
  sendDimensions?: boolean; maxDistance?: number;
}
const defaults = { baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small', dimensions: 1536 };

function normalizedBaseUrl(value: string) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Invalid embedding endpoint');
  return url.toString().replace(/\/+$/u, '');
}

// Persist the entire encoder recipe, never credentials. Equal dimensions or
// equal public model names do not make two providers' vector spaces compatible.
export function embeddingProfile(config: EmbeddingConfig) {
  const baseUrl = normalizedBaseUrl(config.baseUrl);
  if (!config.model.trim() || !Number.isInteger(config.dimensions) || config.dimensions < 1 || config.dimensions > 16384)
    throw new Error('Invalid embedding model or dimensions');
  const recipe = {
    version: 1, provider: config.provider ?? (baseUrl === defaults.baseUrl ? 'openai' : 'openai-compatible'),
    baseUrl, model: config.model, modelRevision: config.modelRevision ?? '', dimensions: config.dimensions,
    distanceMetric: 'cosine' as const, normalization: config.normalization ?? 'none',
    documentPrefix: config.documentPrefix ?? '', queryPrefix: config.queryPrefix ?? '',
    preprocessingVersion: config.preprocessingVersion ?? 'plain-v1', chunkVersion: config.chunkVersion ?? 'chat-v2',
    sendDimensions: config.sendDimensions ?? true,
  };
  return { id: createHash('sha256').update(JSON.stringify(recipe)).digest('hex'), ...recipe };
}
export const LEGACY_EMBEDDING_PROFILE = embeddingProfile({ ...defaults, apiKey: '', queryTimeoutMs: 1000 });

export function embeddingConfig(directory = DATA_DIR): EmbeddingConfig | undefined {
  try {
    const c = JSON.parse(readFileSync(process.env.WCB_EMBEDDINGS_CONFIG ?? join(directory, 'providers', 'openai-embeddings.json'), 'utf8'));
    if (!c || typeof c.apiKey !== 'string' || !c.apiKey.trim() || typeof c.model !== 'string' || typeof c.baseUrl !== 'string') return;
    const dimensions = c.dimensions ?? (c.model === defaults.model ? defaults.dimensions : undefined);
    const config: EmbeddingConfig = { ...c, baseUrl: normalizedBaseUrl(c.baseUrl), dimensions,
      queryTimeoutMs: Math.min(3000, Math.max(200, Number(c.queryTimeoutMs) || 1000)) };
    for (const key of ['provider', 'modelRevision', 'documentPrefix', 'queryPrefix', 'preprocessingVersion', 'chunkVersion'] as const)
      if (config[key] !== undefined && typeof config[key] !== 'string') return;
    if (config.normalization !== undefined && !['none', 'l2'].includes(config.normalization)) return;
    if (config.sendDimensions !== undefined && typeof config.sendDimensions !== 'boolean') return;
    if (config.maxDistance !== undefined && (!Number.isFinite(config.maxDistance) || config.maxDistance < 0 || config.maxDistance > 2)) return;
    embeddingProfile(config);
    return config;
  } catch { return; }
}
export function createEmbedder(config: EmbeddingConfig, request: typeof fetch = fetch) {
  const profile = embeddingProfile(config);
  let dispatcher: Dispatcher | undefined;
  return {
    async embed(input: string[], timeoutMs = 20000, signal?: AbortSignal, purpose: 'document' | 'query' = 'document') {
      if (!input.length || input.length > 64 || input.some(text => !text.trim() || text.length > 6000)) throw new Error('Invalid embedding batch');
      const prefix = purpose === 'query' ? profile.queryPrefix : profile.documentPrefix;
      if (request === fetch && config.proxyUrl && !dispatcher) dispatcher = new ProxyAgent(config.proxyUrl);
      const deadline = AbortSignal.timeout(timeoutMs);
      let response: Response;
      try {
        response = await request(`${profile.baseUrl}/embeddings`, {
          method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
          headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: profile.model, ...(profile.sendDimensions ? { dimensions: profile.dimensions } : {}),
            input: input.map(text => `${prefix}${text}`), encoding_format: 'float' }),
          ...(dispatcher ? { dispatcher } : {}),
        });
      } catch { throw new Error('Embedding network request failed or timed out'); }
      // Never include response bodies, request headers or provider credentials in errors.
      if (!response.ok) throw new Error(`Embedding HTTP ${response.status}`);
      const body = await response.json() as { data?: { index: number; embedding: number[] }[]; usage?: Record<string,unknown>&{ total_tokens?: number } };
      const rows = body.data?.slice().sort((a, b) => a.index - b.index);
      if (rows?.length !== input.length || rows.some((row, i) => row.index !== i || !Array.isArray(row.embedding)
        || row.embedding.length !== profile.dimensions || !row.embedding.every(Number.isFinite)
        || !row.embedding.some(value => value !== 0))) throw new Error('Invalid embedding response');
      const vectors = rows.map(row => {
        if (profile.normalization !== 'l2') return row.embedding;
        const length = Math.hypot(...row.embedding);
        return row.embedding.map(value => value / length);
      });
      return { vectors, tokens: typeof body.usage?.total_tokens==='number'?body.usage.total_tokens:undefined,
        usage:body.usage,provider:profile.provider,model:profile.model };
    },
    async close() { await dispatcher?.destroy(); },
  };
}
