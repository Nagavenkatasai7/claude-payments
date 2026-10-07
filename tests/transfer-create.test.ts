import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { checkMintedRate } from '@/lib/minted-rate';
import { assertQuoteOverrideFresh, createTransfer, fxProvenanceFor, quoteOverrideFromDraft, recordBlockedAttempt, TransferIdConflictError } from '@/lib/transfer-create';
import { createStore } from '@/lib/store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { SendBusyError, SendCapError } from '@/lib/send-limits';
import { fakeRedis } from './helpers';
import { captureQueries, freshDb, seedLedgerSpend, seedPartner, seedSender } from './helpers-db';
import { ECB_DAILY_URL, ECB_PROVIDER_ID, FX_PROVIDER_ID, RateUnavailableError, resetRateCacheForTests, setEcbSourceForTests } from '@/lib/rate';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setOfacListSourceForTests } from '@/lib/providers/sanctions-provider';
import { PostgresSanctionsListSource } from '@/lib/sanctions/pg-list-source';
import { createSanctionsListRepo } from '@/db/repos/sanctions-list-repo';
import { parseOfacSdnXml } from '@/lib/sanctions/ofac-sdn-loader';

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

// Step 0 FX-1 (B3): the re-quote gates BOTH legs' fixing dates (flag ON only).
describe('createTransfer — the re-quote gates both FX legs (Step 0 FX-1)', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const today = () => new Date().toISOString().slice(0, 10);
  function stubDated(aedDate: string) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('from=USD')) return { ok: true, json: async () => ({ date: today(), rates: { INR: 85 } }) };
      // SGD is fetched on its own (AED is derived from USD, so it cannot stall alone).
      return { ok: true, json: async () => ({ date: aedDate, rates: { INR: 65, USD: 0.78 } }) };
    }));
  }
  const toSg = { ...base, destinationCountry: 'SG' as const, destinationCurrency: 'SGD' as const };

  it('flag ON: a DESTINATION leg whose fixing is years old refuses the mint (stale_fixing); nothing written', async () => {
    vi.stubEnv('FX_FIXING_GATE_ENABLED', 'true');
    const { db, store, partnerStore, mvs } = await makeStores();
    stubDated('2016-01-04');
    await expect(createTransfer(store, partnerStore, mvs, toSg)).rejects.toMatchObject({ reason: 'stale_fixing' });
    const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM transfers`)) as unknown as { rows: Array<{ n: number }> };
    expect(rows.rows[0].n).toBe(0);
  });

  it('flag OFF (default): the same feed still mints', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    stubDated('2016-01-04');
    const t = await createTransfer(store, partnerStore, mvs, toSg);
    expect(t.destinationCurrency).toBe('SGD');
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

  it('honors a complete override VERBATIM into the Transfer row (no re-quote, no FX fetch)', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    // A prior transfer exists (A5: an approved $0 first-transfer quote would
    // now be stale — see the A5 describe — so the card here carries the fee)…
    await createTransfer(store, partnerStore, mvs, base);
    // …and live FX now differs from the override's rate (90 vs 85).
    resetRateCacheForTests();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 90 } }) });
    vi.stubGlobal('fetch', fetchSpy);

    const t = await createTransfer(store, partnerStore, mvs, {
      ...base,
      quote: { ...override, feeUsd: 1.99, totalChargeUsd: 201.99, feeSource: 1.99, totalChargeSource: 201.99 },
    });
    expect(t.amountUsd).toBe(200);
    expect(t.feeUsd).toBe(1.99);          // the card's figures…
    expect(t.totalChargeUsd).toBe(201.99);
    expect(t.fxRate).toBe(85);            // …not a re-quote at the live 90
    expect(t.amountInr).toBe(17_000);
    expect(t.amountSource).toBe(200);
    expect(t.feeSource).toBe(1.99);
    expect(t.totalChargeSource).toBe(201.99);
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
        // A5: the sender has history, so the card carries the standard fee.
        amountUsd: 100, feeUsd: 1.99, totalChargeUsd: 100, fxRate: 85,
        amountInr: 8_500, amountSource: 600, feeSource: 1.99, totalChargeSource: 600,
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
        // A5: the sender has history, so the card carries the standard fee.
        amountUsd: 600, feeUsd: 1.99, totalChargeUsd: 600, fxRate: 85,
        amountInr: 51_000, amountSource: 600, feeSource: 1.99, totalChargeSource: 600,
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

// Step 0 FX-5: a partner push carries its own expiry; under the FX-2 flag the
// approved quote stops being payable once that push expires.
describe('route expiry on the approved quote (Step 0 FX-5)', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  function reasonOf(fn: () => void): string | null {
    try { fn(); return null; } catch (err) { return err instanceof RateUnavailableError ? err.reason : 'other'; }
  }
  const NOW = Date.now();

  it('flag ON: a quote past its push expiry is refused as stale_quote (also at exactly the expiry)', () => {
    vi.stubEnv('FX_PAY_RATE_CHECK_ENABLED', 'true');
    expect(reasonOf(() => assertQuoteOverrideFresh({ fxFetchedAt: NOW - 60_000, routeExpiresAt: NOW - 1 }, NOW))).toBe('stale_quote');
    expect(reasonOf(() => assertQuoteOverrideFresh({ fxFetchedAt: NOW - 60_000, routeExpiresAt: NOW }, NOW))).toBe('stale_quote');
  });

  it('flag ON: before the push expires, and with no push expiry at all, the quote passes', () => {
    vi.stubEnv('FX_PAY_RATE_CHECK_ENABLED', 'true');
    expect(reasonOf(() => assertQuoteOverrideFresh({ fxFetchedAt: NOW - 60_000, routeExpiresAt: NOW + 1 }, NOW))).toBeNull();
    expect(reasonOf(() => assertQuoteOverrideFresh({ fxFetchedAt: NOW - 60_000 }, NOW))).toBeNull();
  });

  it('flag OFF (default): the push expiry is not checked; the fetch-age check is unchanged', () => {
    expect(reasonOf(() => assertQuoteOverrideFresh({ fxFetchedAt: NOW - 60_000, routeExpiresAt: NOW - 1 }, NOW))).toBeNull();
    expect(reasonOf(() => assertQuoteOverrideFresh({ fxFetchedAt: NOW - 61 * 60_000 }, NOW))).toBe('stale_quote');
  });

  it('flag ON: createTransfer refuses an expired routed override before any write', async () => {
    vi.stubEnv('FX_PAY_RATE_CHECK_ENABLED', 'true');
    const { db, store, partnerStore, mvs } = await makeStores();
    await seedPartner(db, 'rail-partner-x');
    await expect(createTransfer(store, partnerStore, mvs, {
      ...base,
      quote: {
        amountUsd: 200, feeUsd: 0, totalChargeUsd: 200, fxRate: 86, amountInr: 17_200,
        amountSource: 200, feeSource: 0, totalChargeSource: 200,
        fxFetchedAt: Date.now() - 60_000, routeExpiresAt: Date.now() - 1_000,
      },
      settlementPartnerId: 'rail-partner-x',
    })).rejects.toMatchObject({ reason: 'stale_quote' });
    const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM transfers`)) as unknown as { rows: Array<{ n: number }> };
    expect(rows.rows[0].n).toBe(0);
  });

  it('quoteOverrideFromDraft carries the push expiry and the rate provenance (USD and non-USD drafts)', () => {
    const extra = { routeExpiresAt: NOW + 600_000, fxAsOf: '2026-10-02', fxOrigin: 'partner_push' as const };
    const usd = quoteOverrideFromDraft({
      amountUsd: 200, amountSource: 200, sourceCurrency: 'USD',
      quote: { feeUsd: 0, fxRate: 86, amountInr: 17_200, fxFetchedAt: NOW, ...extra },
    });
    expect(usd).toMatchObject({ fxFetchedAt: NOW, ...extra });
    const gbp = quoteOverrideFromDraft({
      amountUsd: 254, amountSource: 200, sourceCurrency: 'GBP',
      quote: { feeUsd: 1.99, fxRate: 108, amountInr: 21_600, feeSource: 1.57, totalChargeSource: 201.57, totalChargeUsd: 255.99, ...extra },
    });
    expect(gbp).toMatchObject(extra);
    // Oct 7 ECB source: the draft's rate provider rides along to the mint.
    const ecb = quoteOverrideFromDraft({
      amountUsd: 200, amountSource: 200, sourceCurrency: 'USD',
      quote: { feeUsd: 0, fxRate: 86, amountInr: 17_200, fxFetchedAt: NOW, fxOrigin: 'platform', fxProvider: ECB_PROVIDER_ID },
    });
    expect(ecb).toMatchObject({ fxProvider: ECB_PROVIDER_ID });
  });
});

// Step 0 FX-7: which rate priced the row, when it was published and fetched.
describe('rate provenance on the minted row (Step 0 FX-7)', () => {
  const dayAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  function stubDated(usdDate: string, sgdDate = usdDate) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('from=USD')) return { ok: true, json: async () => ({ date: usdDate, rates: { INR: 85 } }) };
      return { ok: true, json: async () => ({ date: sgdDate, rates: { INR: 65, USD: 0.78 } }) };
    }));
  }
  const override = {
    amountUsd: 200, feeUsd: 0, totalChargeUsd: 200, fxRate: 85, amountInr: 17_000,
    amountSource: 200, feeSource: 0, totalChargeSource: 200,
  };

  it('fxProvenanceFor (pure): each origin stamps what it can vouch for', () => {
    const at = Date.UTC(2026, 9, 2, 15, 0, 0);
    const iso = new Date(at).toISOString();
    expect(fxProvenanceFor('platform', '2026-10-02', at)).toEqual({ fxSource: 'platform', fxProvider: FX_PROVIDER_ID, fxAsOf: '2026-10-02', fxFetchedAt: iso });
    expect(fxProvenanceFor('partner_margin', '2026-10-02', at)).toEqual({ fxSource: 'partner_margin', fxProvider: 'partner', fxAsOf: '2026-10-02', fxFetchedAt: iso });
    // A push is the partner's own number: the reference date does not describe it.
    expect(fxProvenanceFor('partner_push', '2026-10-02', at)).toEqual({ fxSource: 'partner_push', fxProvider: 'partner', fxFetchedAt: iso });
    // A B2B locked quote: origin only, dates NULL.
    expect(fxProvenanceFor('b2b_lock', '2026-10-02', at)).toEqual({ fxSource: 'b2b_lock' });
    // An older draft without an origin: only the fetch time it carries.
    expect(fxProvenanceFor(undefined, undefined, at)).toEqual({ fxFetchedAt: iso });
    expect(fxProvenanceFor(undefined, undefined, undefined)).toEqual({});
    // Oct 7 ECB source: a platform rate names the source that actually served it;
    // a partner rate stays 'partner'; no provider (an older draft) keeps FX_PROVIDER_ID.
    expect(fxProvenanceFor('platform', '2026-10-02', at, undefined, 'ecb-eurofxref-daily')).toMatchObject({ fxProvider: 'ecb-eurofxref-daily' });
    expect(fxProvenanceFor('partner_margin', '2026-10-02', at, undefined, 'ecb-eurofxref-daily')).toMatchObject({ fxProvider: 'partner' });
    expect(fxProvenanceFor('platform', '2026-10-02', at, undefined, 'ecb-eurofxref-daily+frankfurter-v1-ecb'))
      .toMatchObject({ fxProvider: 'ecb-eurofxref-daily+frankfurter-v1-ecb' });
    // A draft is Redis data: an unknown provider never reaches the row.
    expect(fxProvenanceFor('platform', '2026-10-02', at, undefined, '<script>')).toMatchObject({ fxProvider: FX_PROVIDER_ID });
    expect(fxProvenanceFor('platform', '2026-10-02', at, undefined, 'ecb-eurofxref-daily+evil')).toMatchObject({ fxProvider: FX_PROVIDER_ID });
  });

  it('fxProvenanceFor (pure): the push expiry is stamped when given (review finding 1), never for a B2B lock', () => {
    const at = Date.UTC(2026, 9, 2, 15, 0, 0);
    const exp = at + 5 * 60_000;
    expect(fxProvenanceFor('partner_push', undefined, at, exp)).toEqual({
      fxSource: 'partner_push', fxProvider: 'partner', fxFetchedAt: new Date(at).toISOString(), fxExpiresAt: new Date(exp).toISOString(),
    });
    expect(fxProvenanceFor('platform', '2026-10-02', at, undefined)).not.toHaveProperty('fxExpiresAt');
    expect(fxProvenanceFor('partner_push', undefined, at, Number.NaN)).not.toHaveProperty('fxExpiresAt');
    expect(fxProvenanceFor('b2b_lock', undefined, at, exp)).toEqual({ fxSource: 'b2b_lock' });
  });

  it('re-quote: platform, the ECB provider, the fixing date and the fetch time, persisted', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    const date = dayAgo(1);
    stubDated(date);
    const before = Date.now();
    const t = await createTransfer(store, partnerStore, mvs, base);
    const saved = await store.getTransfer(t.id);
    expect(saved).toMatchObject({ fxSource: 'platform', fxProvider: FX_PROVIDER_ID, fxAsOf: date });
    const fetched = Date.parse(saved!.fxFetchedAt!);
    expect(fetched).toBeGreaterThanOrEqual(before - 1_000);
    expect(fetched).toBeLessThanOrEqual(Date.now());
  });

  it('re-quote with the ECB file serving: the row names the ECB provider (Oct 7 ECB source)', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    const date = dayAgo(1);
    setEcbSourceForTests(true);
    try {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (String(url) === ECB_DAILY_URL) {
          return { ok: true, text: async () => `<Cube time='${date}'><Cube currency='USD' rate='1.1269'/><Cube currency='INR' rate='108.6615'/>` };
        }
        throw new Error('Frankfurter must not be called while the ECB file answers');
      }));
      const t = await createTransfer(store, partnerStore, mvs, base);
      expect(await store.getTransfer(t.id)).toMatchObject({ fxSource: 'platform', fxProvider: ECB_PROVIDER_ID, fxAsOf: date });
    } finally {
      setEcbSourceForTests(undefined);
    }
  });

  it('override: a draft that names its rate provider stamps it (Oct 7 ECB source)', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    const at = Date.now() - 5 * 60_000;
    const t = await createTransfer(store, partnerStore, mvs, {
      ...base, quote: { ...override, fxFetchedAt: at, fxAsOf: dayAgo(1), fxOrigin: 'platform', fxProvider: ECB_PROVIDER_ID },
    });
    expect(await store.getTransfer(t.id)).toMatchObject({ fxSource: 'platform', fxProvider: ECB_PROVIDER_ID });
  });

  it('re-quote with its own destination leg: the OLDER leg\'s date', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    stubDated(dayAgo(1), dayAgo(3));
    const t = await createTransfer(store, partnerStore, mvs, { ...base, destinationCountry: 'SG', destinationCurrency: 'SGD' });
    expect((await store.getTransfer(t.id))?.fxAsOf).toBe(dayAgo(3));
  });

  it('override: the draft\'s origin, date and fetch time (platform and partner push)', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    const at = Date.now() - 5 * 60_000;
    const p = await createTransfer(store, partnerStore, mvs, {
      ...base, quote: { ...override, fxFetchedAt: at, fxAsOf: dayAgo(1), fxOrigin: 'platform' },
    });
    expect(await store.getTransfer(p.id)).toMatchObject({
      fxSource: 'platform', fxProvider: FX_PROVIDER_ID, fxAsOf: dayAgo(1), fxFetchedAt: new Date(at).toISOString(),
    });
    await seedPartner(db, 'rail-partner-x');
    const r = await createTransfer(store, partnerStore, mvs, {
      ...base, phone: '15551234568',
      quote: { ...override, fxRate: 86, amountInr: 17_200, fxFetchedAt: at, fxAsOf: dayAgo(1), fxOrigin: 'partner_push', routeExpiresAt: Date.now() + 600_000 },
      settlementPartnerId: 'rail-partner-x',
    });
    const routed = await store.getTransfer(r.id);
    expect(routed).toMatchObject({ fxSource: 'partner_push', fxProvider: 'partner', fxFetchedAt: new Date(at).toISOString() });
    expect(routed?.fxAsOf).toBeUndefined();
    expect(routed?.fxExpiresAt).toBeDefined();
    expect(await store.getTransfer(p.id)).not.toHaveProperty('fxExpiresAt');
  });

  it('review finding 1: a routed mint on a push expiring in 5 min is payable at +4 min and routed_stale at +6 min', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await seedPartner(db, 'rail-partner-x');
    const mintAt = Date.now();
    const expiresAt = mintAt + 5 * 60_000;
    const r = await createTransfer(store, partnerStore, mvs, {
      ...base,
      quote: { ...override, fxRate: 86, amountInr: 17_200, fxFetchedAt: mintAt - 60_000, fxOrigin: 'partner_push', routeExpiresAt: expiresAt },
      settlementPartnerId: 'rail-partner-x',
    });
    const saved = (await store.getTransfer(r.id))!;
    expect(saved.fxExpiresAt).toBe(new Date(expiresAt).toISOString());
    const noFetch = { getFxRates: vi.fn(), getDestinationRates: vi.fn() };
    expect(await checkMintedRate(saved, mintAt + 4 * 60_000, noFetch)).toEqual({ ok: true });
    expect(await checkMintedRate(saved, mintAt + 6 * 60_000, noFetch)).toEqual({ ok: false, reason: 'routed_stale' });
    expect(noFetch.getFxRates).not.toHaveBeenCalled();
  });

  it('a watchlist-blocked mint keeps the provenance too', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    stubDated(dayAgo(1));
    const t = await createTransfer(store, partnerStore, mvs, { ...base, recipientName: 'John Doe' });
    expect(t.status).toBe('blocked');
    expect(await store.getTransfer(t.id)).toMatchObject({ fxSource: 'platform', fxAsOf: dayAgo(1) });
  });

  it('recordBlockedAttempt stamps the quote-time provenance it is given', async () => {
    const { store } = await makeStores();
    const at = Date.now() - 60_000;
    const t = await recordBlockedAttempt(store, {
      phone: '15551234567', recipientName: 'John Doe', recipientPhone: '919133001840',
      payoutMethod: 'bank', payoutDestination: '', fundingMethod: 'bank_transfer',
      amountUsd: 100, amountSource: 100, sourceCurrency: 'USD', feeUsd: 0, feeSource: 0,
      fxRate: 85, amountInr: 8500, totalChargeUsd: 100, totalChargeSource: 100,
      destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'default',
      reasons: ['Recipient is on the compliance watchlist.'],
      fxOrigin: 'platform', fxAsOf: dayAgo(1), fxFetchedAt: at,
    });
    expect(await store.getTransfer(t.id)).toMatchObject({
      fxSource: 'platform', fxProvider: FX_PROVIDER_ID, fxAsOf: dayAgo(1), fxFetchedAt: new Date(at).toISOString(),
    });
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

  it('a partner tightening is a STRUCTURED cap refusal (per-transfer $100 refuses $150); a $900,000 T1 cap clamps to the $10,000 ceiling (fix 16b)', async () => {
    const { db, store, partnerStore, mvs } = await t1Stores();
    await db.execute(sql`UPDATE partners SET send_limits = '{"perTransferCapCents":10000,"t1DailyCapCents":90000000}'::jsonb WHERE id = 'default'`);
    // Fix 16b keeps fix 16's refusal mapping: a tightening is refused by evaluateCap
    // (SendCapError → 422 / 'cap' / cap_eval), never pre-empted by the quote ceiling.
    await expect(createTransfer(store, partnerStore, mvs, { ...base, phone: T1_PHONE, amountSource: 150 }))
      .rejects.toMatchObject({ evaluation: { reason: 'over_per_transfer_cap', perTransferCapCents: 10_000, dailyCapCents: 1_000_000 } });
    const ok = await createTransfer(store, partnerStore, mvs, { ...base, phone: T1_PHONE, amountSource: 90 });
    expect(ok.status).toBe('awaiting_payment');
  });

  // ── Program fix 16b (Task 10b, test 8): a raise lifts ONLY the dollar caps ──
  describe('a raised customer ($5,000 per transfer, T1 $5,000) — only the dollar caps move (fix 16b)', () => {
    const RAISE = '{"perTransferCapCents":500000,"t1DailyCapCents":500000}';
    async function raised(phone: string, opts: { firstSeenDaysAgo: number; kycStatus: string }) {
      const s = await makeStores();
      await seedSender(s.db, { partnerId: 'default', phone, ...opts });
      await s.db.execute(sql`UPDATE customers SET send_limit_override = ${RAISE}::jsonb WHERE partner_id = 'default' AND phone = ${phone}`);
      return s;
    }

    it('in T0 (day 1) is STILL capped at $500/day — the tier gate is never raised', async () => {
      const { store, partnerStore, mvs } = await raised(T0_PHONE, { firstSeenDaysAgo: 0, kycStatus: 'verified' });
      await expect(createTransfer(store, partnerStore, mvs, { ...base, phone: T0_PHONE, amountSource: 600 }))
        .rejects.toMatchObject({ evaluation: { tier: 'T0', reason: 'over_per_transfer_cap', dailyCapCents: 50_000, perTransferCapCents: 50_000 } });
      const ok = await createTransfer(store, partnerStore, mvs, { ...base, phone: T0_PHONE, amountSource: 500 });
      expect(ok.status).toBe('awaiting_payment');
    });

    it('once Suspended (KYC rejected) is still refused', async () => {
      const { store, partnerStore, mvs } = await raised(T1_PHONE, { firstSeenDaysAgo: 10, kycStatus: 'rejected' });
      await expect(createTransfer(store, partnerStore, mvs, { ...base, phone: T1_PHONE, amountSource: 100, requiresKyc: false, senderKycStatus: 'rejected' }))
        .rejects.toMatchObject({ evaluation: { tier: 'Suspended', reason: 'verification_rejected', dailyCapCents: 0 } });
      expect(await store.listTransfersByPhone('default', T1_PHONE, 5)).toEqual([]);
    });

    it('$4,000 without the EDD fields mints FLAGGED edd_required; with them eddRequired is true (EDD still applies)', async () => {
      const { store, partnerStore, mvs } = await raised(T1_PHONE, { firstSeenDaysAgo: 10, kycStatus: 'verified' });
      const a = await createTransfer(store, partnerStore, mvs, { ...base, phone: T1_PHONE, amountSource: 4000 });
      expect(a.status).toBe('awaiting_payment');
      expect(a.complianceStatus).toBe('flagged');
      expect(a.complianceReasons).toContain('edd_required');
      expect(a.eddRequired).toBe(true);
      // A second raised sender WITH the EDD profile: eddRequired stays true, no edd_required flag.
      const other = '15550160003';
      const s2 = await raised(other, { firstSeenDaysAgo: 10, kycStatus: 'verified' });
      const b = await createTransfer(s2.store, s2.partnerStore, s2.mvs, {
        ...base, phone: other, amountSource: 4000, sourceOfFunds: 'employment', occupation: 'salaried',
      });
      expect(b.eddRequired).toBe(true);
      expect(b.complianceReasons).not.toContain('edd_required');
      expect(b.amountUsd).toBe(4000);
    });

    it('sending to a watchlisted recipient still writes a blocked row (sanctions untouched)', async () => {
      const { store, partnerStore, mvs } = await raised(T1_PHONE, { firstSeenDaysAgo: 10, kycStatus: 'verified' });
      const t = await createTransfer(store, partnerStore, mvs, { ...base, phone: T1_PHONE, amountSource: 4000, recipientName: 'John Doe' });
      expect(t.status).toBe('blocked');
      expect(t.complianceStatus).toBe('blocked');
      expect((await store.senderTotals('default', T1_PHONE)).todayUsdCents).toBe(0); // never consumes cap
    });
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

// ── Program-Fix 14: sanctions screening evidence, written in the SAME transaction ──
type AuditRow = { partner_id: string | null; actor: string; actor_type: string; action: string; subject_id: string | null; meta: Record<string, unknown> };
async function screenRows(db: Awaited<ReturnType<typeof freshDb>>): Promise<AuditRow[]> {
  const r = (await db.execute(
    sql`SELECT partner_id, actor, actor_type, action, subject_id, meta FROM audit_events WHERE action = 'sanctions.screen' ORDER BY id`,
  )) as unknown as { rows: AuditRow[] };
  return r.rows;
}
async function transferCount(db: Awaited<ReturnType<typeof freshDb>>): Promise<number> {
  const r = (await db.execute(sql`SELECT count(*)::int AS n FROM transfers`)) as unknown as { rows: Array<{ n: number }> };
  return r.rows[0].n;
}

describe('createTransfer — sanctions.screen evidence (Program-Fix 14)', () => {
  it('a CLEARED mint writes exactly one sanctions.screen row bound to the transfer', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    const t = await createTransfer(store, partnerStore, mvs, { ...base, senderName: 'Clean Person' });
    expect(t.complianceStatus).toBe('cleared');
    const rows = await screenRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      partner_id: 'default', actor: 'system:sanctions', actor_type: 'system', action: 'sanctions.screen', subject_id: t.id,
    });
    expect(rows[0].meta).toMatchObject({ listSource: 'mock-watchlist', decision: 'clear' });
    expect((rows[0].meta.parties as Array<{ role: string }>).map((p) => p.role)).toEqual(['recipient', 'sender']);
  });

  it('a FLAGGED (large amount) mint writes one row too', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await t1(db, '15550170001');
    const t = await createTransfer(store, partnerStore, mvs, { ...base, phone: '15550170001', amountSource: 1500 });
    expect(t.complianceStatus).toBe('flagged');
    const rows = await screenRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].subject_id).toBe(t.id);
  });

  it('a BLOCKED mint (a formatting variant of a listed name) writes the blocked row + one evidence row, with no name in meta', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    const t = await createTransfer(store, partnerStore, mvs, { ...base, recipientName: 'John  Doe' });
    expect(t.status).toBe('blocked');
    const rows = await screenRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].subject_id).toBe(t.id);
    expect(rows[0].meta).toMatchObject({ decision: 'match', listSource: 'mock-watchlist' });
    const p0 = (rows[0].meta.parties as Array<Record<string, unknown>>)[0];
    expect(p0).toMatchObject({ role: 'recipient', matched: true, matchScore: 1, matchedEntryId: 'mock:0' });
    const persisted = JSON.stringify(rows[0].meta).toLowerCase();
    expect(persisted).not.toContain('john');
    expect(persisted).not.toContain('doe');
  });

  it('a SendCapError rollback leaves NEITHER the transfer nor the evidence row', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await expect(createTransfer(store, partnerStore, mvs, { ...base, phone: '15550170002', amountSource: 600 }))
      .rejects.toBeInstanceOf(SendCapError);
    expect(await transferCount(db)).toBe(0);
    expect(await screenRows(db)).toHaveLength(0);
  });

  it('a masked-destination refusal leaves no evidence row', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await expect(createTransfer(store, partnerStore, mvs, { ...base, payoutMethod: 'bank', payoutDestination: '****9012' }))
      .rejects.toThrow();
    expect(await screenRows(db)).toHaveLength(0);
  });

  it('a same-id replay does not screen again (still exactly one row)', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await createTransfer(store, partnerStore, mvs, { ...base, id: 'ev_replay_1' });
    await createTransfer(store, partnerStore, mvs, { ...base, id: 'ev_replay_1' });
    const rows = await screenRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].subject_id).toBe('ev_replay_1');
  });
});

describe('recordBlockedAttempt — quote-time evidence in ONE transaction (Program-Fix 14 step 5)', () => {
  const blocked = {
    phone: '15551234567', recipientName: 'John Doe', recipientPhone: '919133001840',
    payoutMethod: 'bank' as const, payoutDestination: '', fundingMethod: 'bank_transfer' as const,
    amountUsd: 100, amountSource: 100, sourceCurrency: 'USD' as const, feeUsd: 1.99, feeSource: 1.99,
    fxRate: 85, amountInr: 8500, totalChargeUsd: 101.99, totalChargeSource: 101.99,
    destinationCountry: 'IN' as const, destinationCurrency: 'INR' as const, partnerId: 'default',
    reasons: ['Recipient is on the compliance watchlist.'],
  };
  const evidence = {
    listSource: 'mock-watchlist', listVersion: 'static', listHash: 'a'.repeat(64),
    screenedAt: new Date().toISOString(), decision: 'match' as const,
    parties: [{ role: 'recipient' as const, inputHash: 'b'.repeat(64), matched: true, matchScore: 1, matchedEntryId: 'mock:0' }],
  };

  it('with evidence: exactly one blocked transfer + one sanctions.screen row whose subject is the new id', async () => {
    const { db, store } = await makeStores();
    const t = await recordBlockedAttempt(store, { ...blocked, evidence });
    expect(await transferCount(db)).toBe(1);
    const rows = await screenRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partner_id: 'default', actor: 'system:sanctions', actor_type: 'system', subject_id: t.id });
    expect(rows[0].meta).toMatchObject({ decision: 'match', listSource: 'mock-watchlist' });
  });

  it('without evidence: today\'s behaviour (the row only, no evidence row)', async () => {
    const { db, store } = await makeStores();
    await recordBlockedAttempt(store, blocked);
    expect(await transferCount(db)).toBe(1);
    expect(await screenRows(db)).toHaveLength(0);
  });

  it('an audit insert failure leaves NEITHER row (recordBlockedWithEvidence is one transaction)', async () => {
    const { db, store } = await makeStores();
    const t = { ...(await recordBlockedAttempt(store, blocked)), id: 'blk_atomic_1' };
    await db.execute(sql`DELETE FROM transfers`);
    await expect(store.recordBlockedWithEvidence(t, {
      partnerId: 'default', actor: null as never, actorType: 'system', action: 'sanctions.screen', subjectId: t.id, meta: {},
    })).rejects.toThrow();
    expect(await transferCount(db)).toBe(0);
    expect(await screenRows(db)).toHaveLength(0);
  });
});

describe('store.recordAudit (root handle; register_seller evidence)', () => {
  it('writes one audit_events row', async () => {
    const { db, store } = await makeStores();
    await store.recordAudit({ partnerId: 'default', actor: 'system:sanctions', actorType: 'system', action: 'sanctions.screen', subjectId: 's_1', meta: { decision: 'clear' } });
    expect(await screenRows(db)).toHaveLength(1);
  });
});

// ── Program-Fix 14 PR C: transfers.screening (migration 0023, B3) ─────────────
async function screeningOf(db: Awaited<ReturnType<typeof freshDb>>, id: string): Promise<Record<string, unknown> | null> {
  const r = (await db.execute(sql`SELECT screening FROM transfers WHERE id = ${id}`)) as unknown as {
    rows: Array<{ screening: Record<string, unknown> | null }>;
  };
  return r.rows[0]?.screening ?? null;
}

describe('createTransfer — transfers.screening carries the mint evidence (Program-Fix 14 PR C)', () => {
  it('cleared, flagged and blocked mints each store the SAME evidence as their sanctions.screen row', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await t1(db, '15550170011');
    const cleared = await createTransfer(store, partnerStore, mvs, { ...base, senderName: 'Clean Person' });
    const flagged = await createTransfer(store, partnerStore, mvs, { ...base, phone: '15550170011', amountSource: 1500 });
    const blocked = await createTransfer(store, partnerStore, mvs, { ...base, recipientName: 'Doe, John' });
    expect([cleared.complianceStatus, flagged.complianceStatus, blocked.status]).toEqual(['cleared', 'flagged', 'blocked']);
    const rows = await screenRows(db);
    for (const t of [cleared, flagged, blocked]) {
      const s = await screeningOf(db, t.id);
      expect(s, t.id).not.toBeNull();
      expect(s).toEqual(rows.find((r) => r.subject_id === t.id)!.meta);
    }
    expect((await screeningOf(db, blocked.id))!).toMatchObject({ decision: 'match' });
    const all = JSON.stringify(await Promise.all([cleared, flagged, blocked].map((t) => screeningOf(db, t.id)))).toLowerCase();
    for (const name of ['clean person', 'john', 'doe', 'mom']) expect(all).not.toContain(name);
  });

  it('is never mapped onto the domain Transfer (it cannot leak into an API response)', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    const t = await createTransfer(store, partnerStore, mvs, { ...base });
    expect('screening' in t).toBe(false);
    const read = await store.getTransfer(t.id);
    expect(read && 'screening' in read).toBe(false);
  });

  it('is insert-only: a read-modify-write saveTransfer keeps it', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    const t = await createTransfer(store, partnerStore, mvs, { ...base });
    const before = await screeningOf(db, t.id);
    const read = (await store.getTransfer(t.id))!;
    await store.saveTransfer({ ...read, adminNote: 'touched' });
    expect(await screeningOf(db, t.id)).toEqual(before);
  });

  it('a SendCapError rollback leaves no transfer (and so no screening)', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await expect(createTransfer(store, partnerStore, mvs, { ...base, phone: '15550170012', amountSource: 600 }))
      .rejects.toBeInstanceOf(SendCapError);
    expect(await transferCount(db)).toBe(0);
  });
});

describe('recordBlockedAttempt — transfers.screening (Program-Fix 14 PR C)', () => {
  const blocked = {
    phone: '15551234567', recipientName: 'John Doe', recipientPhone: '919133001840',
    payoutMethod: 'bank' as const, payoutDestination: '', fundingMethod: 'bank_transfer' as const,
    amountUsd: 100, amountSource: 100, sourceCurrency: 'USD' as const, feeUsd: 1.99, feeSource: 1.99,
    fxRate: 85, amountInr: 8500, totalChargeUsd: 101.99, totalChargeSource: 101.99,
    destinationCountry: 'IN' as const, destinationCurrency: 'INR' as const, partnerId: 'default',
    reasons: ['Recipient is on the compliance watchlist.'],
  };
  const evidence = {
    listSource: 'mock-watchlist', listVersion: 'static', listHash: 'a'.repeat(64),
    screenedAt: new Date().toISOString(), decision: 'match' as const,
    parties: [{ role: 'recipient' as const, inputHash: 'b'.repeat(64), matched: true, matchScore: 1, matchedEntryId: 'mock:0' }],
  };

  it('with evidence: the blocked row stores it', async () => {
    const { db, store } = await makeStores();
    const t = await recordBlockedAttempt(store, { ...blocked, evidence });
    expect(await screeningOf(db, t.id)).toEqual(evidence);
  });

  it('without evidence: NULL (today\'s behaviour)', async () => {
    const { db, store } = await makeStores();
    const t = await recordBlockedAttempt(store, blocked);
    expect(await screeningOf(db, t.id)).toBeNull();
  });
});

describe('createTransfer with SANCTIONS_LIST=ofac-sdn (Program-Fix 14 PR C)', () => {
  const original = process.env.SANCTIONS_LIST;
  afterEach(() => {
    if (original === undefined) delete process.env.SANCTIONS_LIST;
    else process.env.SANCTIONS_LIST = original;
    setOfacListSourceForTests(null);
  });

  it('no loaded list version FAILS CLOSED: the mint is flagged list_unavailable (never cleared)', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    process.env.SANCTIONS_LIST = 'ofac-sdn';
    setOfacListSourceForTests(new PostgresSanctionsListSource(() => createSanctionsListRepo(db)));
    const t = await createTransfer(store, partnerStore, mvs, { ...base });
    expect(t.complianceStatus).toBe('flagged');
    expect(await screeningOf(db, t.id)).toMatchObject({ decision: 'list_unavailable', listSource: 'ofac-sdn' });
  });

  it('refreshes the list BEFORE the sender lock; inside the lock nothing reads the list tables', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    process.env.SANCTIONS_LIST = 'ofac-sdn';
    await createSanctionsListRepo(db).storeList(
      parseOfacSdnXml(readFileSync(join(__dirname, 'fixtures', 'ofac-sdn-sample.xml'), 'utf8')),
    );
    setOfacListSourceForTests(new PostgresSanctionsListSource(() => createSanctionsListRepo(db)));
    const stop = captureQueries();
    const t = await createTransfer(store, partnerStore, mvs, { ...base, recipientName: 'FIXTURELLI, Testa' });
    const q = stop().map((x) => x.sql);
    expect(t.status).toBe('blocked');
    const lockAt = q.findIndex((s) => s.includes('pg_advisory_xact_lock'));
    expect(lockAt).toBeGreaterThan(-1);
    const listReads = q.map((s, i) => (s.includes('sanctions_list_') ? i : -1)).filter((i) => i >= 0);
    expect(listReads.length).toBeGreaterThan(0);
    expect(Math.max(...listReads)).toBeLessThan(lockAt);
  });
});

// ── A5: the free first transfer is decided UNDER the sender lock ──────────
// Before: the fee-tier count was read OUTSIDE mintUnderSenderLock, so two
// concurrent first mints (or two drafts both quoted at count 0) were both free.
describe('createTransfer — first-transfer fee tier is re-read under the sender lock (A5)', () => {
  const FREE_OVERRIDE = {
    amountUsd: 200, feeUsd: 0, totalChargeUsd: 200, fxRate: 85,
    amountInr: 17_000, amountSource: 200, feeSource: 0, totalChargeSource: 200,
  };

  it('two concurrent first mints for the same phone ⇒ exactly one has fee 0', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    const phone = '15558870001';
    const [a, b] = await Promise.all([
      createTransfer(store, partnerStore, mvs, { ...base, phone }),
      createTransfer(store, partnerStore, mvs, { ...base, phone }),
    ]);
    const fees = [a.feeUsd, b.feeUsd].sort();
    expect(fees).toEqual([0, 1.99]);
    const paid = [a, b].find((t) => t.feeUsd === 1.99)!;
    expect(paid.totalChargeUsd).toBe(201.99);
    expect(paid.feeSource).toBe(1.99);
    expect(paid.totalChargeSource).toBe(201.99);
  });

  it('an approved $0 draft quote minted after another transfer exists ⇒ stale_quote, nothing minted', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    const phone = '15558870002';
    await createTransfer(store, partnerStore, mvs, { ...base, phone }); // the first (free) transfer
    await expect(
      createTransfer(store, partnerStore, mvs, { ...base, phone, id: 'tr_stale_free', quote: FREE_OVERRIDE }),
    ).rejects.toMatchObject({ name: 'RateUnavailableError', reason: 'stale_quote' });
    expect(await store.getTransfer('tr_stale_free')).toBeNull();
    expect(await store.getTransferCount('default', phone)).toBe(1);
  });

  it('an approved $0 draft quote is still honoured while the sender has no transfer', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    const t = await createTransfer(store, partnerStore, mvs, { ...base, phone: '15558870003', quote: FREE_OVERRIDE });
    expect([t.feeUsd, t.totalChargeUsd]).toEqual([0, 200]);
  });

  it('two concurrent mints of approved $0 drafts ⇒ one mints, the other is stale_quote', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    const phone = '15558870004';
    const results = await Promise.allSettled([
      createTransfer(store, partnerStore, mvs, { ...base, phone, quote: FREE_OVERRIDE }),
      createTransfer(store, partnerStore, mvs, { ...base, phone, quote: FREE_OVERRIDE }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(RateUnavailableError);
    expect((rejected[0].reason as RateUnavailableError).reason).toBe('stale_quote');
    expect(await store.getTransferCount('default', phone)).toBe(1);
  });

  it('a prior BLOCKED row keeps the first transfer free on the locked re-read', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    const phone = '15558870005';
    await seedLedgerSpend(db, { partnerId: 'default', phone, amountUsd: 50, status: 'blocked' });
    const t = await createTransfer(store, partnerStore, mvs, { ...base, phone, quote: FREE_OVERRIDE });
    expect(t.feeUsd).toBe(0);
  });
});
