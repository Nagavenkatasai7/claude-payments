import { describe, it, expect } from 'vitest';
import { normalizeName, tokenKey } from '@/lib/sanctions/normalize';

// Program-Fix 14 (prs-03): name normalisation for sanctions matching.
describe('normalizeName', () => {
  it('collapses whitespace, punctuation, case and diacritics to one form', () => {
    for (const v of ['John  Doe', 'John\tDoe', 'JOHN DOE.', 'john-doe', ' john doe ']) {
      expect(normalizeName(v)).toBe('john doe');
    }
    expect(normalizeName('Jöhn Doe')).toBe('john doe');
  });

  it('keeps non-Latin letters (never collapses a real name to empty)', () => {
    expect(normalizeName('Иван  Петров')).toBe('иван петров');
    expect(normalizeName('محمد')).not.toBe('');
    expect(normalizeName('محمد')).toBe('محمد');
    expect(normalizeName('李 小龍')).toBe('李 小龍');
  });

  it('lowercases BEFORE decomposing, so a dotted capital I leaves no combining mark', () => {
    // 'İ'.toLowerCase() is 'i' + U+0307; stripping marks after NFKD must remove it.
    expect(normalizeName('İVAN')).toBe('ivan');
  });

  it('keeps digits and returns empty for empty / punctuation-only input', () => {
    expect(normalizeName('Unit 731')).toBe('unit 731');
    expect(normalizeName('')).toBe('');
    expect(normalizeName('  ,. - ')).toBe('');
    expect(normalizeName(undefined as unknown as string)).toBe('');
  });
});

describe('tokenKey', () => {
  it('gives the same key for every audit repro spelling, including "Last, First"', () => {
    const want = tokenKey('John Doe');
    for (const v of ['John  Doe', 'John\tDoe', 'Doe, John', 'JOHN DOE.', 'Jöhn Doe']) {
      expect(tokenKey(v)).toBe(want);
    }
  });

  it('does not merge distinct names', () => {
    expect(tokenKey('John Doe')).not.toBe(tokenKey('John Doe Smith'));
    expect(tokenKey('John Doe')).not.toBe(tokenKey('Jon Doe'));
  });

  it('is empty for an empty name', () => {
    expect(tokenKey('  ')).toBe('');
  });
});
