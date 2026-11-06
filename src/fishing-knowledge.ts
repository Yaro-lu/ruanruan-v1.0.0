import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FISHING_KNOWLEDGE_SOURCE = Object.freeze({
  name: 'BigFish',
  url: 'https://github.com/kobenfang/BigFish',
  revision: '01f9e841b91e4ebc939afa6b342461093ef12b83',
  license: 'MIT',
});

export type FishingKnowledgeTopic = 'species' | 'bait' | 'lure' | 'spot' | 'weather' | 'terms';
export interface FishingKnowledgeExcerpt {
  id: string;
  title: string;
  topic: FishingKnowledgeTopic;
  text: string;
  sourceUrl: string;
}
export interface FishingKnowledgeResult {
  source: typeof FISHING_KNOWLEDGE_SOURCE;
  referenceOnly: true;
  guidance: string;
  excerpts: FishingKnowledgeExcerpt[];
  moreAvailable: boolean;
}

const KNOWLEDGE_DIRECTORY = fileURLToPath(new URL('../../third_party/bigfish/knowledge/', import.meta.url));
const FILES = ['fish-species.yaml', 'bait-recipes.yaml', 'lure-guide.yaml', 'spot-analysis.yaml'] as const;
const SECTIONS: Record<string, { title: string; topic: FishingKnowledgeTopic }> = {
  species: { title: '鱼种习性', topic: 'species' },
  bait_principles: { title: '用饵经验', topic: 'bait' },
  season_bait: { title: '季节用饵', topic: 'bait' },
  common_recipes: { title: '饵料配方', topic: 'bait' },
  bait_matrix: { title: '饵料选择', topic: 'bait' },
  ground_bait: { title: '窝料', topic: 'bait' },
  lure_categories: { title: '路亚拟饵', topic: 'lure' },
  color_selection: { title: '拟饵颜色', topic: 'lure' },
  equipment_setup: { title: '路亚装备', topic: 'lure' },
  terminology: { title: '钓鱼术语', topic: 'terms' },
  terrain_analysis: { title: '钓点地形', topic: 'spot' },
  water_quality_analysis: { title: '水色观察', topic: 'spot' },
  weather_to_fish: { title: '天气经验', topic: 'weather' },
  season_fish_map: { title: '季节鱼情', topic: 'spot' },
};
const LABELS: Record<string, string> = {
  spring: '春季', summer: '夏季', autumn: '秋季', winter: '冬季',
  season: '季节与颜色', water: '水色与颜色', light: '光照与颜色',
};

// These exclusions apply to this reviewed, pinned snapshot. Preserve upstream
// files verbatim for licensing/provenance; never return quarantined facts.
const UNRELIABLE_LINE = /泥鳅|\bscore:|必在附近|必有亲鱼|必经之路|必然|全天都有口|全天活跃|全年有效|疯狂进食|什么鱼都吃|越清越好钓|效果远超|远超其他|刺激性强才有用|会在停顿瞬间攻击|涵洞出口是鲶鱼老窝|鱼上浮不开口/;
const QUARANTINED_SPECIES = new Set(['罗非鱼', '鲶鱼']);

interface IndexedExcerpt extends FishingKnowledgeExcerpt {
  searchable: string;
  heading: string;
}
let cachedIndex: IndexedExcerpt[] | undefined;

function normalize(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, '');
}

function entryStarts(lines: string[], section: string): { offset: number; label: string }[] {
  // Deliberately a line-based extractor for the reviewed YAML shape, not a YAML
  // interpreter. It does not execute tags, resolve aliases, or follow paths.
  const starts: { offset: number; label: string }[] = [];
  const pattern = section === 'lure_categories'
    ? /^      - name:\s*(.+)$/
    : section === 'bait_matrix'
      ? /^(?:      - name:|  - type:)\s*(.+)$/
      : /^  (?:- (?:name|setup|terrain|quality|condition):\s*(.+)|([a-z_]+):\s*)$/;
  lines.forEach((line, offset) => {
    const match = line.match(pattern);
    if (match) starts.push({ offset, label: match[1] || LABELS[match[2]] || match[2] });
  });
  // The 活饵 group header has no knowledge of its own once individual baits
  // have been split out. 商品饵 has categories rather than named items.
  return starts.filter((entry, index) => !(section === 'bait_matrix'
    && entry.label === '活饵' && starts[index + 1]?.offset === entry.offset + 2));
}

function loadIndex(): IndexedExcerpt[] {
  if (cachedIndex) return cachedIndex;
  const excerpts: IndexedExcerpt[] = [];
  for (const file of FILES) {
    const lines = readFileSync(KNOWLEDGE_DIRECTORY + file, 'utf8').split(/\r?\n/);
    const sections = lines.flatMap((line, offset) => {
      const match = line.match(/^([a-z_]+):\s*$/);
      return match && SECTIONS[match[1]] ? [{ key: match[1], offset }] : [];
    });
    sections.forEach((section, index) => {
      const end = sections[index + 1]?.offset ?? lines.length;
      const body = lines.slice(section.offset + 1, end);
      const entries = entryStarts(body, section.key);
      if (!entries.length) entries.push({ offset: 0, label: '' });
      entries.forEach((entry, entryIndex) => {
        if ((section.key === 'species' && QUARANTINED_SPECIES.has(entry.label))
            || (section.key === 'bait_matrix' && entry.label === '泥鳅')) return;
        const raw = body.slice(entry.offset, entries[entryIndex + 1]?.offset ?? body.length);
        const text = raw.filter(line => !UNRELIABLE_LINE.test(line) && !line.trimStart().startsWith('#')).join('\n').trim();
        if (!text) return;
        const metadata = SECTIONS[section.key];
        const title = [metadata.title, entry.label].filter(Boolean).join(' · ');
        const line = section.offset + entry.offset + 2;
        const sourceUrl = `${FISHING_KNOWLEDGE_SOURCE.url}/blob/${FISHING_KNOWLEDGE_SOURCE.revision}/scripts/knowledge/${file}#L${line}`;
        // Alias matches should rank with the named entry, not with incidental
        // mentions of a species elsewhere in a long recipe or environment list.
        const aliases = raw.find(value => /^\s+alias:/.test(value)) ?? '';
        excerpts.push({ id: `${file}:${line}`, title, topic: metadata.topic, text, sourceUrl,
          searchable: normalize(title + '\n' + text), heading: normalize(title + aliases) });
      });
    });
  }
  cachedIndex = excerpts;
  return excerpts;
}

function terms(query: string): string[] {
  const result = new Set<string>();
  for (const match of query.normalize('NFKC').toLowerCase().matchAll(/[\p{Script=Han}]+|[a-z][a-z0-9]*/gu)) {
    const word = match[0];
    if (/^[a-z]/.test(word)) result.add(word);
    else for (let i = 0; i < word.length - 1; i++) result.add(word.slice(i, i + 2));
  }
  // Common conversational spellings, without assuming a specific fishing spot.
  if (query.includes('老三样')) result.add('野钓综合饵');
  if (query.includes('空军')) result.add('打龟');
  return [...result].filter(term => !['怎么', '什么', '一下', '今天', '明天', '可以', '有没有', '推荐'].includes(term));
}

export function searchFishingKnowledge(options: {
  query: string;
  limit?: number;
  maxChars?: number;
}): FishingKnowledgeResult {
  const query = options.query.trim().slice(0, 300);
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(5, Math.floor(options.limit!))) : 3;
  const budget = Number.isFinite(options.maxChars) ? Math.max(0, Math.min(8000, Math.floor(options.maxChars!))) : 4200;
  const needles = terms(query);
  const matches = needles.length ? loadIndex().map(entry => ({ entry, score: needles.reduce((score, needle) =>
    score + (entry.heading.includes(needle) ? 7 : entry.searchable.includes(needle) ? 1 : 0), 0),
  })).filter(match => match.score > 0).sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id)) : [];
  const selected: FishingKnowledgeExcerpt[] = [];
  let used = 0;
  for (const { entry } of matches) {
    if (selected.length >= limit) break;
    // Keep complete entries, including qualifications; do not cut a sentence
    // simply to reach a character budget or return all four source documents.
    if (used + entry.text.length > budget) continue;
    const { searchable: _searchable, heading: _heading, ...excerpt } = entry;
    selected.push(excerpt);
    used += entry.text.length;
  }
  return {
    source: FISHING_KNOWLEDGE_SOURCE,
    referenceOnly: true,
    guidance: '固定版本的钓鱼经验参考，未逐条验证；温度、时段、配比和器材参数需结合具体水域。不是实时天气、鱼获概率、当地鱼种调查或开放/禁钓规定。不能凭水面照片确认水下鱼种，也不能保证某钓点有鱼或有口。已隔离部分有误物种条目、确定性鱼情保证与天气评分。',
    excerpts: selected,
    moreAvailable: matches.length > selected.length,
  };
}
