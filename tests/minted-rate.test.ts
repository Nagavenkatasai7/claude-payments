import { describe, it, expect, vi } from 'vitest';
import {
  checkMintedRate,
  DEFAULT_MINTED_RATE_LOCK,
  MINTED_RATE_DRIFT_TOLERANCE,
  mintedRateLockFor,
  mintedRateVerdict,
} from '@/lib/minted-rate';
import { FX_MAX_AGE_MS, RateUnavailableError, type FxRates } from '@/lib/rate';
import type { Transfer } from '@/lib/types';

// Step 0 FX-2: the pay-time rate check for an EXISTING transfer. Relative
// times only: every case anchors on its own `now`.
const NOW = Date.now();
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function row(o: Partial<Transfer> = {}): Transfer {
  return {
    id: 't_1', phone: '15550000001', amountUsd: 100, feeUsd: 0, totalChargeUsd: 100, fxRate: 90,
    amountInr: 9000, recipientName: 'R', recipientPhone: '919000000000', payoutMethod: 'bank',
    payoutDestination: '', fundingMethod: 'bank_transfer', complianceStatus: 'cleared', complianceReasons: [],
    status: 'awaiting_payment', createdAt: iso(NOW - 2 * HOUR), sourceCountry: 'US', sourceCurrency: 'USD',
    destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'default', amountSource: 100, feeSource: 0,
    totalChargeSource: 100, ...o,
  };
}

const live = (toInr: number, o: Partial<FxRates> = {}): FxRates => ({
  toInr, toUsd: 1, fetchedAt: NOW, source: 'live', asOf: iso(NOW).slice(0, 10), ...o,
});

describe('mintedRateVerdict (pure)', () => {
  it('within the lock (fx anchor) → OK and asks for no rate', () => {
    const t = row({ createdAt: iso(NOW - 3 * HOUR), fxFetchedAt: iso(NOW - 30 * 60_000) });
    expect(mintedRateVerdict(t, NOW, null)).toEqual({ ok: true });
  });

  it('exactly at the lock boundary is still OK; one ms past it needs a rate', () => {
    const t = row({ fxFetchedAt: iso(NOW - FX_MAX_AGE_MS) });
    expect(mintedRateVerdict(t, NOW, null)).toEqual({ ok: true });
    expect(mintedRateVerdict(t, NOW + 1, null)).toEqual({ needsRate: true });
  });

  it('a NULL fxFetchedAt (pre-0030 row) anchors on createdAt', () => {
    expect(mintedRateVerdict(row({ createdAt: iso(NOW - 30 * 60_000) }), NOW, null)).toEqual({ ok: true });
    expect(mintedRateVerdict(row({ createdAt: iso(NOW - 2 * HOUR) }), NOW, null)).toEqual({ needsRate: true });
  });

  it('a routed row past the lock → routed_stale, with no rate needed', () => {
    const t = row({ settlementPartnerId: 'p_rail' });
    expect(mintedRateVerdict(t, NOW, null)).toEqual({ ok: false, reason: 'routed_stale' });
    expect(mintedRateVerdict(t, NOW, 90)).toEqual({ ok: false, reason: 'routed_stale' });
  });

  it('drift 0.4% passes and 0.6% refuses, in BOTH directions', () => {
    const t = row({ fxRate: 90 });
    expect(MINTED_RATE_DRIFT_TOLERANCE).toBe(0.005);
    expect(mintedRateVerdict(t, NOW, 90 * 1.004)).toEqual({ ok: true });
    expect(mintedRateVerdict(t, NOW, 90 / 1.004)).toEqual({ ok: true });
    expect(mintedRateVerdict(t, NOW, 90 * 1.006)).toMatchObject({ ok: false, reason: 'drift' });
    expect(mintedRateVerdict(t, NOW, 90 / 1.006)).toMatchObject({ ok: false, reason: 'drift' });
  });

  it('a refusal carries the drift in basis points (an integer)', () => {
    expect(mintedRateVerdict(row({ fxRate: 90 }), NOW, 91.8)).toEqual({ ok: false, reason: 'drift', driftBps: 196 });
  });

  it('honours a custom lock { lockMs, anchor: "created" } (the Step 3 hook)', () => {
    const t = row({ createdAt: iso(NOW - 5 * HOUR), fxFetchedAt: iso(NOW - 60_000) });
    expect(mintedRateVerdict(t, NOW, null, { lockMs: 6 * HOUR, anchor: 'created' })).toEqual({ ok: true });
    expect(mintedRateVerdict(t, NOW, null, { lockMs: 4 * HOUR, anchor: 'created' })).toEqual({ needsRate: true });
  });

  it('the default resolver returns the FX_MAX_AGE_MS lock anchored on the fx fetch', () => {
    expect(DEFAULT_MINTED_RATE_LOCK).toEqual({ lockMs: FX_MAX_AGE_MS, anchor: 'fx' });
    expect(mintedRateLockFor(row())).toEqual(DEFAULT_MINTED_RATE_LOCK);
  });
});

describe('checkMintedRate (fetches only when the lock has passed)', () => {
  const deps = (src: FxRates, dest?: FxRates) => ({
    getFxRates: vi.fn(async () => src),
    getDestinationRates: vi.fn(async () => dest),
  });

  it('within the lock → OK with NO rate fetch', async () => {
    const d = deps(live(90));
    expect(await checkMintedRate(row({ fxFetchedAt: iso(NOW - 60_000) }), NOW, d)).toEqual({ ok: true });
    expect(d.getFxRates).not.toHaveBeenCalled();
    expect(d.getDestinationRates).not.toHaveBeenCalled();
  });

  it('routed past the lock → routed_stale with NO rate fetch', async () => {
    const d = deps(live(90));
    expect(await checkMintedRate(row({ settlementPartnerId: 'p_rail' }), NOW, d)).toEqual({ ok: false, reason: 'routed_stale' });
    expect(d.getFxRates).not.toHaveBeenCalled();
  });

  it('past the lock: compares with the current cross-rate (INR and a non-INR destination)', async () => {
    expect(await checkMintedRate(row({ fxRate: 90 }), NOW, deps(live(90.2)))).toEqual({ ok: true });
    expect(await checkMintedRate(row({ fxRate: 90 }), NOW, deps(live(91)))).toMatchObject({ ok: false, reason: 'drift' });
    // USD→GBP: cross = src.toUsd / dest.toUsd = 1 / 1.25 = 0.8.
    const gbp = row({ fxRate: 0.8, destinationCountry: 'GB', destinationCurrency: 'GBP' });
    const d = deps(live(90), live(110, { toUsd: 1.25 }));
    expect(await checkMintedRate(gbp, NOW, d)).toEqual({ ok: true });
    expect(d.getDestinationRates).toHaveBeenCalledWith('GBP');
  });

  it('FX unavailable → RateUnavailableError propagates (the route answers 503)', async () => {
    const d = { getFxRates: vi.fn(async () => { throw new RateUnavailableError('fetch_failed', 'USD'); }), getDestinationRates: vi.fn() };
    await expect(checkMintedRate(row(), NOW, d)).rejects.toBeInstanceOf(RateUnavailableError);
  });

  it('a FROZEN feed refuses (stale_fixing) even with FX_FIXING_GATE_ENABLED off (N12)', async () => {
    // Drift ≈ 0 against a frozen mid would otherwise let a days-old row pay.
    const frozen = live(90, { asOf: '2016-01-04' });
    await expect(checkMintedRate(row({ fxRate: 90 }), NOW, deps(frozen))).rejects.toMatchObject({ reason: 'stale_fixing' });
  });

  it('a stale DESTINATION leg refuses too', async () => {
    const gbp = row({ fxRate: 0.8, destinationCountry: 'GB', destinationCurrency: 'GBP' });
    const d = deps(live(90), live(110, { toUsd: 1.25, fetchedAt: NOW - FX_MAX_AGE_MS - 1 }));
    await expect(checkMintedRate(gbp, NOW, d)).rejects.toMatchObject({ reason: 'stale' });
  });
});
