import { describe, it, expect } from 'vitest';
import { encryptField } from '@/lib/field-crypto';
import { ctx } from '@/lib/crypto-context';
import {
  TRANSFER_SEARCH_TTL_MS,
  openTransferSearch,
  parseTransferQuery,
  sealTransferSearch,
} from '@/lib/partner-transfer-search';

// Lost-features restore p1 B1: the /partner transfer search. The typed text is classified into a
// closed shape (a name/id fragment or a run of digits), sealed into an opaque token bound to the
// tenant, the user and a 30-minute expiry, so no name or phone ever enters a URL in clear.

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);

describe('parseTransferQuery', () => {
  it('a name (has a letter) is a text search, whitespace collapsed', () => {
    expect(parseTransferQuery('  Testname   Sample ')).toEqual({ kind: 'text', value: 'Testname Sample' });
    expect(parseTransferQuery('tr_A1')).toEqual({ kind: 'text', value: 'tr_A1' });
  });
  it('4 digits is a digits search (last 4 of the account or the phone)', () => {
    expect(parseTransferQuery('1234')).toEqual({ kind: 'digits', value: '1234' });
  });
  it('a formatted phone strips + - ( ) . and spaces', () => {
    expect(parseTransferQuery('+1 (415) 555-0101')).toEqual({ kind: 'digits', value: '14155550101' });
    expect(parseTransferQuery('415.555.0101')).toEqual({ kind: 'digits', value: '4155550101' });
  });
  it('refuses junk: too short, too long, control characters, empty, symbols only, non-strings', () => {
    expect(parseTransferQuery('123')).toBeNull();
    expect(parseTransferQuery('1234567890123456')).toBeNull();
    expect(parseTransferQuery('a'.repeat(65))).toBeNull();
    expect(parseTransferQuery('ab\u0000c')).toBeNull();
    expect(parseTransferQuery('ab\nc')).toBeNull();
    expect(parseTransferQuery('')).toBeNull();
    expect(parseTransferQuery('   ')).toBeNull();
    expect(parseTransferQuery('%%__')).toBeNull();
    expect(parseTransferQuery(undefined)).toBeNull();
    expect(parseTransferQuery(42)).toBeNull();
  });
  it('a single letter is too short to search a tenant', () => {
    expect(parseTransferQuery('a')).toBeNull();
    expect(parseTransferQuery('ab')).toEqual({ kind: 'text', value: 'ab' });
  });
});

describe('sealTransferSearch / openTransferSearch', () => {
  it('round-trips for the same tenant and user before expiry', () => {
    const tok = sealTransferSearch('pa', 'pa-admin', { kind: 'text', value: 'Testname' }, NOW);
    expect(openTransferSearch(tok, 'pa', 'pa-admin', NOW + 60_000)).toEqual({ kind: 'text', value: 'Testname' });
    const dig = sealTransferSearch('pa', 'pa-admin', { kind: 'digits', value: '14155550101' }, NOW);
    expect(openTransferSearch(dig, 'pa', 'pa-admin', NOW)).toEqual({ kind: 'digits', value: '14155550101' });
  });
  it('is URL-safe and never contains the search text', () => {
    const tok = sealTransferSearch('pa', 'pa-admin', { kind: 'digits', value: '14155550101' }, NOW);
    expect(tok).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(tok).not.toContain('14155550101');
    expect(tok).not.toContain('5550101');
  });
  it('another tenant, another user, an expired or tampered token opens to null', () => {
    const tok = sealTransferSearch('pa', 'pa-admin', { kind: 'text', value: 'Testname' }, NOW);
    expect(openTransferSearch(tok, 'pb', 'pa-admin', NOW)).toBeNull();
    expect(openTransferSearch(tok, 'pa', 'pa-agent', NOW)).toBeNull();
    expect(openTransferSearch(tok, 'pa', 'pa-admin', NOW + TRANSFER_SEARCH_TTL_MS + 1)).toBeNull();
    const parts = tok.split('.');
    parts[parts.length - 1] = parts[parts.length - 1].slice(0, -2) + (parts[parts.length - 1].endsWith('AA') ? 'BB' : 'AA');
    expect(openTransferSearch(parts.join('.'), 'pa', 'pa-admin', NOW)).toBeNull();
  });
  it('a prefix-confusable username does not open another user\'s token', () => {
    const tok = sealTransferSearch('pa', 'ann', { kind: 'text', value: 'Testname' }, NOW);
    expect(openTransferSearch(tok, 'pa', 'ann|x', NOW)).toBeNull();
    expect(openTransferSearch(tok, 'p', 'a|ann', NOW)).toBeNull();
  });
  it('junk, oversized, non-strings and a token minted far in the future are null', () => {
    expect(openTransferSearch('junk', 'pa', 'u', NOW)).toBeNull();
    expect(openTransferSearch('v1.' + 'a'.repeat(2000), 'pa', 'u', NOW)).toBeNull();
    expect(openTransferSearch(undefined, 'pa', 'u', NOW)).toBeNull();
    const future = sealTransferSearch('pa', 'u', { kind: 'text', value: 'Testname' }, NOW + 10 * TRANSFER_SEARCH_TTL_MS);
    expect(openTransferSearch(future, 'pa', 'u', NOW)).toBeNull();
  });
  it('another sealed purpose (a customer ref) never opens as a search', () => {
    const other = encryptField('cref1|pa|14155550101', undefined, ctx.purpose('customer_ref'));
    expect(openTransferSearch(other, 'pa', 'u', NOW)).toBeNull();
  });
  it('a sealed body whose query no longer parses is null (the query is re-validated on open)', () => {
    const bad = encryptField(`tsq1|pa|u|${NOW + 1000}|digits|12`, undefined, ctx.purpose('transfer_search'));
    expect(openTransferSearch(bad, 'pa', 'u', NOW)).toBeNull();
  });
});
