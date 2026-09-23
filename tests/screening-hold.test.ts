import { describe, it, expect } from 'vitest';
import {
  isScreeningHold,
  isScreeningCustomerHold,
  canDecideCustomerKyc,
  screenTransfer,
  SCREENING_REASONS,
  POSSIBLE_MATCH_REASON,
  LIST_UNAVAILABLE_REASON,
  RECIPIENT_WATCHLIST_REASON,
  SENDER_WATCHLIST_REASON,
} from '@/lib/compliance';
import { AML_HOLD_REASON } from '@/lib/aml-hold';
import { SanctionsListUnavailableError } from '@/lib/sanctions/list-screener';
import type { SanctionsScreener } from '@/lib/providers/sanctions-provider';

// Program-Fix 43 follow-up: a hold whose reason comes from sanctions / name
// screening is PLATFORM-only to release. The predicate keys on the exported
// reason constants (never on copied copy), and the constants are exactly what
// screenTransfer writes.
describe('isScreeningHold', () => {
  it('SCREENING_REASONS is exactly the four screening-derived reasons', () => {
    expect([...SCREENING_REASONS].sort()).toEqual(
      [POSSIBLE_MATCH_REASON, LIST_UNAVAILABLE_REASON, RECIPIENT_WATCHLIST_REASON, SENDER_WATCHLIST_REASON].sort(),
    );
  });

  it.each([
    POSSIBLE_MATCH_REASON,
    LIST_UNAVAILABLE_REASON,
    RECIPIENT_WATCHLIST_REASON,
    SENDER_WATCHLIST_REASON,
  ])('a hold with the screening reason %j is a screening hold', (reason) => {
    expect(isScreeningHold({ complianceReasons: [reason] })).toBe(true);
  });

  it('a mixed hold (amount + screening) is a screening hold', () => {
    expect(isScreeningHold({ complianceReasons: ['Large transfer amount.', POSSIBLE_MATCH_REASON] })).toBe(true);
  });

  it('non-screening holds (amount, velocity, EDD, AML) are not screening holds', () => {
    expect(isScreeningHold({ complianceReasons: ['Large transfer amount.'] })).toBe(false);
    expect(isScreeningHold({ complianceReasons: ['High transfer velocity.', 'edd_required'] })).toBe(false);
    expect(isScreeningHold({ complianceReasons: [AML_HOLD_REASON] })).toBe(false);
  });

  it('fails CLOSED when the hold carries no reasons (unknown provenance)', () => {
    expect(isScreeningHold({ complianceReasons: [] })).toBe(true);
    expect(isScreeningHold({ complianceReasons: undefined as unknown as string[] })).toBe(true);
    expect(isScreeningHold({ complianceReasons: null as unknown as string[] })).toBe(true);
  });
});

describe('screenTransfer writes the exported screening reason constants', () => {
  const info = () => ({ source: 't', version: 'v', hash: 'h' });

  it('possible match ⇒ POSSIBLE_MATCH_REASON', async () => {
    const screener: SanctionsScreener = {
      listInfo: info,
      screen: async () => ({ matched: false, possibleMatch: true, matchScore: 0.93, entryId: 'sdn:1' }),
    };
    const r = await screenTransfer({ amountUsd: 10, recipientName: 'x', transfersToday: 0, sourceCountry: 'US', screener });
    expect(r.reasons).toEqual([POSSIBLE_MATCH_REASON]);
    expect(isScreeningHold({ complianceReasons: r.reasons })).toBe(true);
  });

  it('list unavailable ⇒ LIST_UNAVAILABLE_REASON', async () => {
    const screener: SanctionsScreener = {
      listInfo: () => ({ source: 'ofac-sdn', version: 'unavailable', hash: '' }),
      screen: async () => { throw new SanctionsListUnavailableError(); },
    };
    const r = await screenTransfer({ amountUsd: 10, recipientName: 'x', transfersToday: 0, sourceCountry: 'US', screener });
    expect(r.reasons).toEqual([LIST_UNAVAILABLE_REASON]);
  });

  it('exact matches ⇒ the recipient / sender watchlist reasons', async () => {
    const screener: SanctionsScreener = {
      listInfo: info,
      screen: async () => ({ matched: true, matchScore: 1, entryId: 'mock:0' }),
    };
    const r = await screenTransfer({
      amountUsd: 10, recipientName: 'x', senderName: 'y', transfersToday: 0, sourceCountry: 'US', screener,
    });
    expect(r.reasons).toEqual([RECIPIENT_WATCHLIST_REASON, SENDER_WATCHLIST_REASON]);
  });

  it('an amount-only flag is not a screening hold', async () => {
    const screener: SanctionsScreener = {
      listInfo: info,
      screen: async () => ({ matched: false, matchScore: 0 }),
    };
    const r = await screenTransfer({ amountUsd: 5000, recipientName: 'x', transfersToday: 0, sourceCountry: 'US', screener });
    expect(r.status).toBe('flagged');
    expect(isScreeningHold({ complianceReasons: r.reasons })).toBe(false);
  });
});

describe('isScreeningCustomerHold / canDecideCustomerKyc (Program-Fix 43 follow-up)', () => {
  const PLATFORM = { kind: 'platform' } as const;
  const PARTNER = { kind: 'partner', partnerId: 'p1' } as const;

  it('true only when a watchlist or PEP hit is recorded', () => {
    expect(isScreeningCustomerHold({ watchlistHit: true })).toBe(true);
    expect(isScreeningCustomerHold({ pepHit: true })).toBe(true);
    expect(isScreeningCustomerHold({})).toBe(false);
    expect(isScreeningCustomerHold({ watchlistHit: false, pepHit: false })).toBe(false);
  });

  it('platform staff may always decide; partner staff only when there is no screening hit', () => {
    expect(canDecideCustomerKyc(PLATFORM, { watchlistHit: true })).toBe(true);
    expect(canDecideCustomerKyc(PARTNER, { watchlistHit: true })).toBe(false);
    expect(canDecideCustomerKyc(PARTNER, { pepHit: true })).toBe(false);
    expect(canDecideCustomerKyc(PARTNER, {})).toBe(true);
  });
});
