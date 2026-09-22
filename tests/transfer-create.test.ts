import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTransfer, quoteOverrideFromDraft, recordBlockedAttempt, TransferIdConflictError } from '@/lib/transfer-create';
import { createStore } from '@/lib/store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { SendBusyError, SendCapError } from '@/lib/send-limits';
import { fakeRedis } from './helpers';
import { captureQueries, freshDb, seedLedgerSpend, seedPartner, seedSender } from './helpers-db';
import { resetRateCacheForTests } from '@/lib/rate';

function stubFetch85() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85 } }) }),
  );
}

beforeEach(() => {
  resetRateCacheForTests();
  stubFetch85();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// Program fix 16: a sender with no customers row is T0 ($500/day). Tests that
// mint above that (large-amount flags, the $3k EDD ladder) seed a verified
// sender past the 3-day window (T1, $2,999/day) — relative dates only.
async function t1(db: Awaited<ReturnType<typeof freshDb>>, phone: string, partnerId = 'default') {
  await seedSender(db, { partnerId, phone, firstSeenDaysAgo: 10, kycStatus: 'verified' });
}

// EDD fixtures: $2,500 spent EARLIER this month (never today — same-day it
// would trip the T1 daily cap before EDD). The clock is pinned mid-month so
// "yesterday" is always this ET month; freshDb() runs BEFORE the fake clock.
async function eddStores(phone: string) {
  const s = await makeStores();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-15T16:00:00.000Z'));
  await t1(s.db, phone);
  await seedLedgerSpend(s.db, { partnerId: 'default', phone, amountUsd: 2500, status: 'paid', createdAt: new Date(Date.now() - 86_400_000) });
  return s;
}

// One fresh Postgres handle per test, shared by every pg-backed store in it
// (freshDb truncates per call and reseeds the 'default' partner).
async function makeStores() {
  const redis = fakeRedis();
  const db = await freshDb();
  return {
    db,
    store: createStore(redis, db),
    partnerStore: createPartnerStore(db),
    mvs: createMonthlyVolumeStore(createStore(redis, db)),
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
  it('upserts the recipient; velocity + monthly volume are ledger totals under input.partnerId only (F45/F47)', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await seedPartner(db, 'acme');
    await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme' });
    expect(await store.listRecipients('acme', base.phone, 5)).toHaveLength(1);
    expect(await store.listRecipients('default', base.phone, 5)).toEqual([]);
    expect(await store.getTodayTransferCount('acme', base.phone)).toBe(1);
    expect(await store.getTodayTransferCount('default', base.phone)).toBe(0);
    expect(await mvs.getMonthCents('acme', base.phone)).toBe(20_000);
    expect(await mvs.getMonthCents('default', base.phone)).toBe(0);
    expect(await store.getTransferCount('acme', base.phone)).toBe(1);
    expect(await store.getTransferCount('default', base.phone)).toBe(0);
  });

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
    const { db, store, partnerStore, mvs } = await makeStores();
    await t1(db, base.phone);
    const t = await createTransfer(store, partnerStore, mvs, { ...base, amountSource: 1500 });
    expect(t.complianceStatus).toBe('flagged');
    expect(t.status).toBe('awaiting_payment');
  });

  it('the all-time and today counts derive from the minted row', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    await createTransfer(store, partnerStore, mvs, base);
    expect(await store.getTransferCount('default', base.phone)).toBe(1);
    expect(await store.getTodayTransferCount('default', base.phone)).toBe(1);
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
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerStore.ensureDefaultPartner(); // countries: ['US'], no corridorCompliance
    await t1(db, '15551230000');
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
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerStore.savePartner({
      id: 'gb-co', name: 'GB Co', countries: ['US', 'GB'], status: 'active',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      corridorCompliance: { GB: { largeAmountUsd: 5000 } },
    });
    await t1(db, '15551239999', 'gb-co');
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
    const { store, partnerStore, mvs } = await eddStores('15551230001'); // $2,500 paid yesterday (ledger)
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
    const { store, partnerStore, mvs } = await eddStores('15551230002'); // $2,500 paid yesterday (ledger)
    const t = await createTransfer(store, partnerStore, mvs, {
      phone: '15551230002', amountSource: 600, sourceCurrency: 'USD', partnerId: 'default',
      recipientName: 'Mom', recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer', senderKycStatus: 'verified' as const,
      sourceOfFunds: 'employment', occupation: 'salaried',
    });
    expect(t.complianceReasons).not.toContain('edd_required');
  });

  it('KYC precedence: a watchlist hit still BLOCKS even when EDD would flag', async () => {
    const { store, partnerStore, mvs } = await eddStores('15551230003'); // $2,500 paid yesterday (ledger)
    const t = await createTransfer(store, partnerStore, mvs, {
      phone: '15551230003', amountSource: 600, sourceCurrency: 'USD', partnerId: 'default',
      recipientName: 'John Doe',  // on WATCHLIST
      recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer', senderKycStatus: 'verified' as const,
    });
    expect(t.complianceStatus).toBe('blocked');
    expect(t.complianceReasons).not.toContain('edd_required');
  });

  it('KYC: getMonthCents reflects the minted row (the ledger IS the accrual)', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    await partnerStore.ensureDefaultPartner();
    const t = await createTransfer(store, partnerStore, mvs, {
      phone: '15551230004', amountSource: 200, sourceCurrency: 'USD', partnerId: 'default',
      recipientName: 'Mom', recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer', senderKycStatus: 'verified' as const,
    });
    expect(await mvs.getMonthCents('default', '15551230004')).toBe(Math.round(t.amountUsd * 100));
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

  it('any-to-any: an INR-source transfer to a US recipient is INR→USD', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    // from=INR → {USD:0.0118, INR:1}; from=USD (destination) → {INR:85} (toUsd identity 1)
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('from=INR')) {
        return { ok: true, json: async () => ({ rates: { USD: 0.0118, INR: 1 } }) };
      }
      return { ok: true, json: async () => ({ rates: { INR: 85 } }) };
    }));
    await t1(db, '919876543210');
    const t = await createTransfer(store, partnerStore, mvs, {
      ...base,
      phone: '919876543210',        // Indian sender
      recipientPhone: '15551234567', // US recipient
      amountSource: 50000,           // ₹50,000 ≈ $590 (above the $10 floor)
      sourceCurrency: 'INR',
      destinationCountry: 'US',
      destinationCurrency: 'USD',
    });
    expect(t.sourceCurrency).toBe('INR');
    expect(t.destinationCountry).toBe('US');
    expect(t.destinationCurrency).toBe('USD');
    expect(t.amountUsd).toBeCloseTo(590, 0);        // USD-equivalent of ₹50,000
    expect(t.amountInr).toBeCloseTo(590, 0);        // destination amount, in USD (back-compat field name)
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
    const { store, partnerStore, mvs } = await eddStores('15559990001'); // $2,500 paid yesterday (ledger)
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
    expect(await mvs.getMonthCents('default', '15559990001')).toBe(250_000 + 10_000);
  });

  it('EDD still flags when the override amountUsd crosses the cumulative threshold', async () => {
    const { store, partnerStore, mvs } = await eddStores('15559990002'); // $2,500 paid yesterday (ledger)
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
    expect(await store.getTransferCount('default', blockedInput.phone)).toBe(0);
    expect(await store.getTodayTransferCount('default', blockedInput.phone)).toBe(0);
    expect(await mvs.getMonthCents('default', blockedInput.phone)).toBe(0);
  });

  it('does NOT add the watchlisted recipient to the saved list', async () => {
    const { store } = await makeStores();
    await recordBlockedAttempt(store, blockedInput);
    const recipients = await store.listRecipients('default', blockedInput.phone, 25);
    expect(recipients).toHaveLength(0);
  });
});

describe('createTransfer — ctx-01 chokepoint (fix 6)', () => {
  const REAL = 'HDFC0001234 123456789012';
  const yesterday = () => new Date(Date.now() - 86_400_000).toISOString();
  async function seedSavedMom(store: Awaited<ReturnType<typeof makeStores>>['store'], at: string) {
    await store.upsertRecipient('default', base.phone, {
      name: 'Mom', recipientPhone: base.recipientPhone, payoutMethod: 'bank', payoutDestination: REAL, lastUsedAt: at,
    });
  }

  it('REFUSES a partner-pulled funding method on a CONSUMER transfer before any write; a B2B ach_pull mint is unaffected', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    for (const fundingMethod of ['ach_pull', 'bank_pull'] as const) {
      await expect(createTransfer(store, partnerStore, mvs, { ...base, fundingMethod }))
        .rejects.toThrow('partner_pulled_funding_requires_b2b');
    }
    expect(await store.listTransfers()).toHaveLength(0);
    expect(await store.getTodayTransferCount('default', base.phone)).toBe(0);
    const b2b = await createTransfer(store, partnerStore, mvs, {
      ...base, recipientName: 'Globex Trading LLC', fundingMethod: 'ach_pull', payoutDestination: '',
      transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business',
      senderBusinessName: 'Acme Imports Ltd', recipientBusinessName: 'Globex Trading LLC',
    });
    expect(b2b.status).toBe('awaiting_payment');
  });

  it('REFUSES a masked destination before ANY write: no ledger row, no velocity/monthly accrual, the saved real account untouched', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    const at = yesterday();
    await seedSavedMom(store, at);
    for (const bad of ['****9012', '****', 'account on file', 'account ****9012']) {
      await expect(
        createTransfer(store, partnerStore, mvs, { ...base, payoutMethod: 'bank', payoutDestination: bad }),
      ).rejects.toThrow('masked_payout_destination');
    }
    expect(await store.listTransfers()).toHaveLength(0);
    expect(await store.getTodayTransferCount('default', base.phone)).toBe(0);
    expect(await mvs.getMonthCents('default', base.phone)).toBe(0);
    const [saved] = await store.listRecipients('default', base.phone, 5);
    expect(saved.payoutDestination).toBe(REAL);
    expect(saved.lastUsedAt).toBe(at);
  });

  it('sanctions run FIRST: a watchlisted recipient with a masked destination leaves ONE blocked audit row with an EMPTY destination — and nothing else', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    const t = await createTransfer(store, partnerStore, mvs, {
      ...base, recipientName: 'John Doe', payoutMethod: 'bank', payoutDestination: '****9012',
    });
    expect(t.status).toBe('blocked');
    expect(t.payoutDestination).toBe('');
    expect(await store.listTransfers()).toHaveLength(1);
    expect((await store.getTransferDecrypted(t.id))?.payoutDestination).toBe('');
    expect(await store.getTodayTransferCount('default', base.phone)).toBe(0);
    expect(await mvs.getMonthCents('default', base.phone)).toBe(0);
    expect(await store.listRecipients('default', base.phone, 5)).toEqual([]);
  });

  it('BEHAVIOUR CHANGE: a blocked mint with a REAL destination keeps it as evidence but never accrues and never writes the address book', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    const t = await createTransfer(store, partnerStore, mvs, {
      ...base, recipientName: 'John Doe', payoutMethod: 'bank', payoutDestination: REAL,
    });
    expect(t.status).toBe('blocked');
    expect((await store.getTransferDecrypted(t.id))?.payoutDestination).toBe(REAL);
    expect(await store.getTodayTransferCount('default', base.phone)).toBe(0);
    expect(await mvs.getMonthCents('default', base.phone)).toBe(0);
    expect(await store.listRecipients('default', base.phone, 5)).toEqual([]);
  });

  it("an EMPTY destination still mints (the pay page collects it) and still accrues, but never overwrites the sender's saved real account", async () => {
    const { store, partnerStore, mvs } = await makeStores();
    const at = yesterday();
    await seedSavedMom(store, at);
    const t = await createTransfer(store, partnerStore, mvs, { ...base, payoutMethod: 'bank', payoutDestination: '' });
    expect(t.status).toBe('awaiting_payment');
    expect(await store.getTodayTransferCount('default', base.phone)).toBe(1);
    const [saved] = await store.listRecipients('default', base.phone, 5);
    expect(saved.payoutDestination).toBe(REAL);
    expect(saved.lastUsedAt).toBe(at);
  });

  it("a B2B mint never writes the payee (a seller's profile account) into the sender's personal address book", async () => {
    const { store, partnerStore, mvs } = await makeStores();
    await createTransfer(store, partnerStore, mvs, {
      ...base, recipientName: 'Globex Trading LLC', payoutMethod: 'bank', payoutDestination: REAL,
      transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business',
      senderBusinessName: 'Acme Imports Ltd', recipientBusinessName: 'Globex Trading LLC',
    });
    expect(await store.listRecipients('default', base.phone, 5)).toEqual([]);
  });
});

describe('createTransfer — saveRecipient (fix 5: partner-API mints never write the chat address book)', () => {
  it('saveRecipient: false mints and accrues but leaves the address book untouched', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    const t = await createTransfer(store, partnerStore, mvs, { ...base, saveRecipient: false });
    expect(t.status).toBe('awaiting_payment');
    expect(await store.listRecipients('default', base.phone, 5)).toEqual([]);
    expect(await store.getTodayTransferCount('default', base.phone)).toBe(1);
    expect(await mvs.getMonthCents('default', base.phone)).toBe(20_000);
  });

  it('a chat mint (flag absent) still refreshes the address book', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    await createTransfer(store, partnerStore, mvs, base);
    const [saved] = await store.listRecipients('default', base.phone, 5);
    expect(saved).toMatchObject({ name: 'Mom', recipientPhone: base.recipientPhone, payoutDestination: 'mom@upi' });
  });
});

// ── Program fix 16 (Task 10): send caps enforced from the ledger, under the
// per-sender lock, on EVERY mint path (createTransfer is the chokepoint). ──
describe('createTransfer — send caps from the ledger (Program fix 16)', () => {
  const T0_PHONE = '15550160001'; // no customers row ⇒ firstSeenAt = now ⇒ T0 ($500/day)
  const T1_PHONE = '15550160002';

  async function t1Stores() {
    const s = await makeStores();
    await seedSender(s.db, { partnerId: 'default', phone: T1_PHONE, firstSeenDaysAgo: 10, kycStatus: 'verified' });
    return s;
  }

  it('test 6: $450 minted today + $100 requested for a T0 sender ⇒ SendCapError(over_daily_cap), no row, no recipient, count unchanged', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await seedLedgerSpend(db, { partnerId: 'default', phone: T0_PHONE, amountUsd: 450 });
    const before = await store.senderTotals('default', T0_PHONE);
    let caught: unknown;
    try {
      await createTransfer(store, partnerStore, mvs, { ...base, phone: T0_PHONE, amountSource: 100 });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(SendCapError);
    const ev = (caught as SendCapError).evaluation;
    expect(ev.reason).toBe('over_daily_cap');
    expect(ev.tier).toBe('T0');
    expect(ev.todayUsedCents).toBe(45_000);
    expect(ev.todayRemainingCents).toBe(5_000);
    expect((caught as Error).message).toBe('send_cap_exceeded'); // no figures in the message
    expect(await store.senderTotals('default', T0_PHONE)).toEqual(before);
    expect(await store.listRecipients('default', T0_PHONE, 5)).toEqual([]);
    expect(await store.getTransferCount('default', T0_PHONE)).toBe(1);
  });

  it('per-transfer: a T0 sender asking for $600 is over_per_transfer_cap even with no spend', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    await expect(createTransfer(store, partnerStore, mvs, { ...base, phone: T0_PHONE, amountSource: 600 }))
      .rejects.toMatchObject({ name: 'SendCapError', evaluation: { reason: 'over_per_transfer_cap', tier: 'T0' } });
    expect(await store.getTransferCount('default', T0_PHONE)).toBe(0);
  });

  it('test 7a: two $300 T0 mints — the second is refused on the ledger total of the first', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    const first = await createTransfer(store, partnerStore, mvs, { ...base, phone: T0_PHONE, amountSource: 300 });
    expect(first.status).toBe('awaiting_payment');
    await expect(createTransfer(store, partnerStore, mvs, { ...base, phone: T0_PHONE, amountSource: 300 }))
      .rejects.toBeInstanceOf(SendCapError);
    expect(await store.getTransferCount('default', T0_PHONE)).toBe(1);
    expect((await store.senderTotals('default', T0_PHONE)).todayUsdCents).toBe(30_000);
  });

  it('test 7b: EDD reads the ledger month — $1,500 yesterday + 2×$800 today: the 2nd is flagged edd_required, neither hits the daily cap', async () => {
    const { db, store, partnerStore, mvs } = await t1Stores(); // freshDb() BEFORE the fake clock
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-15T16:00:00.000Z')); // noon ET, mid-month
      await seedSender(db, { partnerId: 'default', phone: T1_PHONE, firstSeenDaysAgo: 10, kycStatus: 'verified' });
      await seedLedgerSpend(db, { partnerId: 'default', phone: T1_PHONE, amountUsd: 1500, status: 'paid', createdAt: new Date(Date.now() - 86_400_000) });
      const a = await createTransfer(store, partnerStore, mvs, { ...base, phone: T1_PHONE, amountSource: 800 });
      expect(a.complianceReasons).not.toContain('edd_required');
      expect(a.eddRequired).toBe(false);
      const b = await createTransfer(store, partnerStore, mvs, { ...base, phone: T1_PHONE, amountSource: 800 });
      expect(b.complianceStatus).toBe('flagged');
      expect(b.complianceReasons).toContain('edd_required');
      expect(b.eddRequired).toBe(true);
      expect(b.status).toBe('awaiting_payment');
      const t = await store.senderTotals('default', T1_PHONE);
      expect(t.todayUsdCents).toBe(160_000);
      expect(t.monthUsdCents).toBe(310_000);
      // EDD fields present ⇒ no flag, but the month total still accrues.
      const c = await createTransfer(store, partnerStore, mvs, {
        ...base, phone: T1_PHONE, amountSource: 100, sourceOfFunds: 'employment', occupation: 'salaried',
      });
      expect(c.complianceReasons).not.toContain('edd_required');
    } finally {
      vi.useRealTimers();
    }
  });

  it('test 8: the sender lock is taken FIRST inside a READ COMMITTED transaction, before any transfers statement', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    const txSpy = vi.spyOn(db, 'transaction');
    const stop = captureQueries();
    await createTransfer(store, partnerStore, mvs, { ...base, phone: T0_PHONE });
    const log = stop().map((q) => q.sql.toLowerCase());
    expect(txSpy).toHaveBeenCalledTimes(1);
    expect(txSpy.mock.calls[0][1]).toEqual({ isolationLevel: 'read committed' });
    const iso = log.findIndex((q) => q.includes('set transaction isolation level read committed'));
    expect(iso).toBeGreaterThanOrEqual(0);
    expect(log[iso + 1]).toContain("set local lock_timeout = '5s'");
    expect(log[iso + 2]).toContain('pg_advisory_xact_lock(hashtext($1))');
    // Nothing inside the transaction touches transfers before the lock.
    const inTx = log.slice(iso, iso + 3);
    expect(inTx.some((q) => /\btransfers\b/.test(q))).toBe(false);
    // And the totals + the insert come after it, inside the same transaction.
    const afterLock = log.slice(iso + 3);
    expect(afterLock.some((q) => q.includes('from "transfers"') || q.includes('from transfers'))).toBe(true);
    expect(afterLock.some((q) => q.startsWith('insert into "transfers"'))).toBe(true);
  });

  it('test 9: a lock timeout (55P03) surfaces as SendBusyError with NO row; the same id then mints once', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    const timeout = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    vi.spyOn(db, 'transaction').mockRejectedValueOnce(timeout);
    await expect(createTransfer(store, partnerStore, mvs, { ...base, id: 'busy_1', phone: T0_PHONE }))
      .rejects.toBeInstanceOf(SendBusyError);
    expect(await store.getTransfer('busy_1')).toBeNull();
    expect(await store.listRecipients('default', T0_PHONE, 5)).toEqual([]);
    vi.restoreAllMocks();
    stubFetch85();
    const t = await createTransfer(store, partnerStore, mvs, { ...base, id: 'busy_1', phone: T0_PHONE });
    expect(t.id).toBe('busy_1');
    expect(await store.getTransferCount('default', T0_PHONE)).toBe(1);
  });

  it('test 11: minting the same input.id again returns the first row, counts once, is never re-capped, and never touches the address book', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    const first = await createTransfer(store, partnerStore, mvs, { ...base, id: 'replay_1', phone: T0_PHONE, amountSource: 400 });
    expect(first.id).toBe('replay_1');
    const book = await store.listRecipients('default', T0_PHONE, 5);
    expect(book).toHaveLength(1);
    // Fill the day so a fresh cap check WOULD refuse, then replay.
    await seedLedgerSpend(db, { partnerId: 'default', phone: T0_PHONE, amountUsd: 100 });
    const again = await createTransfer(store, partnerStore, mvs, { ...base, id: 'replay_1', phone: T0_PHONE, amountSource: 400, payoutDestination: 'someone-else@upi' });
    expect(again.id).toBe('replay_1');
    expect(again.amountUsd).toBe(400);
    expect(await store.getTransferCount('default', T0_PHONE)).toBe(2); // the mint + the seeded row, nothing new
    // The replay is a MASKED read: it must never be written into the sender's saved recipients.
    expect(await store.listRecipients('default', T0_PHONE, 5)).toEqual(book);
  });

  it('a same-id replay never returns or overwrites another tenant\'s row — it refuses before any write', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await seedPartner(db, 'acme');
    await seedLedgerSpend(db, { partnerId: 'acme', phone: T0_PHONE, amountUsd: 10, id: 'cross_1' });
    await expect(createTransfer(store, partnerStore, mvs, { ...base, id: 'cross_1', phone: T0_PHONE }))
      .rejects.toBeInstanceOf(TransferIdConflictError);
    await expect(createTransfer(store, partnerStore, mvs, { ...base, id: 'cross_1', phone: T0_PHONE }))
      .rejects.toThrow('transfer_id_conflict');
    const row = await store.getTransfer('cross_1');
    expect([row?.partnerId, row?.amountUsd]).toEqual(['acme', 10]); // untouched
    expect(await store.getTransferCount('default', T0_PHONE)).toBe(0);
  });

  it('test 12: sanctions run first — a watchlisted recipient for a sender AT cap leaves a blocked row, not SendCapError, and the sums are unchanged', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await seedLedgerSpend(db, { partnerId: 'default', phone: T0_PHONE, amountUsd: 500 });
    const before = await store.senderTotals('default', T0_PHONE);
    const t = await createTransfer(store, partnerStore, mvs, { ...base, phone: T0_PHONE, amountSource: 100, recipientName: 'John Doe' });
    expect(t.status).toBe('blocked');
    expect((await store.getTransfer(t.id))?.status).toBe('blocked');
    expect(await store.senderTotals('default', T0_PHONE)).toEqual(before); // blocked never consumes cap
    expect(await store.listRecipients('default', T0_PHONE, 5)).toEqual([]);
  });

  it('test 17: a $400 T0 row voided by cancelIfCancellable frees the headroom for a new $400 send', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    const a = await createTransfer(store, partnerStore, mvs, { ...base, phone: T0_PHONE, amountSource: 400 });
    await expect(createTransfer(store, partnerStore, mvs, { ...base, phone: T0_PHONE, amountSource: 400 }))
      .rejects.toBeInstanceOf(SendCapError);
    expect((await store.cancelTransferIfUnfunded(a.id, 'default'))?.status).toBe('cancelled');
    const b = await createTransfer(store, partnerStore, mvs, { ...base, phone: T0_PHONE, amountSource: 400 });
    expect(b.status).toBe('awaiting_payment');
    // A cancelled row still counts for velocity (like countByPhone), but not for spend.
    const t = await store.senderTotals('default', T0_PHONE);
    expect(t.todayUsdCents).toBe(40_000);
    expect(t.todayCount).toBe(2);
  });

  it('a partner row can only TIGHTEN: per-transfer $100 refuses a $150 T1 send; a $900,000 T1 cap stays $2,999', async () => {
    const { db, store, partnerStore, mvs } = await t1Stores();
    await db.execute(sql`UPDATE partners SET send_limits = '{"perTransferCapCents":10000,"t1DailyCapCents":90000000}'::jsonb WHERE id = 'default'`);
    await expect(createTransfer(store, partnerStore, mvs, { ...base, phone: T1_PHONE, amountSource: 150 }))
      .rejects.toMatchObject({ evaluation: { reason: 'over_per_transfer_cap', perTransferCapCents: 10_000, dailyCapCents: 299_900 } });
    const ok = await createTransfer(store, partnerStore, mvs, { ...base, phone: T1_PHONE, amountSource: 90 });
    expect(ok.status).toBe('awaiting_payment');
  });

  it('T1 can send $2,999 once; $2,999.01 hits the quote ceiling and $3,000 in a day hits the daily cap', async () => {
    const { store, partnerStore, mvs } = await t1Stores();
    // $2,999.01 is refused by the quote ceiling (MAX_USD 2999, ruling 12) before the cap runs.
    await expect(createTransfer(store, partnerStore, mvs, { ...base, phone: T1_PHONE, amountSource: 2999.01 }))
      .rejects.toThrow('Transfers must be between $10 and $2999.');
    const a = await createTransfer(store, partnerStore, mvs, { ...base, phone: T1_PHONE, amountSource: 2999 });
    expect(a.complianceStatus).toBe('flagged'); // Large transfer amount (>= $1,000) — flags, never blocks
    await expect(createTransfer(store, partnerStore, mvs, { ...base, phone: T1_PHONE, amountSource: 10 })) // $10 is the quote floor
      .rejects.toMatchObject({ evaluation: { reason: 'over_daily_cap', tier: 'T1', todayRemainingCents: 0 } });
  });

  it('a sender in another tenant does not consume this tenant\'s headroom', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await seedPartner(db, 'acme');
    await seedLedgerSpend(db, { partnerId: 'acme', phone: T0_PHONE, amountUsd: 500 });
    const t = await createTransfer(store, partnerStore, mvs, { ...base, phone: T0_PHONE, amountSource: 300 });
    expect(t.status).toBe('awaiting_payment');
  });
});
