import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTransfer } from '@/lib/transfer-create';
import { createStore } from '@/lib/store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { AML_HOLD_REASON } from '@/lib/aml-hold';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { resetRateCacheForTests } from '@/lib/rate';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner, seedSender } from './helpers-db';
import type { Db } from '@/db/client';

// Batch B follow-up A4: a reason that matches a scam pattern holds the transfer
// for staff review. OWNER DECISION 2026-10-08: unlike the optional AML hold,
// this applies to EVERY partner, the default (demo) tenant and simulator rails
// included. cleared → flagged with the generic AML_HOLD_REASON only (never a
// downgrade, never touches blocked), one purpose.flag audit row (category and
// transfer id, no free text) and one deduped ops alert purposeflag:<id>.

const PHONE = '15550100077';

beforeEach(() => {
  resetRateCacheForTests();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85 } }) }));
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function makeStores(partnerId = 'default') {
  const redis = fakeRedis();
  const db = await freshDb();
  if (partnerId !== 'default') await seedPartner(db, partnerId);
  await seedSender(db, { partnerId, phone: PHONE, firstSeenDaysAgo: 10, kycStatus: 'verified' });
  return {
    db,
    store: createStore(redis, db),
    partnerStore: createPartnerStore(db),
    mvs: createMonthlyVolumeStore(createStore(redis, db)),
  };
}

const base = {
  phone: PHONE,
  amountSource: 100,
  sourceCurrency: 'USD' as const,
  recipientName: 'Mom',
  recipientPhone: '919000000077',
  payoutMethod: 'upi' as const,
  payoutDestination: 'mom@upi',
  fundingMethod: 'bank_transfer' as const,
  senderKycStatus: 'verified' as const,
  purpose: 'other' as const,
};

async function alerts(db: Db) {
  const r = await db.execute(sql`SELECT dedupe_key, payload FROM outbox WHERE kind = 'ops.alert'`);
  return r.rows as Array<{ dedupe_key: string; payload: { message: string } }>;
}

async function purposeAudits(db: Db) {
  const r = await db.execute(sql`SELECT partner_id, actor, actor_type, subject_id, meta FROM audit_events WHERE action = 'purpose.flag'`);
  return r.rows as Array<{ partner_id: string; actor: string; actor_type: string; subject_id: string; meta: Record<string, unknown> }>;
}

describe('purpose hold', { retry: 0 }, () => {
  it('a scam-pattern reason on the DEFAULT tenant (mock rail) is held, audited and alerted', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    const t = await createTransfer(store, partnerStore, mvs, {
      ...base, partnerId: 'default', purposeDetail: 'to claim my lottery prize',
    });
    expect(t.complianceStatus).toBe('flagged');
    expect(t.complianceReasons).toEqual([AML_HOLD_REASON]);
    expect(t.status).toBe('awaiting_payment');
    const stored = await createTransferRepo(db).getTransfer(t.id, { decrypt: true });
    expect(stored?.complianceStatus).toBe('flagged');
    expect(stored?.purposeDetail).toBe('to claim my lottery prize');

    const audits = await purposeAudits(db);
    expect(audits).toEqual([
      { partner_id: 'default', actor: 'system:purpose-check', actor_type: 'system', subject_id: t.id, meta: { category: 'prize' } },
    ]);
    const a = await alerts(db);
    expect(a.map((x) => x.dedupe_key)).toEqual([`purposeflag:${t.id}`]);
    expect(a[0].payload.message).toContain(t.id);
    // Ids and the category only: never the customer's words, a phone or an amount.
    expect(a[0].payload.message).not.toMatch(/lottery|claim|15550100077|100/);
  });

  it('applies to a non-default partner on a simulator rail too', async () => {
    const { db, store, partnerStore, mvs } = await makeStores('acme');
    await db.execute(sql`INSERT INTO partner_integrations (partner_id, payment_provider_type) VALUES ('acme', 'simulator')`);
    const t = await createTransfer(store, partnerStore, mvs, {
      ...base, partnerId: 'acme', purposeDetail: 'customs charge for a parcel',
    });
    expect(t.complianceStatus).toBe('flagged');
    expect((await purposeAudits(db))[0].meta).toEqual({ category: 'delivery' });
  });

  it('a sandbox (test-environment) mint is held and audited but raises no ops alert (security review L3)', async () => {
    const { db, store, partnerStore, mvs } = await makeStores('acme');
    const t = await createTransfer(store, partnerStore, mvs, {
      ...base, partnerId: 'acme', environment: 'test', purposeDetail: 'to claim my lottery prize',
    });
    expect(t.environment).toBe('test');
    expect(t.complianceStatus).toBe('flagged');
    expect(t.complianceReasons).toEqual([AML_HOLD_REASON]);
    expect((await purposeAudits(db)).map((a) => [a.subject_id, a.meta])).toEqual([[t.id, { category: 'prize' }]]);
    expect(await alerts(db)).toEqual([]);
  });

  it('a plain reason is stored and not held; no audit, no alert', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    const t = await createTransfer(store, partnerStore, mvs, {
      ...base, partnerId: 'default', purposeDetail: 'helping a neighbour repair the roof',
    });
    expect(t.complianceStatus).toBe('cleared');
    expect((await createTransferRepo(db).getTransfer(t.id, { decrypt: true }))?.purposeDetail)
      .toBe('helping a neighbour repair the roof');
    expect(await purposeAudits(db)).toEqual([]);
    expect(await alerts(db)).toEqual([]);
  });

  it('never downgrades a watchlist block, and writes no purpose audit for it', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    const t = await createTransfer(store, partnerStore, mvs, {
      ...base, partnerId: 'default', recipientName: 'John Doe', purposeDetail: 'to claim my lottery prize',
    });
    expect(t.complianceStatus).toBe('blocked');
    expect(t.complianceReasons).not.toContain(AML_HOLD_REASON);
    expect(await purposeAudits(db)).toEqual([]);
  });

  it('an already-flagged verdict keeps its own reasons; the risk is still audited and alerted', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    const t = await createTransfer(store, partnerStore, mvs, {
      ...base, partnerId: 'default', amountSource: 1500, purposeDetail: 'bitcoin to grow my money',
    });
    expect(t.complianceStatus).toBe('flagged');
    expect(t.complianceReasons).toEqual(['Large transfer amount.']);
    expect((await purposeAudits(db))[0].meta).toEqual({ category: 'investment' });
    expect((await alerts(db)).map((x) => x.dedupe_key)).toEqual([`purposeflag:${t.id}`]);
  });

  it('an invalid reason with no scam pattern that reaches the mint is not stored and holds nothing', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'default', purposeDetail: 'roof fix' });
    expect(t.complianceStatus).toBe('cleared');
    expect((await createTransferRepo(db).getTransfer(t.id, { decrypt: true }))?.purposeDetail).toBeUndefined();
    expect(await purposeAudits(db)).toEqual([]);
  });

  it('an invalid reason that matches a scam pattern is still held, stored and audited (security review L2)', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'default', purposeDetail: 'lottery' });
    expect(t.complianceStatus).toBe('flagged');
    expect(t.complianceReasons).toEqual([AML_HOLD_REASON]);
    expect((await createTransferRepo(db).getTransfer(t.id, { decrypt: true }))?.purposeDetail).toBe('lottery');
    expect((await purposeAudits(db))[0].meta).toEqual({ category: 'prize' });
  });
});
