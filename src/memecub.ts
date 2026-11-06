import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ProxyAgent, type Dispatcher } from 'undici';
import { DATA_DIR } from './constants.js';
import { createMediaState } from './media-state.js';
import { catalogFile, MEDIA_ROOT, type CatalogCandidate } from './media-catalog.js';
import { readImage } from './media/image.js';

const ORIGIN = 'https://memecub.com';
const MAX_BYTES = 8 * 1024 * 1024;
export function memeFile(asset: CatalogCandidate, directory: string, root = MEDIA_ROOT) {
  if (asset.purpose !== 'reaction') throw new Error('不是本轮表情包候选');
  if (!asset.meme) {
    const path = catalogFile(asset, root);
    if (!path) throw new Error('本地表情素材不可用');
    return path;
  }
  if (!/^meme_[a-f0-9]{20}$/.test(asset.asset_id)) throw new Error('不是本轮表情包候选');
  return join(directory, asset.asset_id + '.img');
}
interface MemeConfig { enabled: boolean; apiKey: string; proxyUrl?: string }
export function memeConfig(directory = DATA_DIR): MemeConfig | undefined {
  try {
    const c = JSON.parse(readFileSync(process.env.WCB_MEMECUB_CONFIG ?? join(directory, 'providers', 'memecub.json'), 'utf8'));
    return c.enabled && typeof c.apiKey === 'string' && /^mb_[A-Za-z0-9_-]+$/.test(c.apiKey) ? c : undefined;
  } catch { return; }
}
export const MEME_TOOL_SPEC = { type: 'function', name: 'meme_search',
  description: '表情是常用的微信回应方式，可表达短反应、会意、疑惑、无语、害羞、招呼或道别，不限于兴奋和玩笑。本地Q版与已启用的API图库都可直接使用：auto快速找Q版，想换画风或用网络梗图、动物表情时选source=api，无需先搜本地。query只传简短的表情意图或关键词，不传用户对话和隐私。按结果标题选择贴合的一张，最终正文用[[ASSET:候选id]]交给微信发送；每轮最多一张，也可以不选。一张图已经表达清楚时，最终正文可以只有该编号，照常附内部接续数据；social.mode用reply或省略，不是quiet。不必配同义文字，确实还想说具体内容时再搭配文字，不按固定比例或轮数插图。Q版是表达语气的卡通形象，不是自拍，不改变你的位置、穿搭或生活。不要展示链接、候选列表或工具过程。失败或没有合适结果就继续自然文字。',
  inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 80 },
    source: { type: 'string', enum: ['auto','local','api'], description: 'auto优先本地Q版；local只找Q版；api直接找网络梗图、动物表情或其他画风，有本地结果也可选api。表情是普通回复，无需照片分享意愿或好感门槛。' } }, required: ['query'], additionalProperties: false } };

export function createMemeClient(directory = DATA_DIR, options: { fetch?: typeof fetch; now?: () => number; mediaRoot?: string } = {}) {
  const now = options.now ?? Date.now;
  let dispatcher: Dispatcher | undefined;
  const cache = join(directory, 'meme-cache');
  const request = async (url: string, authenticated: boolean) => {
    const config = memeConfig(directory);
    if (!config) throw new Error('MemeCub未启用');
    // Only the fixed provider origin receives the key; CDN image requests never do.
    if (authenticated && new URL(url).origin !== ORIGIN) throw new Error('凭据只能发送给MemeCub');
    if (!options.fetch && !dispatcher && config.proxyUrl) dispatcher = new ProxyAgent(config.proxyUrl);
    const init: RequestInit & { dispatcher?: Dispatcher } = { redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: authenticated ? { authorization: `Bearer ${config.apiKey}`, accept: 'application/json' } : {},
      ...(!options.fetch && dispatcher ? { dispatcher } : {}) };
    return (options.fetch ?? fetch)(url, init);
  };
  async function search(query: string, owner: string) {
    if (!memeConfig(directory)) return { status: 'disabled', candidates: [] as CatalogCandidate[] };
    if (typeof query !== 'string' || !query.trim() || query.length > 80) throw new Error('表情包查询需要80字以内的简短意图');
    mkdirSync(cache, { recursive: true, mode: 0o700 });
    const parameters = { q: query.trim(), limit: '12' };
    const path = join(cache, createHash('sha256').update(JSON.stringify(parameters)).digest('hex') + '.json');
    let rows: any[] | undefined;
    try { const cached = JSON.parse(readFileSync(path, 'utf8')); if (now() - cached.at < (cached.data?.length ? 10 * 60000 : 45000)) rows = cached.data; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    let creditsRemaining: number | undefined;
    if (!rows) {
      const url = new URL('/api/v1/search', ORIGIN);
      for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
      let response: Response;
      try { response = await request(url.href, true); }
      catch { return { status: 'unavailable', candidates: [] as CatalogCandidate[] }; }
      if (!response.ok) return { status: response.status === 402 ? 'insufficient_credits' : response.status === 429 ? 'rate_limited' : 'unavailable', candidates: [] as CatalogCandidate[] };
      const result = await response.json() as { data?: any[] };
      if (!Array.isArray(result.data)) throw new Error('MemeCub结果格式错误');
      rows = result.data;
      const left = response.headers.get('x-credits-remaining');
      if (left !== null) creditsRemaining = Number(left);
      writeFileSync(path, JSON.stringify({ at: now(), data: rows }), { mode: 0o600 });
    }
    const state = createMediaState(owner, directory).snapshot();
    const recent = new Set(state.sent.filter(row => now() - row.at < 24 * 3600000).map(row => row.assetId));
    const candidates: CatalogCandidate[] = rows.filter(row => typeof row.id === 'string' && /^[\w-]{1,120}$/.test(row.id)
      && typeof row.url === 'string' && typeof row.title === 'string' && !row.profane && !row.private && !row.license?.attribution_required)
      .map(row => ({ asset_id: 'meme_' + createHash('sha256').update(row.id).digest('hex').slice(0, 20), kind: 'image' as const,
        file: '', title: (row.title_zh || row.title).slice(0, 120), description: (row.title_zh || row.title).slice(0, 200),
        tags: ['表情包', query.trim()], purpose: 'reaction' as const, repeatAllowed: true,
        meme: { id: row.id, url: row.url, pageUrl: row.page_url ?? '' } }))
      .filter(asset => !recent.has(asset.asset_id) && !state.reserved.some(row => row.assetId === asset.asset_id)).slice(0, 5);
    return { status: candidates.length ? 'found' : rows.length ? 'recently_used' : 'empty', candidates, creditsRemaining };
  }
  async function download(asset: CatalogCandidate, destination: string) {
    const path = memeFile(asset, destination, options.mediaRoot);
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    if (existsSync(path)) { await readImage(path); return path; }
    const url = new URL(asset.meme!.url, ORIGIN);
    const hosted = /(^|\.)memecub\.com$/i.test(url.hostname)
      || url.hostname === 'gpic.code-nav.cn' && url.pathname.startsWith('/memecub/');
    if (url.protocol !== 'https:' || !hosted || url.username || url.password) throw new Error('表情包图片需要MemeCub托管地址');
    const response = await request(url.href, false);
    if (!response.ok || Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('表情包图片无法下载或过大');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('表情包图片为空');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_BYTES) throw new Error('表情包图片超过8MiB');
        chunks.push(part.value);
      }
    } finally { await reader.cancel(); }
    const bytes = Buffer.concat(chunks);
    writeFileSync(path, bytes, { mode: 0o600 });
    await readImage(path);
    return path;
  }
  return { search, download, close: async () => { await dispatcher?.close(); } };
}
