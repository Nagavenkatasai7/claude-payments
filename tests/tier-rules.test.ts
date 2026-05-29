import { describe, it, expect } from 'vitest';
import {
  deriveTier,
  evaluateCap,
  T0_DAILY_CAP_CENTS,
  T1_DAILY_CAP_CENTS,
  OBSERVATION_WINDOW_MS,
  EDD_THRESHOLD_CENTS,
  evaluateEdd,
  evaluateEddForTransfer,
} from '@/lib/tier-rules';
import type { Customer } from '@/lib/types';

function customer(overrides: Partial<Customer> & { firstSeenAt: string }): Customer {
  return {
    senderPhone: '15551234567',
    kycStatus: 'not_started',
    senderCountry: 'US',
    partnerId: 'default',
    createdAt: overrides.firstSeenAt,
    updatedAt: overrides.firstSeenAt,
    ...overrides,
  };
}

const SIGN_UP = new Date('2026-05-20T12:00:00Z');
const DAY_2  = new Date('2026-05-21T12:00:00Z');
const DAY_3  = new Date('2026-05-22T12:00:00Z');
const DAY_4  = new Date('2026-05-23T12:00:01Z'); // 3 days + 1 second
const EXACT_3_DAYS = new Date(SIGN_UP.getTime() + OBSERVATION_WINDOW_MS); // exact boundary

describe('deriveTier', () => {
  it('returns T0 during the 3-day window regardless of KYC status', () => {
    expect(deriveTier(customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'not_started' }), DAY_2)).toBe('T0');
    expect(deriveTier(customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'verified' }), DAY_2)).toBe('T0');
    expect(deriveTier(customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'pending' }), DAY_2)).toBe('T0');
    expect(deriveTier(customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'grandfathered' }), DAY_2)).toBe('T0');
  });

  it('returns Suspended any time kycStatus is rejected (even in window)', () => {
    expect(deriveTier(customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'rejected' }), DAY_2)).toBe('Suspended');
    expect(deriveTier(customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'rejected' }), DAY_4)).toBe('Suspended');
  });

  it('returns T1 on day 4+ for verified or grandfathered customers', () => {
    expect(deriveTier(customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'verified' }), DAY_4)).toBe('T1');
    expect(deriveTier(customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'grandfathered' }), DAY_4)).toBe('T1');
  });

  it('returns Suspended on day 4+ for unverified customers', () => {
    expect(deriveTier(customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'not_started' }), DAY_4)).toBe('Suspended');
    expect(deriveTier(customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'pending' }), DAY_4)).toBe('Suspended');
  });

  it('exact-3-day-boundary is OUT of window (T0 ends, T1 or Suspended begins)', () => {
    // exact ageMs === OBSERVATION_WINDOW_MS → in_window = false
    expect(deriveTier(customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'verified' }), EXACT_3_DAYS)).toBe('T1');
    expect(deriveTier(customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'pending' }), EXACT_3_DAYS)).toBe('Suspended');
  });
});

describe('evaluateCap', () => {
  it('T0 customer with no spending today + small request → within cap', () => {
    const c = customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'pending' });
    const r = evaluateCap(c, DAY_2, 0, 10_000); // $100 requested
    expect(r.withinCap).toBe(true);
    expect(r.tier).toBe('T0');
    expect(r.dailyCapCents).toBe(T0_DAILY_CAP_CENTS);
    expect(r.todayUsedCents).toBe(0);
    expect(r.todayRemainingCents).toBe(T0_DAILY_CAP_CENTS);
    expect(r.dayOfWindow).toBe(2);
  });

  it('T0 customer over the per-transfer cap', () => {
    const c = customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'pending' });
    const r = evaluateCap(c, DAY_2, 0, 60_000); // $600
    expect(r.withinCap).toBe(false);
    expect(r.reason).toBe('over_per_transfer_cap');
  });

  it('T0 customer over the daily cap (cumulative)', () => {
    const c = customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'pending' });
    const r = evaluateCap(c, DAY_2, 30_000, 30_000); // $300 already, requesting $300 more = $600
    expect(r.withinCap).toBe(false);
    expect(r.reason).toBe('over_daily_cap');
    expect(r.todayRemainingCents).toBe(20_000); // $200 left
  });

  it('T0 customer at exactly the daily cap → within', () => {
    const c = customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'pending' });
    const r = evaluateCap(c, DAY_2, 30_000, 20_000); // $300 + $200 = $500 exactly
    expect(r.withinCap).toBe(true);
  });

  it('T1 customer can send up to the higher cap', () => {
    const c = customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'verified' });
    const r = evaluateCap(c, DAY_4, 0, 200_000); // $2,000
    expect(r.withinCap).toBe(true);
    expect(r.tier).toBe('T1');
    expect(r.dailyCapCents).toBe(T1_DAILY_CAP_CENTS);
  });

  it('Suspended (day 4 unverified) → not within, reason = verification_required_after_window', () => {
    const c = customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'pending' });
    const r = evaluateCap(c, DAY_4, 0, 1_000);
    expect(r.withinCap).toBe(false);
    expect(r.tier).toBe('Suspended');
    expect(r.reason).toBe('verification_required_after_window');
    expect(r.dailyCapCents).toBe(0);
  });

  it('Suspended (rejected) → not within, reason = verification_rejected', () => {
    const c = customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'rejected' });
    const r = evaluateCap(c, DAY_2, 0, 1_000);
    expect(r.withinCap).toBe(false);
    expect(r.reason).toBe('verification_rejected');
  });

  it('zero-request returns within=true (status-only check)', () => {
    const c = customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'pending' });
    const r = evaluateCap(c, DAY_2, 0, 0);
    expect(r.withinCap).toBe(true);
    expect(r.todayRemainingCents).toBe(T0_DAILY_CAP_CENTS);
  });

  it('dayOfWindow is 1 on signup day, 2 on day 2, 3 on day 3', () => {
    const c = customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'pending' });
    expect(evaluateCap(c, SIGN_UP, 0, 0).dayOfWindow).toBe(1);
    expect(evaluateCap(c, DAY_2, 0, 0).dayOfWindow).toBe(2);
    expect(evaluateCap(c, DAY_3, 0, 0).dayOfWindow).toBe(3);
  });

  it('dayOfWindow is undefined for T1 and Suspended', () => {
    const verified = customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'verified' });
    expect(evaluateCap(verified, DAY_4, 0, 0).dayOfWindow).toBeUndefined();
    const suspended = customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'rejected' });
    expect(evaluateCap(suspended, DAY_2, 0, 0).dayOfWindow).toBeUndefined();
  });
});

describe('evaluateEdd (cumulative $3k trigger)', () => {
  it('exports EDD_THRESHOLD_CENTS = 300_000 ($3,000)', () => {
    expect(EDD_THRESHOLD_CENTS).toBe(300_000);
  });
  it('below threshold → not required (dormant)', () => {
    expect(evaluateEdd(0, 20_000).eddRequired).toBe(false);        // single $200 send
    expect(evaluateEdd(250_000, 49_000).eddRequired).toBe(false);  // 2,500 + 490 = 2,990
  });
  it('exactly at $3,000 → required (>= inclusive)', () => {
    expect(evaluateEdd(0, 300_000).eddRequired).toBe(true);
    expect(evaluateEdd(240_000, 60_000).eddRequired).toBe(true);   // 2,400 + 600 = 3,000
  });
  it('cumulative crossing catches structuring (250k month + 60k send)', () => {
    expect(evaluateEdd(250_000, 60_000).eddRequired).toBe(true);   // 3,100
  });
  it('surfaces month/requested/threshold for messaging', () => {
    const e = evaluateEdd(250_000, 60_000);
    expect(e).toEqual({
      eddRequired: true, monthUsedCents: 250_000,
      requestedCents: 60_000, thresholdCents: 300_000,
    });
  });
});

describe('evaluateEddForTransfer (flag-only, never block)', () => {
  it('flags when required AND fields absent', () => {
    expect(evaluateEddForTransfer({ monthUsedCents: 250_000, requestedCents: 60_000, eddFieldsPresent: false }))
      .toEqual({ eddRequired: true, flagReason: 'edd_required' });
  });
  it('no flag when required but fields present (sticky profile satisfies it)', () => {
    expect(evaluateEddForTransfer({ monthUsedCents: 250_000, requestedCents: 60_000, eddFieldsPresent: true }))
      .toEqual({ eddRequired: true });
  });
  it('no flag on the dormant path (not required)', () => {
    expect(evaluateEddForTransfer({ monthUsedCents: 0, requestedCents: 20_000, eddFieldsPresent: false }))
      .toEqual({ eddRequired: false });
  });
  it('never returns a block reason', () => {
    const r = evaluateEddForTransfer({ monthUsedCents: 500_000, requestedCents: 100_000, eddFieldsPresent: false });
    expect(r.flagReason).toBe('edd_required');
    expect(JSON.stringify(r)).not.toContain('block');
  });
});

describe('evaluateCap regression (EDD is orthogonal — cap math unchanged)', () => {
  it('a T1 verified customer still computes today\'s cap regardless of EDD', () => {
    const c = {
      senderPhone: '1', firstSeenAt: '2026-01-01T00:00:00Z', kycStatus: 'verified' as const,
      senderCountry: 'US' as const, partnerId: 'default', createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const ev = evaluateCap(c, new Date('2026-05-29T00:00:00Z'), 0, 100_000);
    expect(ev.tier).toBe('T1');
    expect(ev.dailyCapCents).toBe(299_900); // unchanged T1_DAILY_CAP_CENTS
  });
});
