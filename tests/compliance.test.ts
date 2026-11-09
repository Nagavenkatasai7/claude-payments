import { describe, it, expect } from 'vitest';
import { screenTransfer } from '@/lib/compliance';
import { GLOBAL_DEFAULTS } from '@/lib/compliance-config';
import { MockSanctionsScreener } from '@/lib/providers/sanctions-provider';

describe('screenTransfer — dormant (no rules/screener) reproduces today', () => {
  it('clears an ordinary transfer', async () => {
    const r = await screenTransfer({ amountUsd: 200, recipientName: 'Mom', transfersToday: 0, sourceCountry: 'US' });
    expect(r.status).toBe('cleared');
    expect(r.reasons).toEqual([]);
  });
  it('blocks a recipient on the watchlist (case-insensitive)', async () => {
    const r = await screenTransfer({ amountUsd: 200, recipientName: '  John Doe ', transfersToday: 0, sourceCountry: 'US' });
    expect(r.status).toBe('blocked');
    expect(r.reasons[0]).toMatch(/watchlist/i);
  });
  it('flags a large amount', async () => {
    const r = await screenTransfer({ amountUsd: 1500, recipientName: 'Mom', transfersToday: 0, sourceCountry: 'US' });
    expect(r.status).toBe('flagged');
    expect(r.reasons.some((x) => /amount/i.test(x))).toBe(true);
  });
  it('flags high velocity', async () => {
    // VELOCITY_LIMIT is now 5; 5+ same-day sends trigger a flag
    const r = await screenTransfer({ amountUsd: 200, recipientName: 'Mom', transfersToday: 5, sourceCountry: 'US' });
    expect(r.status).toBe('flagged');
    expect(r.reasons.some((x) => /velocity/i.test(x))).toBe(true);
  });
  it('clears at 4 same-day sends (below the new VELOCITY_LIMIT of 5)', async () => {
    const r = await screenTransfer({ amountUsd: 200, recipientName: 'Mom', transfersToday: 4, sourceCountry: 'US' });
    expect(r.status).toBe('cleared');
  });
  it('records both reasons when amount and velocity both trip', async () => {
    const r = await screenTransfer({ amountUsd: 1500, recipientName: 'Mom', transfersToday: 5, sourceCountry: 'US' });
    expect(r.status).toBe('flagged');
    expect(r.reasons).toHaveLength(2);
  });
  it('blocked takes precedence over flagged', async () => {
    const r = await screenTransfer({ amountUsd: 2000, recipientName: 'John Doe', transfersToday: 9, sourceCountry: 'US' });
    expect(r.status).toBe('blocked');
  });
});

describe('screenTransfer — corridor overrides', () => {
  it('a raised largeAmountUsd clears a transfer that is flagged-today', async () => {
    const rules = { ...GLOBAL_DEFAULTS, largeAmountUsd: 5000 };
    const r = await screenTransfer({ amountUsd: 1200, recipientName: 'Mom', transfersToday: 0, sourceCountry: 'GB', rules });
    expect(r.status).toBe('cleared'); // 1200 < 5000
  });
  it('watchlistExtra blocks a name absent from the global list', async () => {
    const rules = { ...GLOBAL_DEFAULTS, watchlistExtra: ['corridor villain'] };
    const r = await screenTransfer({ amountUsd: 200, recipientName: 'Corridor Villain', transfersToday: 0, sourceCountry: 'GB', rules });
    expect(r.status).toBe('blocked');
  });
  it('a lowered velocityLimit moves the flag boundary', async () => {
    const rules = { ...GLOBAL_DEFAULTS, velocityLimit: 1 };
    const r = await screenTransfer({ amountUsd: 200, recipientName: 'Mom', transfersToday: 1, sourceCountry: 'GB', rules });
    expect(r.status).toBe('flagged');
  });
  it('an injected screener is used in place of the default', async () => {
    const screener = new MockSanctionsScreener(['only this name']);
    const r = await screenTransfer({ amountUsd: 200, recipientName: 'only this name', transfersToday: 0, sourceCountry: 'GB', screener });
    expect(r.status).toBe('blocked');
  });
});

describe('screenTransfer — watchlist attribution (regression: wrong party named)', () => {
  // Bug: when only the sender was watchlisted, reasons still said "Recipient is on the
  // compliance watchlist." — the reasons array was always hardcoded to "Recipient".
  it('attributes the block to Sender when only the sender matched', async () => {
    const r = await screenTransfer({
      amountUsd: 200,
      recipientName: 'Mom',        // NOT on watchlist
      transfersToday: 0,
      sourceCountry: 'US',
      senderName: 'John Doe',      // IS on default WATCHLIST
    });
    expect(r.status).toBe('blocked');
    expect(r.reasons[0]).toMatch(/sender/i);
    expect(r.reasons[0]).not.toMatch(/recipient/i);
  });

  it('attributes the block to Recipient when only the recipient matched', async () => {
    const r = await screenTransfer({
      amountUsd: 200,
      recipientName: 'John Doe',   // IS on watchlist
      transfersToday: 0,
      sourceCountry: 'US',
      senderName: 'Clean Person',  // NOT on watchlist
    });
    expect(r.status).toBe('blocked');
    expect(r.reasons[0]).toMatch(/recipient/i);
    expect(r.reasons[0]).not.toMatch(/sender/i);
  });

  it('lists both reasons when both sender and recipient matched', async () => {
    const r = await screenTransfer({
      amountUsd: 200,
      recipientName: 'John Doe',   // on watchlist
      transfersToday: 0,
      sourceCountry: 'US',
      senderName: 'John Doe',      // also on watchlist
    });
    expect(r.status).toBe('blocked');
    expect(r.reasons).toHaveLength(2);
    expect(r.reasons.some((x) => /recipient/i.test(x))).toBe(true);
    expect(r.reasons.some((x) => /sender/i.test(x))).toBe(true);
  });
});

describe('screenTransfer — sender screening (KYC, same SanctionsScreener seam)', () => {
  it('dormant: no senderName reproduces today\'s recipient-only cleared result', async () => {
    const r = await screenTransfer({ amountUsd: 200, recipientName: 'Mom', transfersToday: 0, sourceCountry: 'US' });
    expect(r.status).toBe('cleared');
    expect(r.reasons).toEqual([]);
  });
  it('a watchlisted SENDER name blocks (screened via the seam)', async () => {
    const r = await screenTransfer({
      amountUsd: 200, recipientName: 'Mom', transfersToday: 0, sourceCountry: 'US',
      senderName: 'John Doe',     // on the default WATCHLIST
    });
    expect(r.status).toBe('blocked');
  });
  it('clean sender + watchlisted recipient still blocks (recipient path unchanged)', async () => {
    const r = await screenTransfer({
      amountUsd: 200, recipientName: 'John Doe', transfersToday: 0, sourceCountry: 'US',
      senderName: 'Clean Person',
    });
    expect(r.status).toBe('blocked');
  });
  it('clean sender + clean recipient clears (no false positive)', async () => {
    const r = await screenTransfer({
      amountUsd: 200, recipientName: 'Mom', transfersToday: 0, sourceCountry: 'US',
      senderName: 'Clean Person',
    });
    expect(r.status).toBe('cleared');
  });
  it('an injected screener is used for the sender too', async () => {
    const screener = new MockSanctionsScreener(['only this sender']);
    const r = await screenTransfer({
      amountUsd: 200, recipientName: 'Mom', transfersToday: 0, sourceCountry: 'GB',
      senderName: 'Only This Sender', screener,
    });
    expect(r.status).toBe('blocked');
  });
});

// ── Program-Fix 14: screening evidence (compliance-07) ──────────────────────
import { WATCHLIST } from '@/lib/compliance-config';
import { inputHash } from '@/lib/sanctions/evidence';
import { SanctionsListUnavailableError } from '@/lib/sanctions/list-screener';
import type { SanctionsScreener } from '@/lib/providers/sanctions-provider';

describe('screenTransfer — evidence', () => {
  it('a cleared screen carries { listSource, listVersion, listHash, screenedAt, decision, parties }', async () => {
    const r = await screenTransfer({ amountUsd: 200, recipientName: 'Mom', transfersToday: 0, sourceCountry: 'US', senderName: 'Clean Person' });
    expect(r.status).toBe('cleared');
    expect(r.evidence).toMatchObject({
      listSource: 'mock-watchlist',
      listVersion: 'static',
      decision: 'clear',
      parties: [
        { role: 'recipient', inputHash: inputHash('Mom'), matched: false, matchScore: 0 },
        { role: 'sender', inputHash: inputHash('Clean Person'), matched: false, matchScore: 0 },
      ],
    });
    expect(r.evidence!.listHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isNaN(Date.parse(r.evidence!.screenedAt))).toBe(false);
  });

  it('a blocked screen: decision "match", parties[0] is the recipient with score 1 and a mock:<index> entry id', async () => {
    const r = await screenTransfer({ amountUsd: 200, recipientName: 'John  Doe', transfersToday: 0, sourceCountry: 'US' });
    expect(r.status).toBe('blocked');
    expect(r.evidence!.decision).toBe('match');
    expect(r.evidence!.parties).toEqual([
      { role: 'recipient', inputHash: inputHash('John  Doe'), matched: true, matchScore: 1, matchedEntryId: 'mock:0' },
    ]);
  });

  it('a velocity/amount flag is not a sanctions decision (decision stays "clear")', async () => {
    const r = await screenTransfer({ amountUsd: 1500, recipientName: 'Mom', transfersToday: 0, sourceCountry: 'US' });
    expect(r.status).toBe('flagged');
    expect(r.evidence!.decision).toBe('clear');
  });

  it('NO name anywhere in evidence: no list entry, no input name, no matchedName', async () => {
    const r = await screenTransfer({ amountUsd: 200, recipientName: 'John Doe', transfersToday: 0, sourceCountry: 'US', senderName: 'Jane Roe' });
    const json = JSON.stringify(r.evidence).toLowerCase();
    for (const entry of WATCHLIST) {
      for (const word of entry.split(' ')) expect(json).not.toContain(word);
    }
    expect(json).not.toContain('matchedname');
  });

  it('a possible (fuzzy) match → flagged with a generic reason and decision "possible_match"', async () => {
    const screener: SanctionsScreener = {
      listInfo: () => ({ source: 'test-list', version: 'v1', hash: 'h' }),
      screen: async () => ({ matched: false, possibleMatch: true, matchScore: 0.93, entryId: 'sdn:1' }),
    };
    const r = await screenTransfer({ amountUsd: 200, recipientName: 'Mom', transfersToday: 0, sourceCountry: 'US', screener });
    expect(r.status).toBe('flagged');
    expect(r.reasons.join(' ')).not.toMatch(/sanction|watchlist|mom/i);
    expect(r.evidence).toMatchObject({ decision: 'possible_match', listSource: 'test-list', listVersion: 'v1' });
    expect(r.evidence!.parties[0]).toMatchObject({ matched: false, matchScore: 0.93, matchedEntryId: 'sdn:1' });
  });

  it('an exact hit wins over a possible match (blocked)', async () => {
    const screener: SanctionsScreener = {
      listInfo: () => ({ source: 't', version: 'v', hash: 'h' }),
      screen: async ({ name }) => name === 'A'
        ? { matched: true, matchScore: 1, entryId: 'sdn:2' }
        : { matched: false, possibleMatch: true, matchScore: 0.95, entryId: 'sdn:3' },
    };
    const r = await screenTransfer({ amountUsd: 200, recipientName: 'B', senderName: 'A', transfersToday: 0, sourceCountry: 'US', screener });
    expect(r.status).toBe('blocked');
    expect(r.evidence!.decision).toBe('match');
  });

  it('a list that cannot load FAILS CLOSED: flagged, decision "list_unavailable" (never cleared, never a throw)', async () => {
    const screener: SanctionsScreener = {
      listInfo: () => ({ source: 'ofac-sdn', version: 'unavailable', hash: '' }),
      screen: async () => { throw new SanctionsListUnavailableError(); },
    };
    const r = await screenTransfer({ amountUsd: 10, recipientName: 'Mom', transfersToday: 0, sourceCountry: 'US', screener });
    expect(r.status).toBe('flagged');
    expect(r.evidence).toMatchObject({ decision: 'list_unavailable', listSource: 'ofac-sdn' });
    expect(r.evidence!.parties[0]).toMatchObject({ role: 'recipient', matched: false });
  });

  it('any OTHER screener error still propagates (register_seller fails closed on it)', async () => {
    const screener: SanctionsScreener = {
      listInfo: () => ({ source: 't', version: 'v', hash: 'h' }),
      screen: async () => { throw new Error('boom'); },
    };
    await expect(screenTransfer({ amountUsd: 10, recipientName: 'Mom', transfersToday: 0, sourceCountry: 'US', screener })).rejects.toThrow('boom');
  });
});

// ── Fix pack 2 T2 (R02): requireLiveList — a real-money screen clears only on
// a live OFAC SDN list; otherwise it is held (flagged, LIST_UNAVAILABLE first).
import { afterEach } from 'vitest';
import {
  LIST_UNAVAILABLE_REASON,
  POSSIBLE_MATCH_REASON,
  LARGE_AMOUNT_REASON,
  VELOCITY_REASON,
  RECIPIENT_WATCHLIST_REASON,
} from '@/lib/compliance-config';
import { primeOfacSource, restoreOfacSource } from './helpers-sanctions';

describe('screenTransfer — requireLiveList (fix pack 2 R02)', () => {
  const original = process.env.SANCTIONS_LIST;
  afterEach(() => restoreOfacSource(original));
  const HOUR = 3_600_000;
  const base = { amountUsd: 200, recipientName: 'Mom', transfersToday: 0, sourceCountry: 'US' as const };

  it('mock + clean -> flagged [LIST_UNAVAILABLE], list_unavailable, not_live', async () => {
    const r = await screenTransfer({ ...base, requireLiveList: true });
    expect(r.status).toBe('flagged');
    expect(r.reasons).toEqual([LIST_UNAVAILABLE_REASON]);
    expect(r.evidence).toMatchObject({ decision: 'list_unavailable', listFitness: 'not_live', listSource: 'mock-watchlist' });
  });

  it('mock + \'John Doe\' -> blocked, block reasons only', async () => {
    const r = await screenTransfer({ ...base, amountUsd: 5000, recipientName: 'John Doe', requireLiveList: true });
    expect(r.status).toBe('blocked');
    expect(r.reasons).toEqual([RECIPIENT_WATCHLIST_REASON]);
    expect(r.evidence).toMatchObject({ decision: 'match', listFitness: 'not_live' });
  });

  it('fresh source -> cleared, live', async () => {
    primeOfacSource({ checkedAgoMs: HOUR });
    const now = new Date();
    const r = await screenTransfer({ ...base, requireLiveList: true, now });
    expect(r.status).toBe('cleared');
    expect(r.reasons).toEqual([]);
    expect(r.evidence).toMatchObject({ decision: 'clear', listFitness: 'live', listSource: 'ofac-sdn' });
    expect(r.evidence!.listCheckedAt).toBeDefined();
    expect(r.evidence!.listBaseHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.evidence!.listBaseHash).not.toBe(r.evidence!.listHash);
  });

  it('stale source -> flagged, stale, listCheckedAt set', async () => {
    primeOfacSource({ checkedAgoMs: 37 * HOUR });
    const r = await screenTransfer({ ...base, requireLiveList: true });
    expect(r.status).toBe('flagged');
    expect(r.reasons).toEqual([LIST_UNAVAILABLE_REASON]);
    expect(r.evidence).toMatchObject({ decision: 'list_unavailable', listFitness: 'stale' });
    expect(Date.now() - Date.parse(r.evidence!.listCheckedAt!)).toBeGreaterThan(36 * HOUR);
  });

  it('`now` decides the age: a list live now is stale 37 h later', async () => {
    primeOfacSource({ checkedAgoMs: HOUR });
    const later = new Date(Date.now() + 37 * HOUR);
    const r = await screenTransfer({ ...base, requireLiveList: true, now: later });
    expect(r.status).toBe('flagged');
    expect(r.evidence!.listFitness).toBe('stale');
  });

  it('possible match -> [LIST_UNAVAILABLE, POSSIBLE_MATCH], possible_match', async () => {
    const screener: SanctionsScreener = {
      listInfo: () => ({ source: 'mock-watchlist', version: 'static', hash: 'h' }),
      screen: async () => ({ matched: false, possibleMatch: true, matchScore: 0.93, entryId: 'mock:1' }),
    };
    const r = await screenTransfer({ ...base, screener, requireLiveList: true });
    expect(r.status).toBe('flagged');
    expect(r.reasons).toEqual([LIST_UNAVAILABLE_REASON, POSSIBLE_MATCH_REASON]);
    expect(r.evidence).toMatchObject({ decision: 'possible_match', listFitness: 'not_live' });
  });

  it('amount >= 1000 -> [LIST_UNAVAILABLE, LARGE]', async () => {
    const r = await screenTransfer({ ...base, amountUsd: 1000, requireLiveList: true });
    expect(r.status).toBe('flagged');
    expect(r.reasons).toEqual([LIST_UNAVAILABLE_REASON, LARGE_AMOUNT_REASON]);
  });

  it('throw branch keeps LARGE and VELOCITY', async () => {
    const screener: SanctionsScreener = {
      listInfo: () => ({ source: 'ofac-sdn', version: 'unavailable', hash: '' }),
      screen: async () => { throw new SanctionsListUnavailableError(); },
    };
    for (const requireLiveList of [undefined, true]) {
      const r = await screenTransfer({ ...base, amountUsd: 1500, transfersToday: 5, screener, requireLiveList });
      expect(r.status).toBe('flagged');
      expect(r.reasons).toEqual([LIST_UNAVAILABLE_REASON, LARGE_AMOUNT_REASON, VELOCITY_REASON]);
      expect(r.evidence).toMatchObject({ decision: 'list_unavailable', listFitness: 'not_live' });
    }
    const small = await screenTransfer({ ...base, screener });
    expect(small.reasons).toEqual([LIST_UNAVAILABLE_REASON]);
  });

  it('without requireLiveList: clear/match/possible/amount results equal today\'s (demo pin)', async () => {
    const possible: SanctionsScreener = {
      listInfo: () => ({ source: 'mock-watchlist', version: 'static', hash: 'h' }),
      screen: async () => ({ matched: false, possibleMatch: true, matchScore: 0.93, entryId: 'mock:1' }),
    };
    const cases: Array<[Parameters<typeof screenTransfer>[0], string, string[]]> = [
      [base, 'cleared', []],
      [{ ...base, recipientName: 'John Doe' }, 'blocked', [RECIPIENT_WATCHLIST_REASON]],
      [{ ...base, screener: possible }, 'flagged', [POSSIBLE_MATCH_REASON]],
      [{ ...base, amountUsd: 1500 }, 'flagged', [LARGE_AMOUNT_REASON]],
      [{ ...base, requireLiveList: false }, 'cleared', []],
    ];
    for (const [input, status, reasons] of cases) {
      const r = await screenTransfer(input);
      expect(r.status).toBe(status);
      expect(r.reasons).toEqual(reasons);
      expect(r.evidence!.decision).not.toBe('list_unavailable');
    }
    // A stale OFAC list still clears a demo screen.
    primeOfacSource({ checkedAgoMs: 40 * HOUR });
    const stale = await screenTransfer(base);
    expect(stale.status).toBe('cleared');
    expect(stale.evidence).toMatchObject({ decision: 'clear', listFitness: 'stale' });
  });
});
