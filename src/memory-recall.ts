import type { ForgottenFact } from './memory-facts.js';
interface SearchableNote { id: string; kind: string; text: string; expiresAt?: string;
  priorSources?: { quote: string }[] }
export interface RecallContext { topic?: string; recentUser?: string; pinnedIds?: string[] }
export function suppressedByForgetting(text: string, forgotten: string[]): boolean {
  return forgotten.some(old => old && (text.includes(old)
    || rankMemories([{ id: 'candidate', kind: 'message', text }], old).length > 0));
}

// Keep unrelated clauses from the same transport message. New user statements
// after a forget request remain available; they are not old history resurfacing.
export function redactForgotten(text: string, forgotten: (ForgottenFact | string)[], at = 0): string {
  const applicable = forgotten.filter(old => typeof old === 'string' || at <= Date.parse(old.at));
  if (!applicable.length) return text;
  return text.split(/([，,。；;！？!?\n]+)/u).map((clause, index) => {
    if (index % 2 || !clause.trim()) return clause;
    const hidden = applicable.some(old => {
      const quote = typeof old === 'string' ? old : old.text;
      if (quote && clause.includes(quote)) return true;
      if (typeof old !== 'string' && old.fact && old.fact.subject !== 'user'
        && !clause.includes(old.fact.subject)) return false;
      return suppressedByForgetting(clause, [quote]);
    });
    return hidden ? '[已按要求遗忘]' : clause;
  }).join('');
}
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const genericWords = new Set(['这个', '那个', '什么', '怎么', '为什么', '知道', '觉得', '可以', '应该', '一下', '时候', '现在', '刚才', '之前', '今天', '昨天', '已经', '还是']);

function terms(text: string): string[] {
  const result: string[] = [...(text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [])];
  const common = new Set('的了是我你他她它这那有没在也就都和吗呢啊呀吧着过');
  for (const block of text.match(/[\p{Script=Han}]+/gu) ?? []) {
    for (const char of block) if (!common.has(char)) result.push(char);
    for (let i = 0; i < block.length - 1; i++) result.push(block.slice(i, i + 2));
  }
  return result;
}

// Local BM25 over the small existing memory store; no embeddings, network or extra model calls.
export function rankMemories<T extends SearchableNote>(notes: T[], query: string, now = Date.now(), context: RecallContext = {}): T[] {
  const active = notes.filter(note => !note.expiresAt || Date.parse(note.expiresAt) > now);
  const documents = active.map(note => {
    // A correction can refer to an earlier detail without repeating its noun.
    // Search the evidence chain, but return the latest note as authoritative.
    const content = [note.text, ...(note.priorSources ?? []).map(source => source.quote)].join('\n');
    const words = terms(content);
    const counts = new Map<string, number>();
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    return { note, content, counts, length: Math.max(words.length, 1) };
  });
  const average = documents.reduce((sum, doc) => sum + doc.length, 0) / (documents.length || 1);
  // Short references and temporal follow-ups use the active topic and the last
  // user turn. Semantic reformulations remain available through the recall tool.
  const continuation = /上次|刚才|之前|那个|这个|继续|后来|结果|还用|昨天|这次|又/u.test(query);
  const expanded = `${query}${continuation ? ` ${context.topic ?? ''} ${context.recentUser ?? ''}` : ''}`;
  const queryTerms = [...new Set(terms(expanded))];
  const anchors = [...segmenter.segment(expanded.toLowerCase())].filter(word => word.isWordLike
    && word.segment.length >= 2 && !genericWords.has(word.segment)).map(word => word.segment);
  const frequencies = new Map(queryTerms.map(term => [term, documents.filter(doc => doc.counts.has(term)).length]));
  const asksObservation = /怎么看我|对我的|了解我|我的习惯|我的性格|你觉得我/u.test(query);
  return documents.map(doc => {
    let score = context.pinnedIds?.includes(doc.note.id) ? 10 : 0;
    let meaningful = score > 0;
    // A short compound can be separated in Chinese (钓鱼 / 钓鲫鱼).
    // One incidental character is never enough to retrieve a whole record.
    if (anchors.some(word => doc.content.toLowerCase().includes(word)
      || (/^[\p{Script=Han}]{2}$/u.test(word) && new RegExp(`${word[0]}[\\p{Script=Han}]{0,2}${word[1]}`, 'u').test(doc.content)))) meaningful = true;
    if (asksObservation && doc.note.kind === 'observation') score += 2;
    if (asksObservation && doc.note.kind === 'observation') meaningful = true;
    for (const term of queryTerms) {
      const count = doc.counts.get(term) ?? 0;
      if (!count) continue;
      const frequency = frequencies.get(term)!;
      const idf = Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5));
      const weight = term.length === 1 ? 0.2 : 1;
      score += weight * idf * count * 2.2 / (count + 1.2 * (0.25 + 0.75 * doc.length / average));
    }
    return { note: doc.note, score, meaningful };
  }).filter(row => row.meaningful && row.score > 0).sort((a, b) => b.score - a.score).map(row => row.note);
}
