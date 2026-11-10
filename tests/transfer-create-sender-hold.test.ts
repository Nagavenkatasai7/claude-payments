import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTransfer } from '@/lib/transfer-create';
import { createStore, type SenderLedgerOps } from '@/lib/store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import {
  LIST_UNAVAILABLE_REASON,
  RECIPIENT_WATCHLIST_REASON,
  SENDER_SCREENING_REASON,
} from '@/lib/compliance-config';
import { resetRateCacheForTests } from '@/lib/rate';
import { fakeRedis } from './helpers';
import { captureQueries, freshDb, seedPartner, seedSender } from './helpers-db';
import { primeOfacSource, restoreOfacSource, setRailProviderType } from './helpers-sanctions';
import type { Db } from '@/db/client';

// Fix pack 2 T6 (R06): the sender screening hold at mint. A sender whose
// customer row carries a Persona watchlist / PEP hit (or a stamped flaggedAt)
// with no later platform clear is HELD (flagged + SENDER_SCREENING_REASON) on
// a real-money rail only. Demo, default tenant, simulator, mock and sandbox
// mints never read the flags.

const PHONE = '15550100088';
const HOUR = 3_600_000;
const ORIGINAL_LIST = process.env.SANCTIONS_LIST;

beforeEach(() => {
  delete process.env.SANCTIONS_LIST;
  resetRateCacheForTests();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85 } }) }));
});
afterEach(() => {
  restoreOfacSource(ORIGINAL_LIST);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

async function senderOn(db: Db, partnerId: string, rail?: string) {
  if (partnerId !== 'default') await seedPartner(db, partnerId);
  if (rail) await setRailProviderType(db, partnerId, rail);
  await seedSender(db, { partnerId, phone: PHONE, firstSeenDaysAgo: 10, kycStatus: 'verified' });
}

async function flagSender(db: Db, partnerId: string, opts: { flaggedAgoMs?: number; clearedAgoMs?: number } = {}) {
  await db.execute(sql`UPDATE customers SET watchlist_hit = true WHERE partner_id = ${partnerId} AND phone = ${PHONE}`);
  const repo = createCustomerRepo(db, async () => null);
  if (opts.flaggedAgoMs !== undefined) await repo.stampScreeningFlagged(partnerId, PHONE, new Date(Date.now() - opts.flaggedAgoMs));
  if (opts.clearedAgoMs !== undefined) await repo.clearScreeningHold(partnerId, PHONE, new Date(Date.now() - opts.clearedAgoMs));
}

const base = {
  phone: PHONE,
  amountSource: 200,
  sourceCurrency: 'USD' as const,
  recipientName: 'Mom',
  recipientPhone: '919000000088',
  payoutMethod: 'upi' as const,
  payoutDestination: 'mom@upi',
  fundingMethod: 'bank_transfer' as const,
  senderKycStatus: 'verified' as const,
};

const quote = {
  amountUsd: 200, feeUsd: 0, totalChargeUsd: 200, fxRate: 85, amountInr: 17_000,
  amountSource: 200, feeSource: 0, totalChargeSource: 200,
};

/**
 * The T6 flags read: a customers statement naming the hold times but not the
 * whole row (the existing getCustomer reads every column, first_seen_at too).
 */
function flagReads(log: Array<{ sql: string }>): string[] {
  return log
    .map((q) => q.sql.toLowerCase())
    .filter((q) => q.includes('"customers"') && q.includes('screening_flagged_at') && !q.includes('first_seen_at'));
}

describe('mint sender screening hold (fix pack 2 R06)', { retry: 0 }, () => {
  it('http + flagged -> held with SENDER_SCREENING_REASON', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await senderOn(db, 'acme', 'http');
    await flagSender(db, 'acme', { flaggedAgoMs: HOUR });
    primeOfacSource({ checkedAgoMs: HOUR });
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme' });
    expect(t.complianceStatus).toBe('flagged');
    expect(t.complianceReasons).toEqual([SENDER_SCREENING_REASON]);
    expect(t.status).toBe('awaiting_payment');
  });

  it('http + flagged on a stale list -> both reasons, list first', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await senderOn(db, 'acme', 'http');
    await flagSender(db, 'acme');
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme' });
    expect(t.complianceReasons).toEqual([LIST_UNAVAILABLE_REASON, SENDER_SCREENING_REASON]);
  });

  it('cleared after flag -> cleared', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await senderOn(db, 'acme', 'http');
    await flagSender(db, 'acme', { flaggedAgoMs: 2 * HOUR, clearedAgoMs: HOUR });
    primeOfacSource({ checkedAgoMs: HOUR });
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme' });
    expect(t.complianceStatus).toBe('cleared');
    expect(t.complianceReasons).toEqual([]);
  });

  it('a flag stamped after the clear -> held again', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await senderOn(db, 'acme', 'http');
    await flagSender(db, 'acme', { flaggedAgoMs: 2 * HOUR, clearedAgoMs: HOUR });
    await createCustomerRepo(db, async () => null).stampScreeningFlagged('acme', PHONE, new Date());
    primeOfacSource({ checkedAgoMs: HOUR });
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme' });
    expect(t.complianceReasons).toEqual([SENDER_SCREENING_REASON]);
  });

  it.each([
    ['simulator', 'simco', 'simulator', undefined],
    ['mock', 'mockco', 'mock', undefined],
    ['default', 'default', undefined, undefined],
    ["env 'test' on http", 'acme', 'http', 'test'],
  ] as const)('%s -> cleared with ZERO customers flag statements', async (_label, id, rail, environment) => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await senderOn(db, id, rail);
    await flagSender(db, id, { flaggedAgoMs: HOUR });
    const stop = captureQueries();
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: id, ...(environment ? { environment } : {}) });
    const log = stop();
    expect(t.complianceStatus).toBe('cleared');
    expect(t.complianceReasons).toEqual([]);
    expect(flagReads(log)).toEqual([]);
  });

  it('routed default owner -> http partner -> held', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await senderOn(db, 'default');
    await seedPartner(db, 'railco');
    await setRailProviderType(db, 'railco', 'http');
    await flagSender(db, 'default', { flaggedAgoMs: HOUR });
    primeOfacSource({ checkedAgoMs: HOUR });
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'default', quote, settlementPartnerId: 'railco' });
    expect(t.settlementPartnerId).toBe('railco');
    expect(t.complianceStatus).toBe('flagged');
    expect(t.complianceReasons).toEqual([SENDER_SCREENING_REASON]);
  });

  it('rail read error -> held', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await senderOn(db, 'simco', 'simulator');
    await flagSender(db, 'simco', { flaggedAgoMs: HOUR });
    primeOfacSource({ checkedAgoMs: HOUR });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await db.execute(sql`ALTER TABLE partner_integrations RENAME TO partner_integrations_gone`);
    try {
      const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'simco' });
      expect(t.complianceStatus).toBe('flagged');
      expect(t.complianceReasons).toEqual([SENDER_SCREENING_REASON]);
    } finally {
      await db.execute(sql`ALTER TABLE partner_integrations_gone RENAME TO partner_integrations`);
    }
  });

  it('flags read error throws, nothing written', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await senderOn(db, 'acme', 'http');
    primeOfacSource({ checkedAgoMs: HOUR });
    const real = store.mintUnderSenderLock.bind(store);
    vi.spyOn(store, 'mintUnderSenderLock').mockImplementation(((p: string, ph: string, fn: (ops: SenderLedgerOps) => Promise<unknown>) =>
      // The read fails inside the lock, before the evidence row and the insert.
      real(p, ph, (ops) => fn({ ...ops, senderScreeningFlags: async () => { throw new Error('flags read failed'); } }))) as typeof store.mintUnderSenderLock);
    await expect(createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', id: 'tr_flags_fail' }))
      .rejects.toThrow('flags read failed');
    expect((await db.execute(sql`SELECT count(*)::int AS n FROM transfers`)).rows[0]).toEqual({ n: 0 });
    expect((await db.execute(sql`SELECT count(*)::int AS n FROM audit_events`)).rows[0]).toEqual({ n: 0 });
  });

  it('blocked stays blocked', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await senderOn(db, 'acme', 'http');
    await flagSender(db, 'acme', { flaggedAgoMs: HOUR });
    primeOfacSource({ checkedAgoMs: HOUR });
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', recipientName: 'Testa Fixturelli' });
    expect(t.complianceStatus).toBe('blocked');
    expect(t.complianceReasons).toEqual([RECIPIENT_WATCHLIST_REASON]);
  });

  it('the store op reads the lock tenant only (tx-bound)', async () => {
    const { db, store } = await makeStores();
    await senderOn(db, 'acme', 'http');
    await seedPartner(db, 'other');
    await seedSender(db, { partnerId: 'other', phone: PHONE });
    await db.execute(sql`UPDATE customers SET pep_hit = true WHERE partner_id = 'other' AND phone = ${PHONE}`);
    const flags = await store.mintUnderSenderLock('acme', PHONE, (ops) => ops.senderScreeningFlags());
    expect(flags).toEqual({ watchlistHit: null, pepHit: null, screeningFlaggedAt: null, screeningClearedAt: null });
  });
});
