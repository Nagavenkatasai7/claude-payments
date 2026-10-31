/**
 * chat-text-match — the small shared matcher behind the agent.turn router's
 * deterministic checks (help-intents.ts R43, scope-guard.ts R56). Pure.
 *
 * JavaScript's \b only knows ASCII letters, so "llegó" or "recibí" would never
 * end a word. Every pattern is compiled by rx(): NFKC (as the text is, so a
 * precomposed Devanagari letter matches its decomposed form) and a Unicode word
 * boundary in place of \b.
 */

const UB = '(?:(?<=[\\p{L}\\p{M}\\p{N}])(?![\\p{L}\\p{M}\\p{N}])|(?<![\\p{L}\\p{M}\\p{N}])(?=[\\p{L}\\p{M}\\p{N}]))';

/** Lower case, NFKC, apostrophes kept, every other mark a space, spaces collapsed. '' for a non-string. */
export function normalizeChatText(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’ʼ`´]/gu, "'")
    .replace(/[\p{Cf}]/gu, '')
    .replace(/[^\p{L}\p{M}\p{N}\s']/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** A pattern (literal or source string) compiled with NFKC and a Unicode \b. */
export function rx(r: RegExp | string): RegExp {
  const source = typeof r === 'string' ? r : r.source;
  return new RegExp(source.normalize('NFKC').replaceAll('\\b', UB), 'u');
}

/** A test that passes when any of the patterns matches. */
export function anyOf(...res: Array<RegExp | string>): (t: string) => boolean {
  const compiled = res.map(rx);
  return (t: string) => compiled.some((re) => re.test(t));
}
