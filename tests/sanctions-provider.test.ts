import { describe, it, expect } from 'vitest';
import { MockSanctionsScreener, getSanctionsScreener } from '@/lib/providers/sanctions-provider';

describe('MockSanctionsScreener', () => {
  it('matches a base-list name case-insensitively and trimmed', async () => {
    const s = new MockSanctionsScreener(['John Doe', 'jane roe']);
    const hit = await s.screen({ name: '  JOHN DOE ', sourceCountry: 'US' });
    expect(hit.matched).toBe(true);
    expect(hit.matchedName).toBe('john doe');
    expect(hit.listSource).toBe('mock-watchlist');
  });

  it('returns { matched: false } for an unlisted name', async () => {
    const s = new MockSanctionsScreener(['john doe']);
    const hit = await s.screen({ name: 'Mom', sourceCountry: 'US' });
    expect(hit).toEqual({ matched: false });
  });

  it('matches a corridor watchlistExtra name folded into the base list', async () => {
    const s = new MockSanctionsScreener(['john doe', 'corridor villain']);
    const hit = await s.screen({ name: 'Corridor Villain', sourceCountry: 'GB' });
    expect(hit.matched).toBe(true);
  });

  it('empty / whitespace name never matches (defensive ?? \'\')', async () => {
    const s = new MockSanctionsScreener(['john doe']);
    expect((await s.screen({ name: '', sourceCountry: 'US' })).matched).toBe(false);
    expect((await s.screen({ name: '   ', sourceCountry: 'US' })).matched).toBe(false);
  });

  it('accepts and ignores sourceCountry without error', async () => {
    const s = new MockSanctionsScreener(['john doe']);
    await expect(s.screen({ name: 'john doe', sourceCountry: 'AE' })).resolves.toMatchObject({ matched: true });
  });
});

describe('MockSanctionsScreener — internal whitespace normalization (regression)', () => {
  // 'john doe' is on the watchlist; 'john  doe' (double-space) was bypassing exact includes().
  it('matches a watchlisted name that has extra internal spaces (double-space bypass)', async () => {
    const s = new MockSanctionsScreener(['John Doe']);
    const hit = await s.screen({ name: 'John  Doe', sourceCountry: 'US' }); // two spaces
    expect(hit.matched).toBe(true);
    expect(hit.listSource).toBe('mock-watchlist');
  });

  it('matches a watchlisted name that contains a tab character', async () => {
    const s = new MockSanctionsScreener(['John Doe']);
    const hit = await s.screen({ name: 'John\tDoe', sourceCountry: 'US' }); // tab
    expect(hit.matched).toBe(true);
  });

  it('also normalises whitespace in list entries (list stored with extra spaces)', async () => {
    const s = new MockSanctionsScreener(['John  Doe']); // list entry has double space
    const hit = await s.screen({ name: 'John Doe', sourceCountry: 'US' }); // query has single space
    expect(hit.matched).toBe(true);
  });
});

describe('getSanctionsScreener', () => {
  it('builds a MockSanctionsScreener over the supplied base list', async () => {
    const s = getSanctionsScreener(['test blocked']);
    expect((await s.screen({ name: 'Test Blocked', sourceCountry: 'US' })).matched).toBe(true);
  });
});
