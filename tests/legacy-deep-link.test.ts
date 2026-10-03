import { describe, it, expect } from 'vitest';
import { continuePath, legacyDeepLink, parseContinueTarget } from '@/lib/legacy-deep-link';

// Lost-features p4 C2: old /account receipt and ticket links, opened signed out, go through
// /account/continue/<kind>/<id> to the right partner's portal sign-in. The matcher is pure and runs
// in the proxy, so it is exact: one receipt id or one tk_ ticket id, nothing else.

const ID22 = 'AbCdEfGhIjKlMnOpQrStUv';

describe('legacyDeepLink', () => {
  it.each([
    [`/account/receipt/${ID22}`, { kind: 'receipt', id: ID22 }],
    ['/account/receipt/ab12CD', { kind: 'receipt', id: 'ab12CD' }],
    ['/account/support/tk_Abc-_1', { kind: 'support', id: 'tk_Abc-_1' }],
  ])('%s → %j', (path, want) => expect(legacyDeepLink(path)).toEqual(want));

  it.each([
    '/account/support/new',
    '/account/support/abc',
    '/account/support/tk_',
    '/account/support',
    '/account/receipt/',
    '/account/receipt',
    '/account/receipt/x/y',
    '/account/receipt/abc', // shorter than any transfer id
    `/account/receipt/${'a'.repeat(65)}`,
    `/account/support/tk_${'a'.repeat(65)}`,
    '/account/receipt/ab%2Fcd12',
    '/account/receipt/..%2F..%2Fx',
    '/account/support/tk_x/',
    '/account/history',
    '/account/login',
    '/portal/transfers/abcdef12',
    '',
  ])('%s → null', (path) => expect(legacyDeepLink(path)).toBeNull());
});

describe('continuePath / parseContinueTarget', () => {
  it('builds the continue path for a matched link', () => {
    expect(continuePath({ kind: 'receipt', id: ID22 })).toBe(`/account/continue/receipt/${ID22}`);
    expect(continuePath({ kind: 'support', id: 'tk_A1' })).toBe('/account/continue/support/tk_A1');
  });
  it('parses route params with the same id rules', () => {
    expect(parseContinueTarget('receipt', ID22)).toEqual({ kind: 'receipt', id: ID22 });
    expect(parseContinueTarget('support', 'tk_A1')).toEqual({ kind: 'support', id: 'tk_A1' });
    expect(parseContinueTarget('support', ID22)).toBeNull();
    expect(parseContinueTarget('receipt', 'tk_')).toBeNull();
    expect(parseContinueTarget('history', ID22)).toBeNull();
    expect(parseContinueTarget('receipt', 'a/b')).toBeNull();
    expect(parseContinueTarget(undefined, undefined)).toBeNull();
  });
  it('maps a target to its portal page', async () => {
    const { portalPathFor } = await import('@/lib/legacy-deep-link');
    expect(portalPathFor({ kind: 'receipt', id: ID22 })).toBe(`/portal/transfers/${ID22}`);
    expect(portalPathFor({ kind: 'support', id: 'tk_A1' })).toBe('/portal/help/tickets/tk_A1');
  });
});
