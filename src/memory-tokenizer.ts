const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const commonCharacters = new Set('的了是我你他她它这那有没在也就都和吗呢啊呀吧着过');

// FTS5 unicode61 treats a Chinese sentence as one token unless it is separated.
// Keep words, adjacent pairs and meaningful characters so existing rankMemories
// can still recognize compounds such as 钓鱼 in 钓鲫鱼 after candidate retrieval.
export function memorySearchTerms(text: string): string[] {
  const terms = [...(text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [])];
  for (const block of text.match(/[\p{Script=Han}]+/gu) ?? []) {
    for (const char of block) if (!commonCharacters.has(char)) terms.push(char);
    for (let i = 0; i < block.length - 1; i++) terms.push(block.slice(i, i + 2));
  }
  for (const word of segmenter.segment(text.toLowerCase())) if (word.isWordLike && word.segment.length >= 2) terms.push(word.segment);
  return terms;
}

export function memoryFtsQuery(query: string): string | undefined {
  const terms = [...new Set(memorySearchTerms(query.slice(0, 2000)))].slice(0, 64);
  return terms.length ? terms.map(term => `"${term.replace(/"/gu, '""')}"`).join(' OR ') : undefined;
}
