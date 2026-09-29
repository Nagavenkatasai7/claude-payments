import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { releaseHold } from '@/lib/settlement';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner, captureQueries } from './helpers-db';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';
import type { PartnerIntegrations } from '@/lib/partner-integrations';

// M3-10 follow-up (owner, 2026-09-29): a PARTNER-scoped release claim (markPaidIfInReview with
// partnerRelease) re-checks, inside the SAME guarded UPDATE, that the transfer is in that tenant
// and its sender's customer row there exists with no PEP / watchlist hit. The platform claim (no
// partnerRelease) is byte-identical to before.

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

function held(over: Partial<Transfer> = {}): Transfer {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  return {
    id: 'prc_t1', phone: SENDER, amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'in_review', complianceStatus: 'flagged', complianceReasons: ['Large transfer amount.'],
    createdAt: minutesAgo(30), paidAt: minutesAgo(20), partnerId: 'pa',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
    ...over,
  } as Transfer;
}

let db: Db;
let store: ReturnType<typeof createStore>;
const ensureCustomer = (partnerId: string, phone = SENDER) =>
  createCustomerRepo(db, async () => null).ensureCustomer(partnerId, phone);
const setFlag = (partnerId: string, col: 'pep_hit' | 'watchlist_hit', v: boolean | null, phone = SENDER) =>
  db.execute(sql`UPDATE customers SET ${sql.raw(col)} = ${v} WHERE partner_id = ${partnerId} AND phone = ${phone}`);
const status = async (id = 'prc_t1') => (await store.getTransfer(id))?.status;
const count = async (table: 'audit_events' | 'outbox') => {
  const r = (await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`))) as unknown as { rows: Array<{ n: number }> };
  return r.rows[0].n;
};

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  await seedPartner(db, 'pa');
  await seedPartner(db, 'pb');
  await store.saveTransfer(held());
});

describe('markPaidIfInReview — platform claim is unchanged', () => {
  // Captured from the claim BEFORE this change (branch base d4ae0a20); the RETURNING list is left
  // out so a new transfers column does not break the pin.
  const PLATFORM_CLAIM =
    'update "transfers" set "status" = $1, "paid_at" = now() where ("transfers"."id" = $2 and "transfers"."status" = $3 and "transfers"."compliance_status" <> $4 and ("transfers"."funding_state" IS NULL OR "transfers"."funding_state" = \'succeeded\'))';

  it('without partnerRelease the statement is byte-identical to the pre-change claim (no customers read)', async () => {
    const stop = captureQueries();
    await createTransferRepo(db).markPaidIfInReview('prc_t1');
    const q = stop();
    expect(q).toHaveLength(1);
    expect(q[0].sql.split(' returning ')[0]).toBe(PLATFORM_CLAIM);
    expect(q[0].params).toEqual(['paid', 'prc_t1', 'in_review', 'blocked']);
  });

  it('without partnerRelease a PEP-flagged sender, or no customer row at all, still releases (platform staff)', async () => {
    await ensureCustomer('pa');
    await setFlag('pa', 'pep_hit', true);
    expect((await createTransferRepo(db).markPaidIfInReview('prc_t1'))?.status).toBe('paid');
    await store.saveTransfer(held({ id: 'prc_t2', phone: '15550009999' }));
    expect((await createTransferRepo(db).markPaidIfInReview('prc_t2'))?.status).toBe('paid');
  });
});

describe('markPaidIfInReview — partner claim re-checks the sender atomically', () => {
  const claim = (partnerId = 'pa', id = 'prc_t1') => createTransferRepo(db).markPaidIfInReview(id, { partnerId });

  it('the guarded statement qualifies the correlated columns (never binds to customers.phone)', async () => {
    const stop = captureQueries();
    await claim();
    const s = stop()[0].sql;
    expect(s).toContain('"customers"."partner_id" = "transfers"."partner_id"');
    expect(s).toContain('"customers"."phone" = "transfers"."phone"');
    expect(s).toContain('"customers"."pep_hit" IS NOT TRUE AND "customers"."watchlist_hit" IS NOT TRUE');
  });

  it('a sender with NULL flags (never screened as a hit) releases', async () => {
    await ensureCustomer('pa');
    expect((await claim())?.status).toBe('paid');
  });

  it('a sender with explicit false flags releases', async () => {
    await ensureCustomer('pa');
    await setFlag('pa', 'pep_hit', false);
    await setFlag('pa', 'watchlist_hit', false);
    expect((await claim())?.status).toBe('paid');
  });

  it.each(['pep_hit', 'watchlist_hit'] as const)('a sender with %s = true is refused; the row stays in_review', async (col) => {
    await ensureCustomer('pa');
    await setFlag('pa', col, true);
    expect(await claim()).toBeNull();
    expect(await status()).toBe('in_review');
  });

  it('a missing sender row is refused even when ANOTHER clean customer exists in the same tenant', async () => {
    await ensureCustomer('pa', '15557770000');
    expect(await claim()).toBeNull();
    expect(await status()).toBe('in_review');
  });

  it('a clean same-phone customer only under ANOTHER tenant does not satisfy the check', async () => {
    await ensureCustomer('pb');
    expect(await claim()).toBeNull();
    expect(await status()).toBe('in_review');
  });

  it("a flagged sender is not rescued by a clean same-phone customer in another tenant", async () => {
    await ensureCustomer('pa');
    await setFlag('pa', 'watchlist_hit', true);
    await ensureCustomer('pb');
    expect(await claim()).toBeNull();
  });

  it("a partnerRelease naming another tenant is refused (the row must be in that tenant)", async () => {
    await ensureCustomer('pa');
    await ensureCustomer('pb');
    expect(await claim('pb')).toBeNull();
    expect(await status()).toBe('in_review');
  });

  it('the existing guards still hold: blocked and not-in_review rows are refused', async () => {
    await ensureCustomer('pa');
    await store.saveTransfer(held({ id: 'prc_blk', complianceStatus: 'blocked' }));
    await store.saveTransfer(held({ id: 'prc_can', status: 'cancelled' }));
    expect(await claim('pa', 'prc_blk')).toBeNull();
    expect(await claim('pa', 'prc_can')).toBeNull();
  });
});

describe('releaseHold with partnerRelease — a refused claim writes nothing', () => {
  it('a flag raised after the caller read the transfer refuses: already, zero audit rows, zero outbox rows', async () => {
    await ensureCustomer('pa');
    const read = (await store.getTransfer('prc_t1'))!; // the caller's pre-check happened on this read
    await setFlag('pa', 'pep_hit', true); // flipped between the pre-check and the claim
    const r = await releaseHold(db, read, SIMULATOR, { actor: 'pa-admin', reason: 'Source of funds verified.' }, { partnerId: 'pa' });
    expect(r).toEqual({ kind: 'already' });
    expect(await status()).toBe('in_review');
    expect(await count('audit_events')).toBe(0);
    expect(await count('outbox')).toBe(0);
  });

  it('a clean sender releases through the same transaction: paid, one audit row, one rail effect', async () => {
    await ensureCustomer('pa');
    const r = await releaseHold(db, (await store.getTransfer('prc_t1'))!, SIMULATOR, { actor: 'pa-admin', reason: 'Source of funds verified.' }, { partnerId: 'pa' });
    expect(r).toEqual({ kind: 'released', webhookDriven: true });
    expect(await status()).toBe('paid');
    expect(await count('audit_events')).toBe(1);
    expect(await count('outbox')).toBe(1);
  });
});
