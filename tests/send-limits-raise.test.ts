import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTransfer } from '@/lib/transfer-create';
import { createStore } from '@/lib/store';
import { createPartnerStore } from '@/lib/partner-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { resolveEffectiveSendLimits, SendCapError } from '@/lib/send-limits';
import { QuoteError } from '@/lib/fx';
import { evaluateCap } from '@/lib/tier-rules';
import { EnvKeyProvider } from '@/lib/field-crypto';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner, seedSender } from './helpers-db';
import { resetRateCacheForTests } from '@/lib/rate';
import type { Db } from '@/db/client';

// Program fix 16b (Task 10b): the audited platform-admin raise — the
// single-column writers, tenant scope, and the raised mint through fix 16's
// sender lock. Relative dates only; freshDb() before any fake clock.

const provider = new EnvKeyProvider(Buffer.alloc(32, 7));
const PHONE = '15551234567';

function stubFetch85() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85 } }) }));
}

let db: Db;
beforeEach(async () => {
  resetRateCacheForTests();
  stubFetch85();
  db = await freshDb();
  await seedPartner(db, 'A');
  await seedPartner(db, 'B');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const customerRepo = () => createCustomerRepo(db, async () => null, provider);

async function stores() {
  const redis = fakeRedis();
  const store = createStore(redis, db);
  return { store, partnerStore: createPartnerStore(db), customerStore: createCustomerStore(db, store), mvs: createMonthlyVolumeStore(store) };
}

const mintInput = (partnerId: string, amountSource: number, extra: Record<string, unknown> = {}) => ({
  phone: PHONE,
  amountSource,
  sourceCurrency: 'USD' as const,
  partnerId,
  recipientName: 'Mom',
  recipientPhone: '919133001840',
  payoutMethod: 'upi' as const,
  payoutDestination: 'mom@upi',
  fundingMethod: 'bank_transfer' as const,
  senderKycStatus: 'verified' as const,
  ...extra,
});

describe('single-column writers (fix 16b)', () => {
  it('customerRepo.setSendLimitOverride: writes ONLY the column, reports the previous value, and a missing row is not found', async () => {
    await seedSender(db, { partnerId: 'A', phone: PHONE, firstSeenDaysAgo: 10 });
    const repo = customerRepo();
    const before = (await repo.getCustomer('A', PHONE))!;
    const first = await repo.setSendLimitOverride('A', PHONE, { perTransferCapCents: 500_000, t1DailyCapCents: 500_000 });
    expect(first).toEqual({ found: true, previous: null });
    const after = (await repo.getCustomer('A', PHONE))!;
    expect(after.sendLimitOverride).toEqual({ perTransferCapCents: 500_000, t1DailyCapCents: 500_000 });
    // Nothing else moved (kyc, firstSeenAt, country…): only updatedAt may differ.
    expect({ ...after, sendLimitOverride: undefined, updatedAt: before.updatedAt }).toEqual(before);

    const second = await repo.setSendLimitOverride('A', PHONE, null);
    expect(second).toEqual({ found: true, previous: { perTransferCapCents: 500_000, t1DailyCapCents: 500_000 } });
    expect((await repo.getCustomer('A', PHONE))!.sendLimitOverride).toBeUndefined();

    // Tenant-scoped: B has no row for this phone ⇒ not found, nothing written.
    expect(await repo.setSendLimitOverride('B', PHONE, { perTransferCapCents: 500_000 })).toEqual({ found: false, previous: null });
    expect(await repo.getCustomer('B', PHONE)).toBeNull();
  });

  it('partnerRepo.setSendLimits: writes ONLY the column, reports the previous value, and an unknown partner is not found', async () => {
    const repo = createPartnerRepo(db);
    const before = (await repo.getPartner('A'))!;
    expect(await repo.setSendLimits('A', { perTransferCapCents: 500_000, t0DailyCapCents: 20_000 })).toEqual({ found: true, previous: null });
    const after = (await repo.getPartner('A'))!;
    expect(after.sendLimits).toEqual({ perTransferCapCents: 500_000, t0DailyCapCents: 20_000 });
    expect({ ...after, sendLimits: undefined, updatedAt: before.updatedAt }).toEqual(before);
    expect(await repo.setSendLimits('A', null)).toEqual({ found: true, previous: { perTransferCapCents: 500_000, t0DailyCapCents: 20_000 } });
    expect((await repo.getPartner('A'))!.sendLimits).toBeUndefined();
    expect(await repo.setSendLimits('nope', { perTransferCapCents: 1 })).toEqual({ found: false, previous: null });
  });

  it('test 7: a full-row saveCustomer (KYC update) and savePartner (branding save) leave both columns untouched', async () => {
    await seedSender(db, { partnerId: 'A', phone: PHONE, firstSeenDaysAgo: 10 });
    const cr = customerRepo();
    const pr = createPartnerRepo(db);
    await cr.setSendLimitOverride('A', PHONE, { perTransferCapCents: 500_000, t1DailyCapCents: 500_000 });
    await pr.setSendLimits('A', { perTransferCapCents: 400_000 });

    const c = (await cr.getCustomer('A', PHONE))!;
    // A KYC update that ALSO tries to change the override through the full-row path is ignored for that column.
    await cr.saveCustomer({ ...c, kycStatus: 'rejected', sendLimitOverride: { perTransferCapCents: 1 }, updatedAt: new Date().toISOString() });
    const c2 = (await cr.getCustomer('A', PHONE))!;
    expect(c2.kycStatus).toBe('rejected');
    expect(c2.sendLimitOverride).toEqual({ perTransferCapCents: 500_000, t1DailyCapCents: 500_000 });

    const p = (await pr.getPartner('A'))!;
    await pr.savePartner({ ...p, brandName: 'Acme Pay', sendLimits: { perTransferCapCents: 1 }, updatedAt: new Date().toISOString() });
    const p2 = (await pr.getPartner('A'))!;
    expect(p2.brandName).toBe('Acme Pay');
    expect(p2.sendLimits).toEqual({ perTransferCapCents: 400_000 });
  });

  it('auditRepo.lastSendLimitChange: the newest send_limits.* row for (partner, scope, subject), never another tenant’s or another scope’s', async () => {
    const audit = createAuditRepo(db);
    expect(await audit.lastSendLimitChange('A', 'customer', PHONE)).toBeNull();
    await audit.record({ partnerId: 'A', actor: 'root', actorType: 'staff', action: 'pii.reveal', subjectId: PHONE, meta: { field: 'x' } });
    await audit.record({ partnerId: 'B', actor: 'root', actorType: 'staff', action: 'send_limits.set', subjectId: PHONE, meta: { scope: 'customer', reason: 'other tenant' } });
    await audit.record({ partnerId: 'A', actor: 'root', actorType: 'staff', action: 'send_limits.set', subjectId: 'A', meta: { scope: 'partner', reason: 'partner-level' } });
    await audit.record({ partnerId: 'A', actor: 'ops', actorType: 'staff', action: 'send_limits.clear', subjectId: PHONE, meta: { scope: 'customer', old: { perTransferCapCents: 500_000 }, new: null, reason: 'lapse' } });
    // audit_events is append-only (drizzle/0019 rejects UPDATE): the OLDER row
    // is inserted LAST with an explicit earlier `at`, so id order and `at`
    // order disagree and the read must order by `at`, not insertion luck.
    await db.execute(sql`
      INSERT INTO audit_events (partner_id, actor, actor_type, action, subject_id, meta, at)
      VALUES ('A', 'root', 'staff', 'send_limits.set', ${PHONE},
              ${JSON.stringify({ scope: 'customer', old: null, new: { perTransferCapCents: 500_000 }, reason: 'first' })}::jsonb,
              now() - interval '1 minute')`);

    const last = await audit.lastSendLimitChange('A', 'customer', PHONE);
    expect(last).toMatchObject({ actor: 'ops', action: 'send_limits.clear', meta: { scope: 'customer', reason: 'lapse' } });
    expect(typeof last!.at).toBe('string');
    expect((await audit.lastSendLimitChange('A', 'partner', 'A'))!.meta).toMatchObject({ reason: 'partner-level' });
    expect(await audit.lastSendLimitChange('B', 'partner', 'B')).toBeNull();
  });
});

describe('tenant scope (fix 16b test 6)', () => {
  it('a raise for (A, phone) leaves (B, phone) at the platform value — in evaluateCap and in the mint', async () => {
    const { store, partnerStore, customerStore, mvs } = await stores();
    await seedSender(db, { partnerId: 'A', phone: PHONE, firstSeenDaysAgo: 10 });
    await seedSender(db, { partnerId: 'B', phone: PHONE, firstSeenDaysAgo: 10 });
    await customerRepo().setSendLimitOverride('A', PHONE, { perTransferCapCents: 500_000, t1DailyCapCents: 500_000 });

    const now = new Date();
    for (const [tenant, expected] of [['A', 500_000], ['B', 299_900]] as const) {
      const partner = (await partnerStore.getPartner(tenant))!;
      const customer = (await customerStore.getCustomer(tenant, PHONE))!;
      const limits = resolveEffectiveSendLimits(partner, customer, now);
      expect(limits.perTransferCapCents).toBe(expected);
      const ev = evaluateCap(customer, now, 0, 400_000, true, limits);
      expect(ev.withinCap).toBe(tenant === 'A');
    }

    // The mint: A succeeds at $4,000 through the sender lock; B is refused per-transfer, nothing written.
    const minted = await createTransfer(store, partnerStore, mvs, mintInput('A', 4000));
    expect(minted.status).toBe('awaiting_payment');
    expect(minted.amountUsd).toBe(4000);
    // B is still at the platform ceiling: $4,000 is refused at the quote (fix 16's
    // ruling-12 message, byte-for-byte) and nothing is written for B.
    let caught: unknown;
    try { await createTransfer(store, partnerStore, mvs, mintInput('B', 4000)); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(QuoteError);
    expect((caught as Error).message).toBe('Transfers must be between $10 and $2999.');
    expect(await store.listTransfersByPhone('B', PHONE, 5)).toEqual([]);
    expect(await store.listRecipients('B', PHONE, 5)).toEqual([]);
    // And below the quote ceiling B's PER-TRANSFER cap is the platform $2,999 while A's is $5,000:
    // $2,999 mints for B; the structured cap (not the quote) is what A's ladder changed.
    const okB = await createTransfer(store, partnerStore, mvs, mintInput('B', 2999));
    expect(okB.status).toBe('awaiting_payment');
  });
});

describe('end to end (fix 16b test 10): the raised mint counts against the raised daily cap', () => {
  it('a $4,000 mint succeeds through the lock and consumes $4,000 of today’s $5,000 cap; the next $1,001 is over_daily_cap', async () => {
    const { store, partnerStore, mvs } = await stores();
    await seedSender(db, { partnerId: 'A', phone: PHONE, firstSeenDaysAgo: 10 });
    await customerRepo().setSendLimitOverride('A', PHONE, { perTransferCapCents: 500_000, t1DailyCapCents: 500_000 });

    const t = await createTransfer(store, partnerStore, mvs, mintInput('A', 4000));
    expect(t.status).toBe('awaiting_payment');
    expect((await store.senderTotals('A', PHONE)).todayUsdCents).toBe(400_000);

    let caught: unknown;
    try { await createTransfer(store, partnerStore, mvs, mintInput('A', 1001)); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(SendCapError);
    const ev = (caught as SendCapError).evaluation;
    expect(ev.reason).toBe('over_daily_cap');
    expect(ev.dailyCapCents).toBe(500_000);
    expect(ev.todayRemainingCents).toBe(100_000);
    // $1,000 exactly fills it.
    const t2 = await createTransfer(store, partnerStore, mvs, mintInput('A', 1000));
    expect(t2.status).toBe('awaiting_payment');
  });

  it('an EXPIRED customer raise no longer lifts the mint (lapses at read, no cron)', async () => {
    const { store, partnerStore, mvs } = await stores();
    await seedSender(db, { partnerId: 'A', phone: PHONE, firstSeenDaysAgo: 10 });
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    await customerRepo().setSendLimitOverride('A', PHONE, { perTransferCapCents: 500_000, t1DailyCapCents: 500_000, expiresAt: yesterday });
    let caught: unknown;
    try { await createTransfer(store, partnerStore, mvs, mintInput('A', 4000)); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(QuoteError); // back at the platform quote ceiling
    expect(await store.listTransfersByPhone('A', PHONE, 5)).toEqual([]);
    // A partner-level raise that has NOT expired still lifts the same sender.
    await createPartnerRepo(db).setSendLimits('A', { perTransferCapCents: 500_000, t1DailyCapCents: 500_000 });
    const t = await createTransfer(store, partnerStore, mvs, mintInput('A', 4000));
    expect(t.status).toBe('awaiting_payment');
  });
});
