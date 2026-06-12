import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTransfer, quoteOverrideFromDraft, recordBlockedAttempt } from '@/lib/transfer-create';
import { createStore } from '@/lib/store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { resetRateCacheForTests } from '@/lib/rate';

beforeEach(() => {
  resetRateCacheForTests();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85 } }) }),
  );
});
afterEach(() => vi.restoreAllMocks());

// One fresh Postgres handle per test, shared by every pg-backed store in it
// (freshDb truncates per call and reseeds the 'default' partner).
async function makeStores() {
  const redis = fakeRedis();
  const db = await freshDb();
  return {
    db,
    store: createStore(redis, db),
    partnerStore: createPartnerStore(db),
    mvs: createMonthlyVolumeStore(redis),
  };
}

const base = {
  phone: '15551234567',
  amountSource: 200,
  sourceCurrency: 'USD' as const,
  partnerId: 'default',
  recipientName: 'Mom',
  recipientPhone: '919133001840',
  payoutMethod: 'upi' as const,
  payoutDestination: 'mom@upi',
  fundingMethod: 'bank_transfer' as const,
  senderKycStatus: 'verified' as const,
};

describe('createTransfer', () => {
  it('creates a cleared transfer in awaiting_payment', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    const t = await createTransfer(store, partnerStore, mvs, base);
    expect(t.status).toBe('awaiting_payment');
    expect(t.complianceStatus).toBe('cleared');
    expect(await store.getTransfer(t.id)).not.toBeNull();
  });

  it('blocks a watchlisted recipient and sets status blocked', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    const t = await createTransfer(store, partnerStore, mvs, { ...base, recipientName: 'John Doe' });
    expect(t.complianceStatus).toBe('blocked');
    expect(t.status).toBe('blocked');
  });

  it('flags a large amount but stays awaiting_payment', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    const t = await createTransfer(store, partnerStore, mvs, { ...base, amountSource: 1500 });
    expect(t.complianceStatus).toBe('flagged');
    expect(t.status).toBe('awaiting_payment');
  });

  it('increments the all-time and today counters', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    await createTransfer(store, partnerStore, mvs, base);
    expect(await store.getTransferCount(base.phone)).toBe(1);
    expect(await store.getTodayTransferCount(base.phone)).toBe(1);
  });
});

describe('createTransfer P1: country + currency fields', () => {
  it('populates all 4 new fields with defaults', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    const t = await createTransfer(store, partnerStore, mvs, {
      phone: '15551112222',
      amountSource: 100,
      sourceCurrency: 'USD',
      partnerId: 'default',
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
      senderKycStatus: 'verified' as const,
    });
    expect(t.sourceCountry).toBe('US');
    expect(t.sourceCurrency).toBe('USD');
    expect(t.destinationCountry).toBe('IN');
    expect(t.destinationCurrency).toBe('INR');
  });
});

describe('createTransfer P2: partnerId', () => {
  it('populates partnerId: default on new transfers', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    const t = await createTransfer(store, partnerStore, mvs, {
      phone: '15551112222',
      amountSource: 100,
      sourceCurrency: 'USD',
      partnerId: 'default',
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
      senderKycStatus: 'verified' as const,
    });
    expect(t.partnerId).toBe('default');
  });
});

describe('createTransfer P4: source-currency fields', () => {
  it('P4: populates source-currency fields (USD scaffold) from the quote', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    const t = await createTransfer(store, partnerStore, mvs, {
      phone: '15551230000',
      amountSource: 100,
      sourceCurrency: 'USD',
      partnerId: 'default',
      recipientName: 'Asha',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'asha@upi',
      fundingMethod: 'bank_transfer',
      senderKycStatus: 'verified' as const,
    });
    expect(t.amountSource).toBe(100);
    expect(t.sourceCurrency).toBe('USD');
    expect(t.amountSource).toBe(t.amountUsd); // USD: source == USD-equiv
    expect(t.feeSource).toBe(t.feeUsd);
    expect(t.totalChargeSource).toBe(t.totalChargeUsd); // USD: source == USD-equiv
    expect(t.partnerId).toBe('default');
  });
});

describe('createTransfer P5: corridor-aware compliance', () => {
  it('P5 regression: default/USD path produces today\'s compliance result', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    await partnerStore.ensureDefaultPartner(); // countries: ['US'], no corridorCompliance
    const t = await createTransfer(store, partnerStore, mvs, {
      phone: '15551230000',
      amountSource: 1500, sourceCurrency: 'USD', partnerId: 'default',
      recipientName: 'Mom', recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer', senderKycStatus: 'verified' as const,
    });
    expect(t.complianceStatus).toBe('flagged');              // >= 1000 today
    expect(t.complianceReasons).toContain('Large transfer amount.');
  });

  it('P5: a corridor override raises the threshold so a flagged-today amount clears', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    await partnerStore.savePartner({
      id: 'gb-co', name: 'GB Co', countries: ['US', 'GB'], status: 'active',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      corridorCompliance: { GB: { largeAmountUsd: 5000 } },
    });
    // Override fetch to return GBP rates (USD + INR) for this test
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { USD: 1.27, INR: 108 } }) }),
    );
    const t = await createTransfer(store, partnerStore, mvs, {
      phone: '15551239999',
      amountSource: 1200, sourceCurrency: 'GBP', partnerId: 'gb-co',
      recipientName: 'Mom', recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer', senderKycStatus: 'verified' as const,
    });
    // 1200 GBP → USD-equivalent (~1524) is below the 5000 override → not flagged for amount.
    expect(t.complianceReasons).not.toContain('Large transfer amount.');
  });
});

describe('createTransfer KYC: EDD merge + Travel-Rule + monthly accrual', () => {
  it('KYC dormant: a sub-$3k send produces today\'s compliance result exactly (regression)', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    await partnerStore.ensureDefaultPartner();
    const t = await createTransfer(store, partnerStore, mvs, {
      phone: '15551230000', amountSource: 200, sourceCurrency: 'USD', partnerId: 'default',
      recipientName: 'Mom', recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer', senderKycStatus: 'verified' as const,
    });
    expect(t.complianceStatus).toBe('cleared');
    expect(t.complianceReasons).toEqual([]);
    expect(t.eddRequired).toBeFalsy();
  });

  it('KYC: a $3k-cumulative send with missing EDD fields → flagged + edd_required (NOT blocked)', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    await partnerStore.ensureDefaultPartner();
    await mvs.addCents('15551230001', 250_000);  // $2,500 already this month
    const t = await createTransfer(store, partnerStore, mvs, {
      phone: '15551230001', amountSource: 600, sourceCurrency: 'USD', partnerId: 'default',
      recipientName: 'Mom', recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer', senderKycStatus: 'verified' as const,
    });
    expect(t.complianceStatus).toBe('flagged');
    expect(t.complianceReasons).toContain('edd_required');
    expect(t.eddRequired).toBe(true);
    expect(t.status).not.toBe('blocked'); // EDD never hard-blocks; customer not suspended
  });

  it('KYC: $3k send WITH EDD fields present → no EDD flag', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    await partnerStore.ensureDefaultPartner();
    await mvs.addCents('15551230002', 250_000);
    const t = await createTransfer(store, partnerStore, mvs, {
      phone: '15551230002', amountSource: 600, sourceCurrency: 'USD', partnerId: 'default',
      recipientName: 'Mom', recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer', senderKycStatus: 'verified' as const,
      sourceOfFunds: 'employment', occupation: 'salaried',
    });
    expect(t.complianceReasons).not.toContain('edd_required');
  });

  it('KYC precedence: a watchlist hit still BLOCKS even when EDD would flag', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    await partnerStore.ensureDefaultPartner();
    await mvs.addCents('15551230003', 250_000);
    const t = await createTransfer(store, partnerStore, mvs, {
      phone: '15551230003', amountSource: 600, sourceCurrency: 'USD', partnerId: 'default',
      recipientName: 'John Doe',  // on WATCHLIST
      recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer', senderKycStatus: 'verified' as const,
    });
    expect(t.complianceStatus).toBe('blocked');
    expect(t.complianceReasons).not.toContain('edd_required');
  });

  it('KYC: monthlyVolumeStore.addCents called with USD-equivalent cents after save', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    await partnerStore.ensureDefaultPartner();
    const t = await createTransfer(store, partnerStore, mvs, {
      phone: '15551230004', amountSource: 200, sourceCurrency: 'USD', partnerId: 'default',
      recipientName: 'Mom', recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer', senderKycStatus: 'verified' as const,
    });
    expect(await mvs.getMonthCents('15551230004')).toBe(Math.round(t.amountUsd * 100));
  });

  it('KYC: Travel-Rule fields are written onto the Transfer when supplied', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    await partnerStore.ensureDefaultPartner();
    const t = await createTransfer(store, partnerStore, mvs, {
      phone: '15551230005', amountSource: 200, sourceCurrency: 'USD', partnerId: 'default',
      recipientName: 'Mom', recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer', senderKycStatus: 'verified' as const,
      recipientLegalName: 'Mother Legal Name', relationship: 'parent', purpose: 'family_support',
    });
    expect(t.recipientLegalName).toBe('Mother Legal Name');
    expect(t.relationship).toBe('parent');
    expect(t.purpose).toBe('family_support');
  });
});

describe('createTransfer any-to-any corridors', () => {
  it('a transfer with destinationCountry AE has destinationCurrency AED and amountInr in AED', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    // Mock: USD rates return {INR:85}; AED rates return {INR:23.1, USD:0.27}
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('from=AED')) {
        return { ok: true, json: async () => ({ rates: { INR: 23.1, USD: 0.27 } }) };
      }
      return { ok: true, json: async () => ({ rates: { INR: 85 } }) };
    }));
    const t = await createTransfer(store, partnerStore, mvs, {
      ...base,
      destinationCountry: 'AE',
      destinationCurrency: 'AED',
    });
    expect(t.destinationCountry).toBe('AE');
    expect(t.destinationCurrency).toBe('AED');
    // Cross-rate USD→AED: 1 / 0.27 ≈ 3.703; 200 USD → ~741 AED
    expect(t.amountInr).toBeGreaterThan(500);   // AED amount, much less than 200 * 85 = 17000 INR
    expect(t.amountInr).toBeLessThan(5000);      // but reasonable for ~740 AED
    expect(t.amountUsd).toBeCloseTo(200, 0);     // USD-equiv unchanged
  });

  it('a transfer with NO destinationCountry defaults to IN/INR (back-compat invariant)', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    // Standard mock: USD→INR=85
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ rates: { INR: 85 } }),
    })));
    const t = await createTransfer(store, partnerStore, mvs, base);
    expect(t.destinationCountry).toBe('IN');
    expect(t.destinationCurrency).toBe('INR');
    expect(t.amountInr).toBe(Math.round(200 * 85)); // 17000 INR — identical to old behavior
  });

  it('existing India tests are unchanged — US→IN transfer complianceStatus cleared at $200', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    const t = await createTransfer(store, partnerStore, mvs, base);
    expect(t.complianceStatus).toBe('cleared');
    expect(t.destinationCurrency).toBe('INR');
  });
});

// ── U7 (audit): optional complete quote override ─────────────────────────────
// The pay-time finalizer passes the DRAFT's stored quote so the ledger records
// exactly what the approval card / pay page showed — no re-quote from current
// transferCount + live FX. Absent ⇒ byte-identical to today (whole suite above).
describe('createTransfer U7: draft-quote override', () => {
  const override = {
    amountUsd: 200,
    feeUsd: 0,
    totalChargeUsd: 200,
    fxRate: 85,
    amountInr: 17_000,
    amountSource: 200,
    feeSource: 0,
    totalChargeSource: 200,
  };

  it('honors a complete override VERBATIM into the Transfer row (no count re-read, no FX fetch)', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    // A prior transfer exists — a re-quote would charge the $1.99 repeat fee…
    await createTransfer(store, partnerStore, mvs, base);
    // …and live FX now differs from the override's rate (90 vs 85).
    resetRateCacheForTests();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 90 } }) });
    vi.stubGlobal('fetch', fetchSpy);

    const t = await createTransfer(store, partnerStore, mvs, { ...base, quote: override });
    expect(t.amountUsd).toBe(200);
    expect(t.feeUsd).toBe(0);             // the card's first-transfer-free promise…
    expect(t.totalChargeUsd).toBe(200);   // …not the re-quoted 201.99
    expect(t.fxRate).toBe(85);
    expect(t.amountInr).toBe(17_000);
    expect(t.amountSource).toBe(200);
    expect(t.feeSource).toBe(0);
    expect(t.totalChargeSource).toBe(200);
    // The override skips the re-quote block entirely — no FX dial-out.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('absent override: a repeat transfer still re-quotes (fee 1.99) — behavior unchanged', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    await createTransfer(store, partnerStore, mvs, base);          // first: free
    const t = await createTransfer(store, partnerStore, mvs, base); // second: re-quote
    expect(t.feeUsd).toBe(1.99);
    expect(t.totalChargeUsd).toBe(201.99);
  });

  it('sanctions still run on the override path: a watchlisted recipient is blocked', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    const t = await createTransfer(store, partnerStore, mvs, {
      ...base,
      recipientName: 'John Doe', // on WATCHLIST
      quote: override,
    });
    expect(t.complianceStatus).toBe('blocked');
    expect(t.status).toBe('blocked');
  });

  it('EDD threshold reads the OVERRIDE amountUsd, not a re-quote of amountSource', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    await partnerStore.ensureDefaultPartner();
    await mvs.addCents('15559990001', 250_000); // $2,500 used this month
    // amountSource 600 would re-quote to $600 (cumulative $3,100 → EDD flag);
    // the override pins the USD-equivalent at $100 (cumulative $2,600 → no flag).
    const t = await createTransfer(store, partnerStore, mvs, {
      ...base,
      phone: '15559990001',
      amountSource: 600,
      quote: {
        amountUsd: 100, feeUsd: 0, totalChargeUsd: 100, fxRate: 85,
        amountInr: 8_500, amountSource: 600, feeSource: 0, totalChargeSource: 600,
      },
    });
    expect(t.complianceReasons).not.toContain('edd_required');
    expect(t.eddRequired).toBeFalsy();
    // The monthly accrual also uses the override's USD-equivalent.
    expect(await mvs.getMonthCents('15559990001')).toBe(250_000 + 10_000);
  });

  it('EDD still flags when the override amountUsd crosses the cumulative threshold', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    await partnerStore.ensureDefaultPartner();
    await mvs.addCents('15559990002', 250_000);
    const t = await createTransfer(store, partnerStore, mvs, {
      ...base,
      phone: '15559990002',
      amountSource: 600,
      quote: {
        amountUsd: 600, feeUsd: 0, totalChargeUsd: 600, fxRate: 85,
        amountInr: 51_000, amountSource: 600, feeSource: 0, totalChargeSource: 600,
      },
    });
    expect(t.complianceStatus).toBe('flagged');
    expect(t.complianceReasons).toContain('edd_required');
    expect(t.eddRequired).toBe(true);
  });
});

describe('createTransfer best-rate routing: settlementPartnerId', () => {
  const override = {
    amountUsd: 200,
    feeUsd: 0,
    totalChargeUsd: 200,
    fxRate: 86,        // a winning partner rate, NOT the live mid (85)
    amountInr: 17_200,
    amountSource: 200,
    feeSource: 0,
    totalChargeSource: 200,
  };

  it('persists settlementPartnerId when supplied WITH the quote override (route + its rate travel together)', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await seedPartner(db, 'rail-partner-x'); // settlement_partner_id carries a REAL FK to partners
    const t = await createTransfer(store, partnerStore, mvs, {
      ...base,
      quote: override,
      settlementPartnerId: 'rail-partner-x',
    });
    expect(t.settlementPartnerId).toBe('rail-partner-x');
    expect(t.fxRate).toBe(86);
    expect(t.amountInr).toBe(17_200);
    // Round-trips through the ledger (mapper carries it).
    const saved = await store.getTransfer(t.id);
    expect(saved?.settlementPartnerId).toBe('rail-partner-x');
    // Branding/compliance ownership is untouched — partnerId stays the customer's.
    expect(saved?.partnerId).toBe('default');
  });

  it('DROPS settlementPartnerId when no quote override is given — a re-quote at mid must settle via the platform', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await seedPartner(db, 'rail-partner-x');
    const t = await createTransfer(store, partnerStore, mvs, {
      ...base,
      settlementPartnerId: 'rail-partner-x', // NO quote ⇒ live re-quote ⇒ route dropped
    });
    expect(t.settlementPartnerId).toBeUndefined();
    expect(t.fxRate).toBe(85); // re-quoted at the live mid
    const saved = await store.getTransfer(t.id);
    expect(saved?.settlementPartnerId).toBeUndefined();
  });
});

describe('quoteOverrideFromDraft (pure)', () => {
  it('USD draft: source-side fields equal the USD fields by definition', () => {
    const o = quoteOverrideFromDraft({
      amountUsd: 200,
      amountSource: 200,
      sourceCurrency: 'USD',
      quote: { feeUsd: 1.99, fxRate: 86, amountInr: 17_200 }, // no totalChargeUsd: derived
    });
    expect(o).toEqual({
      amountUsd: 200,
      feeUsd: 1.99,
      totalChargeUsd: 201.99,
      fxRate: 86,
      amountInr: 17_200,
      amountSource: 200,
      feeSource: 1.99,
      totalChargeSource: 201.99,
    });
  });

  it('non-USD draft WITH stored source-side figures: uses them verbatim', () => {
    const o = quoteOverrideFromDraft({
      amountUsd: 254,
      amountSource: 200,
      sourceCurrency: 'GBP',
      quote: {
        feeUsd: 1.99, fxRate: 108, amountInr: 21_600,
        feeSource: 1.57, totalChargeSource: 201.57, totalChargeUsd: 255.99,
      },
    });
    expect(o).toEqual({
      amountUsd: 254,
      feeUsd: 1.99,
      totalChargeUsd: 255.99,
      fxRate: 108,
      amountInr: 21_600,
      amountSource: 200,
      feeSource: 1.57,
      totalChargeSource: 201.57,
    });
  });

  it('legacy non-USD draft missing feeSource/totalChargeSource ⇒ undefined (mint falls back to a re-quote)', () => {
    const o = quoteOverrideFromDraft({
      amountUsd: 254,
      amountSource: 200,
      sourceCurrency: 'GBP',
      quote: { feeUsd: 1.99, fxRate: 108, amountInr: 21_600 },
    });
    expect(o).toBeUndefined();
  });
});

describe('recordBlockedAttempt', () => {
  const blockedInput = {
    phone: '15551234567',
    recipientName: 'John Doe',
    recipientPhone: '919133001840',
    payoutMethod: 'bank' as const,
    payoutDestination: '123456789 HDFC0001234',
    fundingMethod: 'bank_transfer' as const,
    amountUsd: 100,
    amountSource: 100,
    sourceCurrency: 'USD' as const,
    feeUsd: 1.99,
    feeSource: 1.99,
    fxRate: 85,
    amountInr: 8500,
    totalChargeUsd: 101.99,
    totalChargeSource: 101.99,
    destinationCountry: 'IN' as const,
    destinationCurrency: 'INR' as const,
    partnerId: 'default',
    reasons: ['Recipient is on the compliance watchlist.'],
  };

  it('persists an auditable blocked row (status + complianceStatus blocked)', async () => {
    const { store } = await makeStores();
    const t = await recordBlockedAttempt(store, blockedInput);
    expect(t.status).toBe('blocked');
    expect(t.complianceStatus).toBe('blocked');
    expect(t.complianceReasons).toEqual(['Recipient is on the compliance watchlist.']);
    const fetched = await store.getTransfer(t.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.status).toBe('blocked');
    expect(fetched?.recipientName).toBe('John Doe');
    expect(fetched?.destinationCurrency).toBe('INR');
  });

  it('does NOT advance velocity or volume counters (a blocked attempt is never charged)', async () => {
    const { store, mvs } = await makeStores();
    await recordBlockedAttempt(store, blockedInput);
    // Derived count excludes blocked rows — the blocked attempt never counts.
    expect(await store.getTransferCount(blockedInput.phone)).toBe(0);
    expect(await store.getTodayTransferCount(blockedInput.phone)).toBe(0);
    expect(await mvs.getMonthCents(blockedInput.phone)).toBe(0);
  });

  it('does NOT add the watchlisted recipient to the saved list', async () => {
    const { store } = await makeStores();
    await recordBlockedAttempt(store, blockedInput);
    const recipients = await store.listRecipients(blockedInput.phone, 25);
    expect(recipients).toHaveLength(0);
  });
});
