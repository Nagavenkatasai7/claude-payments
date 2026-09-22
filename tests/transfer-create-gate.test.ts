import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { createStore } from '@/lib/store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createTransfer, type CreateTransferInput } from '@/lib/transfer-create';
import { FX_MAX_AGE_MS, RateUnavailableError, resetRateCacheForTests } from '@/lib/rate';

// Stub FX — createTransfer calls getFxRates; a real network fetch here makes
// the test flaky (and rate-limited) under repeated runs.
beforeEach(() => {
  resetRateCacheForTests();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ rates: { INR: 85.2, USD: 1 } }),
  }));
});
afterEach(() => vi.restoreAllMocks());

function baseInput(over: Partial<CreateTransferInput> = {}): CreateTransferInput {
  return {
    phone: '15551230000',
    recipientName: 'R',
    recipientPhone: '910000',
    payoutMethod: 'bank',
    payoutDestination: 'acct',
    fundingMethod: 'bank_transfer',
    amountSource: 100,
    sourceCurrency: 'USD',
    partnerId: 'default',
    senderKycStatus: 'verified',
    ...over,
  };
}

async function stores() {
  const r = fakeRedis();
  const db = await freshDb(); // truncates + reseeds 'default' partner
  const store = createStore(r, db);
  return [store, createPartnerStore(db), createMonthlyVolumeStore(store)] as const;
}

describe('createTransfer KYC backstop (Phase 3)', () => {
  it('throws kyc_required when senderKycStatus is not "verified"', async () => {
    const [s, p, m] = await stores();
    await expect(createTransfer(s, p, m, baseInput({ senderKycStatus: 'grandfathered' }))).rejects.toThrow(/kyc_required/);
    const [s2, p2, m2] = await stores();
    await expect(createTransfer(s2, p2, m2, baseInput({ senderKycStatus: 'not_started' }))).rejects.toThrow(/kyc_required/);
  });

  it('proceeds for a verified sender', async () => {
    const [s, p, m] = await stores();
    const t = await createTransfer(s, p, m, baseInput());
    expect(t.id).toBeTruthy();
  });
});

describe('createTransfer WL1 delegated-KYC gate (requiresKyc)', () => {
  it('requiresKyc absent ⇒ still throws for an unverified sender (default unchanged)', async () => {
    const [s, p, m] = await stores();
    await expect(
      createTransfer(s, p, m, baseInput({ senderKycStatus: 'not_started' })),
    ).rejects.toThrow(/kyc_required/);
  });

  it('requiresKyc:false (delegated) mints even when the sender is NOT verified', async () => {
    const [s, p, m] = await stores();
    const t = await createTransfer(
      s,
      p,
      m,
      baseInput({ senderKycStatus: 'not_started', requiresKyc: false }),
    );
    expect(t.id).toBeTruthy();
    expect(t.status).toBe('awaiting_payment');
  });

  it('SANCTIONS SURVIVE DELEGATION: a watchlisted recipient is still blocked with requiresKyc:false', async () => {
    const [s, p, m] = await stores();
    const t = await createTransfer(
      s,
      p,
      m,
      baseInput({
        senderKycStatus: 'not_started',
        requiresKyc: false,
        recipientName: 'John Doe', // on WATCHLIST
      }),
    );
    expect(t.complianceStatus).toBe('blocked');
    expect(t.status).toBe('blocked');
  });
});

describe('Task 9: createTransfer refuses when FX is unavailable', () => {
  it('re-quote path: Frankfurter down + nothing cached ⇒ RateUnavailableError, nothing minted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
    const [s, p, m] = await stores();
    await expect(createTransfer(s, p, m, baseInput())).rejects.toBeInstanceOf(RateUnavailableError);
    expect(await s.getTransferCount('default', '15551230000')).toBe(0);
  });

  it('an INR destination never fetches the unused INR→USD leg', async () => {
    const [s, p, m] = await stores();
    await createTransfer(s, p, m, baseInput());
    const urls = vi.mocked(global.fetch).mock.calls.map(([u]) => String(u));
    expect(urls).toEqual(['https://api.frankfurter.dev/v1/latest?from=USD&to=INR']);
  });
});

describe('Task 9: an approved quote is honored verbatim only while its rate is inside the ceiling', () => {
  const override = (fxFetchedAt?: number): NonNullable<CreateTransferInput['quote']> => ({
    amountUsd: 100, feeUsd: 0, totalChargeUsd: 100, fxRate: 95.82, amountInr: 9582,
    amountSource: 100, feeSource: 0, totalChargeSource: 100, fxFetchedAt,
  });

  it('honors a fresh override VERBATIM without dialing FX (claim-first re-mints never re-price)', async () => {
    const [s, p, m] = await stores();
    const t = await createTransfer(s, p, m, baseInput({ quote: override(Date.now() - 60_000) }));
    expect(t.fxRate).toBe(95.82);
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled();
  });

  it('refuses an override whose rate is older than the ceiling — and never falls back to a re-quote', async () => {
    const [s, p, m] = await stores();
    await expect(
      createTransfer(s, p, m, baseInput({ quote: override(Date.now() - FX_MAX_AGE_MS - 1) })),
    ).rejects.toMatchObject({ name: 'RateUnavailableError', reason: 'stale_quote' });
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled();
    expect(await s.getTransferCount('default', '15551230000')).toBe(0);
  });

  it('an override without fxFetchedAt (pre-Task-9 draft, B2B locked quote) is honored as before', async () => {
    const [s, p, m] = await stores();
    const t = await createTransfer(s, p, m, baseInput({ quote: override(undefined) }));
    expect(t.fxRate).toBe(95.82);
  });
});
