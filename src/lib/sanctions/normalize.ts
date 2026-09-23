// Sanctions name normalisation (Program-Fix 14, prs-03).
//
// Hardens sanctions name matching: every screener normalises BOTH the query
// and each list entry through here, so formatting differences (spacing,
// punctuation, case, diacritics, word order) do not change the outcome.
//
// Order matters: lowercase FIRST, then NFKD, then strip combining marks.
// Lowercasing after decomposition can re-introduce a mark ('İ' lowercases to
// 'i' + U+0307). Letters and digits of every script are kept (\p{L}\p{N}), so
// a Cyrillic, Arabic or CJK name never collapses to ''.

const COMBINING_MARKS = /\p{M}+/gu;
const NOT_LETTER_OR_DIGIT = /[^\p{L}\p{N}]+/gu;

/** Lowercase, fold diacritics, map punctuation/whitespace to one space, trim. */
export function normalizeName(name: string): string {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(NOT_LETTER_OR_DIGIT, ' ')
    .trim();
}

/** The sorted token set of a normalised name, so word order ('Doe, John') does not matter. */
export function tokenKey(name: string): string {
  const n = normalizeName(name);
  if (n === '') return '';
  return n.split(' ').sort().join(' ');
}
