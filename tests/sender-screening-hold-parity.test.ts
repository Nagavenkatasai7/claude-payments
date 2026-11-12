import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createTransferRepo, senderClearForPartnerRelease } from '@/db/repos/transfer-repo';
import { transfers } from '@/db/schema';
import { createCustomerRepo, readSenderScreeningFlags } from '@/db/repos/customer-repo';
import { releaseHold } from '@/lib/settlement';
import {
  canDecideCustomerKyc,
  isPartnerReleasableHold,
  isScreeningCustomerHold,
  LARGE_AMOUNT_REASON,
} from '@/lib/compliance-config';
import { canReleaseHeld } from '@/lib/dashboard-ops';
import { partnerKycDecision, partnerMayRejectHold } from '@/lib/partner-reviews';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';
import type { PartnerIntegrations } from '@/lib/partner-integrations';

// Fix pack 2 review F2 (A2, B1): ONE rule for "the sender is under a screening hold" on every path
// partner staff can decide: a PEP / watchlist boolean hit, OR a stamped screening_flagged_at that
// no LATER screening_cleared_at covers (a stale whole-row saveCustomer can null the booleans; the
// stamp survives it). The SQL claim (senderClearForPartnerRelease, used by markPaidIfInReview with
// partnerRelease and by cancelInReviewForPartner) and the TypeScript rule (isScreeningCustomerHold,
// and through it isPartnerReleasableHold / canReleaseHeld / partnerMayRejectHold /
// partnerKycDecision / canDecideCustomerKyc) run the SAME table here and must agree.

const SENDER = '15551230000';
const SIMULATOR: PartnerIntegrations = {
  kyc: {},
  payment: {
    providerType: 'simulator',
    credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 's' },
    webhookSecret: 'w',
  },
  whatsapp: {},
};

function heldRow(over: Partial<Transfer> = {}): Transfer {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  return {
    id: 'ssp_t1', phone: SENDER, amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'in_review', complianceStatus: 'flagged', complianceReasons: [LARGE_AMOUNT_REASON],
    createdAt: minutesAgo(30), paidAt: minutesAgo(20), partnerId: 'pa',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
    ...over,
  } as Transfer;
}

// Times relative to now (never calendar dates): minutes from now, null = column NULL.
interface Case {
  name: string;
  pep: boolean | null;
  watchlist: boolean | null;
  flaggedMin: number | null;
  clearedMin: number | null;
  held: boolean;
  /** Fix pack 7 (P22, T9): the rule with { pepClearable: true } (a cleared PEP-only hit lifts). */
  heldPepClearable: boolean;
  /** Fix pack 7 (R2): screening_watchlist_at, minutes from now (absent = NULL). */
  watchlistMin?: number | null;
}

const CASES: Case[] = [
  { name: 'clean row (all NULL)', pep: null, watchlist: null, flaggedMin: null, clearedMin: null, held: false, heldPepClearable: false },
  { name: 'explicit false booleans, no stamp', pep: false, watchlist: false, flaggedMin: null, clearedMin: null, held: false, heldPepClearable: false },
  { name: 'pep_hit true', pep: true, watchlist: null, flaggedMin: null, clearedMin: null, held: true, heldPepClearable: true },
  { name: 'watchlist_hit true', pep: null, watchlist: true, flaggedMin: null, clearedMin: null, held: true, heldPepClearable: true },
  { name: 'stamp only, booleans NULL (stale upsert), no clear', pep: null, watchlist: null, flaggedMin: -10, clearedMin: null, held: true, heldPepClearable: true },
  { name: 'stamp only, booleans false, no clear', pep: false, watchlist: false, flaggedMin: -10, clearedMin: null, held: true, heldPepClearable: true },
  { name: 'stamp then a LATER clear', pep: null, watchlist: null, flaggedMin: -10, clearedMin: -5, held: false, heldPepClearable: false },
  { name: 'stamp after an EARLIER clear (re-flagged)', pep: null, watchlist: null, flaggedMin: -5, clearedMin: -10, held: true, heldPepClearable: true },
  { name: 'stamp and clear at the same instant (tie stays held)', pep: null, watchlist: null, flaggedMin: -7, clearedMin: -7, held: true, heldPepClearable: true },
  { name: 'a clear with no stamp, booleans NULL', pep: null, watchlist: null, flaggedMin: null, clearedMin: -5, held: false, heldPepClearable: false },
  { name: 'pep_hit true, stamp covered by a later clear (a boolean still holds for partner staff)', pep: true, watchlist: null, flaggedMin: -10, clearedMin: -5, held: true, heldPepClearable: false },
  { name: 'watchlist_hit true, a clear with no stamp', pep: null, watchlist: true, flaggedMin: null, clearedMin: -5, held: true, heldPepClearable: true },
  // Fix pack 7 (P22, R2, T9): the pepClearable rule. A watchlist hit always holds; a PEP-only hit lifts with a later clear.
  { name: 'pep_hit true, a clear with no stamp', pep: true, watchlist: null, flaggedMin: null, clearedMin: -5, held: true, heldPepClearable: false },
  { name: 'watchlist_hit true and pep_hit true, stamp then a later clear', pep: true, watchlist: true, flaggedMin: -10, clearedMin: -5, held: true, heldPepClearable: true },
  { name: 'pep_hit true, a watchlist stamp covered by a later clear', pep: true, watchlist: null, flaggedMin: -10, watchlistMin: -10, clearedMin: -5, held: true, heldPepClearable: false },
  { name: 'pep_hit true, a stale save nulled watchlist_hit, its watchlist stamp not cleared', pep: true, watchlist: null, flaggedMin: -5, watchlistMin: -5, clearedMin: -10, held: true, heldPepClearable: true },
  { name: 'pep_hit true, a watchlist stamp and a clear at the same instant (tie stays held)', pep: true, watchlist: null, flaggedMin: -10, watchlistMin: -7, clearedMin: -7, held: true, heldPepClearable: true },
];

let db: Db;
let store: ReturnType<typeof createStore>;
// One base instant per test, truncated to the millisecond (JS Dates are ms; the stamp writers write JS Dates).
let base: number;
const at = (min: number | null) => (min === null ? null : new Date(base + min * 60_000));

async function seedSender(c: Case, phone = SENDER): Promise<void> {
  await createCustomerRepo(db, async () => null).ensureCustomer('pa', phone);
  await db.execute(sql`UPDATE customers SET pep_hit = ${c.pep}, watchlist_hit = ${c.watchlist},
    screening_flagged_at = ${at(c.flaggedMin)}, screening_cleared_at = ${at(c.clearedMin)},
    screening_watchlist_at = ${at(c.watchlistMin ?? null)}
    WHERE partner_id = 'pa' AND phone = ${phone}`);
}
const status = async (id = 'ssp_t1') => (await store.getTransfer(id))?.status;
const count = async (table: 'audit_events' | 'outbox') => {
  const r = (await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`))) as unknown as { rows: Array<{ n: number }> };
  return r.rows[0].n;
};

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  await seedPartner(db, 'pa');
  await store.saveTransfer(heldRow());
  base = Date.now();
});

describe('sender screening hold: the SQL claim and the TypeScript rule agree', () => {
  it.each(CASES)('$name -> held=$held', async (c) => {
    await seedSender(c);
    const flags = await readSenderScreeningFlags(db, 'pa', SENDER);
    expect(flags).not.toBeNull();
    const customer = await createCustomerRepo(db, async () => null).getCustomer('pa', SENDER);

    // TypeScript rule, on the flags the release path reads AND on the Customer the KYC paths read.
    expect(isScreeningCustomerHold(flags!)).toBe(c.held);
    expect(isScreeningCustomerHold(customer!)).toBe(c.held);
    const t = (await store.getTransfer('ssp_t1'))!;
    const delegated = { kycMode: 'delegated' as const };
    expect(isPartnerReleasableHold(t, delegated, flags)).toBe(!c.held);
    expect(canReleaseHeld({ kind: 'partner', partnerId: 'pa' }, delegated, t, flags)).toBe(!c.held);
    expect(partnerMayRejectHold(t, delegated, flags)).toBe(!c.held);
    expect(canDecideCustomerKyc({ kind: 'partner' }, customer!)).toBe(!c.held);
    expect(canDecideCustomerKyc({ kind: 'platform' }, customer!)).toBe(true);
    if (c.held) expect(partnerKycDecision(delegated, { ...customer!, kycReviewState: 'needs_review' }, 'approve')).toEqual({ ok: false });

    // SQL rule: the partner reject claim (rolls nothing forward on refusal) ...
    await store.saveTransfer(heldRow({ id: 'ssp_rej' }));
    const rejected = await createTransferRepo(db).cancelInReviewForPartner('ssp_rej', 'pa', 'note');
    expect(rejected === null).toBe(c.held);
    // ... and the partner release claim.
    const claimed = await createTransferRepo(db).markPaidIfInReview('ssp_t1', { partnerId: 'pa' });
    expect(claimed === null).toBe(c.held);
    expect(await status()).toBe(c.held ? 'in_review' : 'paid');
  });
});

// Fix pack 7 (P22, T9): the pepClearable twin. The TS rule with the option and the exported SQL
// twin with the option run the same table; without the option the SQL text is byte-identical.
describe('sender screening hold with pepClearable: the SQL twin and the TypeScript rule agree', () => {
  it.each(CASES)('$name -> pepClearable held=$heldPepClearable', async (c) => {
    await seedSender(c);
    const flags = await readSenderScreeningFlags(db, 'pa', SENDER);
    const customer = await createCustomerRepo(db, async () => null).getCustomer('pa', SENDER);
    expect(isScreeningCustomerHold(flags!, { pepClearable: true })).toBe(c.heldPepClearable);
    expect(isScreeningCustomerHold(customer!, { pepClearable: true })).toBe(c.heldPepClearable);
    // The option absent or false: today's rule.
    expect(isScreeningCustomerHold(flags!, { pepClearable: false })).toBe(c.held);
    expect(isScreeningCustomerHold(flags!, {})).toBe(c.held);
    const rows = await db
      .select({ id: transfers.id })
      .from(transfers)
      .where(and(eq(transfers.id, 'ssp_t1'), ...senderClearForPartnerRelease('pa', { pepClearable: true })));
    expect(rows).toHaveLength(c.heldPepClearable ? 0 : 1);
    // The tenant term stays: another partner never selects the row.
    const other = await db
      .select({ id: transfers.id })
      .from(transfers)
      .where(and(eq(transfers.id, 'ssp_t1'), ...senderClearForPartnerRelease('pb', { pepClearable: true })));
    expect(other).toHaveLength(0);
  });

  it("without the option the twin's SQL text is unchanged", () => {
    const q = (o?: { pepClearable?: boolean }) =>
      db.select({ id: transfers.id }).from(transfers).where(and(eq(transfers.id, 'ssp_t1'), ...senderClearForPartnerRelease('pa', o))).toSQL().sql;
    const pinned =
      '"customers"."pep_hit" IS NOT TRUE AND "customers"."watchlist_hit" IS NOT TRUE AND ("customers"."screening_flagged_at" IS NULL OR ("customers"."screening_cleared_at" IS NOT NULL AND "customers"."screening_cleared_at" > "customers"."screening_flagged_at"))';
    expect(q()).toContain(pinned);
    expect(q()).not.toContain('IS TRUE AND');
    expect(q()).not.toContain('screening_watchlist_at');
    expect(q({ pepClearable: false })).toBe(q());
    expect(q({})).toBe(q());
    expect(q({ pepClearable: true })).not.toContain('"customers"."pep_hit" IS NOT TRUE AND "customers"."watchlist_hit"');
    expect(q({ pepClearable: true })).toContain('screening_watchlist_at');
  });
});

describe('releaseHold with partnerRelease: a stamp-only hold refuses inside the claim', () => {
  it('booleans NULL, screening_flagged_at set and not cleared: already, row in_review, nothing enqueued or audited', async () => {
    await seedSender(CASES[4]!);
    const r = await releaseHold(db, (await store.getTransfer('ssp_t1'))!, SIMULATOR, { actor: 'pa-admin', reason: 'Source of funds verified.' }, { partnerId: 'pa' });
    expect(r).toEqual({ kind: 'already' });
    expect(await status()).toBe('in_review');
    expect(await count('outbox')).toBe(0);
    expect(await count('audit_events')).toBe(0);
  });

  it('the same row after a LATER platform clear releases: paid, one audit row, one rail effect', async () => {
    await seedSender(CASES[6]!);
    const r = await releaseHold(db, (await store.getTransfer('ssp_t1'))!, SIMULATOR, { actor: 'pa-admin', reason: 'Source of funds verified.' }, { partnerId: 'pa' });
    expect(r).toEqual({ kind: 'released', webhookDriven: true });
    expect(await status()).toBe('paid');
    expect(await count('audit_events')).toBe(1);
    expect(await count('outbox')).toBe(1);
  });
});
