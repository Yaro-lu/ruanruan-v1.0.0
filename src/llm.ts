import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DATA_DIR } from './constants.js';
import { isReasoningEffort, type ReasoningEffort } from './reasoning.js';
import type { CodexRunOptions } from './codex/bridge.js';

export interface LlmProvider {
  baseUrl: string; model: string; reasoningEffort: ReasoningEffort; contextWindow?: number;
  useRoleModels?: boolean;
}
export interface LlmConfiguration {
  active: string; providers: Record<string, LlmProvider>;
  scope?: 'foreground' | 'character';
}
const validId = (id: string) => /^[a-z][a-z0-9_]{0,31}$/u.test(id);
export function readLlmConfiguration(directory = DATA_DIR): LlmConfiguration {
  let value: LlmConfiguration;
  try { value = JSON.parse(readFileSync(join(directory, 'providers', 'llm.json'), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { active: 'codex', providers: {} };
    throw new Error('Invalid LLM configuration');
  }
  if (!value || !validId(value.active) || !value.providers || typeof value.providers !== 'object' || Array.isArray(value.providers)) throw new Error('Invalid LLM configuration');
  if (value.scope !== undefined && !['foreground', 'character'].includes(value.scope)) throw new Error('Invalid LLM scope');
  for (const [id, p] of Object.entries(value.providers)) {
    if (!validId(id) || id === 'codex' || !p || typeof p.baseUrl !== 'string' || !p.baseUrl.startsWith('https://')
      || !p.model || !isReasoningEffort(p.reasoningEffort)
      || (p.useRoleModels !== undefined && typeof p.useRoleModels !== 'boolean')
      || (p.contextWindow !== undefined && (!Number.isInteger(p.contextWindow) || p.contextWindow < 16000))) throw new Error('Invalid LLM provider');
    const url = new URL(p.baseUrl);
    if (url.username || url.password || url.search || url.hash || 'apiKey' in p) throw new Error('Keep LLM credentials in the separate provider credential file');
  }
  if (value.active !== 'codex' && !value.providers[value.active]) throw new Error('Selected LLM provider is not configured');
  return value;
}
export function selectedChatLlm(directory = DATA_DIR) {
  const config = readLlmConfiguration(directory);
  const id = config.active;
  return { id, provider: id === 'codex' ? undefined : config.providers[id], scope: config.scope ?? 'foreground' };
}
export function withChatLlm(options: CodexRunOptions, directory = DATA_DIR): CodexRunOptions {
  // A durable job pins its target. Changing the active selector must not move
  // an already-running foreground generation to another supplier.
  if (options.llmProvider) return options;
  if (options.profile === 'work') return options;
  const { id, provider, scope } = selectedChatLlm(directory);
  if (options.profile === 'consolidation' && scope !== 'character') return options;
  if (!provider) return options;
  const model = provider.useRoleModels ? options.model ?? provider.model : provider.model;
  const reasoningEffort = provider.useRoleModels ? options.reasoningEffort ?? provider.reasoningEffort : provider.reasoningEffort;
  const serviceTier = provider.useRoleModels ? options.serviceTier ?? 'default' : 'default';
  const endpoint = { llmProvider: id, modelProvider: `wcb_${id}` };
  const originalTarget = { model: options.model, reasoningEffort: options.reasoningEffort, serviceTier: options.serviceTier };
  const reviewTarget = options.reviewTarget ?? originalTarget;
  const fingerprint = createHash('sha256').update(JSON.stringify([id, provider.baseUrl, model])).digest('hex').slice(0, 16);
  return { ...options, llmProvider: id, llmFingerprint: fingerprint, modelProvider: `wcb_${id}`,
    reviewTarget: scope === 'character' ? { ...reviewTarget, ...endpoint } : reviewTarget,
    ...(scope === 'character' ? { repairTarget: { ...options.repairTarget ?? reviewTarget, ...endpoint } } : {}),
    model, reasoningEffort, serviceTier,
    contextWindow: provider.contextWindow ?? options.contextWindow,
    threadConfig: { ...options.threadConfig,
      ...(provider.contextWindow ? { model_context_window: provider.contextWindow } : {}) } };
}

// Register all configured suppliers in this application's Codex child only.
// Tokens enter its environment, never CLI arguments, jobs or thread config.
export function llmRuntimeRegistration(directory = DATA_DIR) {
  const { providers, active } = readLlmConfiguration(directory);
  const args: string[] = [], env: Record<string, string> = {};
  for (const [id, p] of Object.entries(providers)) {
    let credentials: { apiKey?: string; proxyUrl?: string };
    try { credentials = JSON.parse(readFileSync(join(directory, 'providers', `${id}.json`), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw new Error(`Invalid credentials for ${id}`); }
    if (!credentials.apiKey) continue;
    const key = `WCB_LLM_${id.toUpperCase()}_API_KEY`;
    env[key] = credentials.apiKey;
    // This environment belongs only to the model runtime, never to WeChat.
    if (id === active && credentials.proxyUrl) {
      env.HTTPS_PROXY = credentials.proxyUrl;
      env.HTTP_PROXY = credentials.proxyUrl;
    }
    const prefix = `model_providers.wcb_${id}`;
    const fields = { name: id, base_url: p.baseUrl, wire_api: 'responses', env_key: key,
      request_max_retries: 0, stream_max_retries: 0 };
    for (const [field, value] of Object.entries(fields)) args.push('-c', `${prefix}.${field}=${JSON.stringify(value)}`);
  }
  return { args, env };
}
