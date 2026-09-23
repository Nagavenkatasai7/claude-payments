import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTransfer } from '@/lib/transfer-create';
import { createStore, inSavepoint, type SenderLedgerOps } from '@/lib/store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { settleOrHold } from '@/lib/settlement';
import { EMPTY_PARTNER_INTEGRATIONS } from '@/lib/partner-integrations';
import { AML_HOLD_REASON } from '@/lib/aml-hold';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { resetRateCacheForTests } from '@/lib/rate';
import { fakeRedis } from './helpers';
import { captureQueries, freshDb, seedLedgerSpend, seedPartner, seedSender } from './helpers-db';
import type { Db } from '@/db/client';

// Program-Fix 43 PR B: the optional per-partner AML hold inside mintLocked.
// Owner decision (binding): AML rules raise alerts only; a hard hold comes ONLY
// from partners.corridor_compliance[<country>].amlHolds === true (OFF by
// default), only on a real `http` rail, and NEVER on the default (demo) tenant.
// A hold is cleared → flagged (generic reason) — flagged/blocked are never
// touched — and the check can never throw out of the mint.

const PHONE = '15550100043';

beforeEach(() => {
  resetRateCacheForTests();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85 } }) }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
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

async function setRail(db: Db, partnerId: string, providerType: string) {
  await db.execute(sql`
    INSERT INTO partner_integrations (partner_id, payment_provider_type) VALUES (${partnerId}, ${providerType})
    ON CONFLICT (partner_id) DO UPDATE SET payment_provider_type = ${providerType}`);
}

async function setHolds(db: Db, partnerId: string, on: boolean) {
  await db.execute(sql`
    UPDATE partners SET corridor_compliance = ${JSON.stringify({ US: { amlHolds: on } })}::jsonb WHERE id = ${partnerId}`);
}

/** A partner with the setting ON, a rail of `rail`, and a seasoned (T1) sender. */
async function partnerWith(db: Db, id: string, opts: { holds: boolean; rail?: string }) {
  await seedPartner(db, id);
  await setHolds(db, id, opts.holds);
  if (opts.rail) await setRail(db, id, opts.rail);
  await seedSender(db, { partnerId: id, phone: PHONE, firstSeenDaysAgo: 10, kycStatus: 'verified' });
}

const base = {
  phone: PHONE,
  amountSource: 600,             // ≥ firstUsd (500) on a first-ever send ⇒ an R2 hit
  sourceCurrency: 'USD' as const,
  recipientName: 'Mom',
  recipientPhone: '919000000043',
  payoutMethod: 'upi' as const,
  payoutDestination: 'mom@upi',
  fundingMethod: 'bank_transfer' as const,
  senderKycStatus: 'verified' as const,
};

function amlStatements(log: Array<{ sql: string }>): string[] {
  return log.map((q) => q.sql.toLowerCase()).filter((s) => s.includes('partner_integrations') || s.includes('savepoint'));
}

async function alerts(db: Db) {
  const r = await db.execute(sql`SELECT dedupe_key, payload FROM outbox WHERE kind = 'ops.alert'`);
  return r.rows as Array<{ dedupe_key: string; payload: { message: string } }>;
}

describe('AML hold — setting OFF (the default)', { retry: 0 }, () => {
  it('a would-be hit on an http rail stays cleared, with ZERO extra statements', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', { holds: false, rail: 'http' });
    const stop = captureQueries();
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme' });
    const log = stop();
    expect(t.complianceStatus).toBe('cleared');
    expect(t.complianceReasons).toEqual([]);
    expect(amlStatements(log)).toEqual([]);
  });

  it('a partner with no corridor config at all is untouched', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await seedPartner(db, 'plain');
    await setRail(db, 'plain', 'http');
    await seedSender(db, { partnerId: 'plain', phone: PHONE, firstSeenDaysAgo: 10 });
    const stop = captureQueries();
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'plain' });
    expect(t.complianceStatus).toBe('cleared');
    expect(amlStatements(stop())).toEqual([]);
  });
});

describe('AML hold — demo is NEVER held (structural)', { retry: 0 }, () => {
  it('the default tenant with the setting forced ON and an http rail: cleared, zero AML statements', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await setHolds(db, 'default', true);
    await setRail(db, 'default', 'http');
    await seedSender(db, { partnerId: 'default', phone: PHONE, firstSeenDaysAgo: 10 });
    const stop = captureQueries();
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'default' });
    expect(t.complianceStatus).toBe('cleared');
    expect(t.status).toBe('awaiting_payment');
    expect(amlStatements(stop())).toEqual([]);
  });

  it('setting ON on a simulator rail: cleared', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', { holds: true, rail: 'simulator' });
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme' });
    expect(t.complianceStatus).toBe('cleared');
  });

  it('setting ON with no rail configured (mock): cleared', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', { holds: true });
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme' });
    expect(t.complianceStatus).toBe('cleared');
  });
});

describe('AML hold — setting ON, http rail', { retry: 0 }, () => {
  it('a hit flags the transfer with the generic reason, and paying it goes to in_review', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', { holds: true, rail: 'http' });
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme' });
    expect(t.complianceStatus).toBe('flagged');
    expect(t.complianceReasons).toEqual([AML_HOLD_REASON]);
    expect(t.status).toBe('awaiting_payment');
    const stored = await createTransferRepo(db).getTransfer(t.id);
    expect(stored?.complianceStatus).toBe('flagged');
    expect(await settleOrHold(db, stored!, EMPTY_PARTNER_INTEGRATIONS)).toEqual({ kind: 'held' });
    expect((await createTransferRepo(db).getTransfer(t.id))?.status).toBe('in_review');
  });

  it('no hit (a small first send) stays cleared', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', { holds: true, rail: 'http' });
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', amountSource: 200 });
    expect(t.complianceStatus).toBe('cleared');
  });

  it('structuring: the send that completes a run of in-band sends is held', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', { holds: true, rail: 'http' });
    const yesterday = new Date(Date.now() - 86_400_000);
    await seedLedgerSpend(db, { partnerId: 'acme', phone: PHONE, amountUsd: 900, status: 'paid', createdAt: yesterday });
    await seedLedgerSpend(db, { partnerId: 'acme', phone: PHONE, amountUsd: 900, status: 'paid', createdAt: yesterday });
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', amountSource: 900 });
    expect(t.complianceStatus).toBe('flagged');
    expect(t.complianceReasons).toEqual([AML_HOLD_REASON]);
  });

  it('only the partner and corridor that turned it on: another partner on the same sender phone is untouched', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', { holds: true, rail: 'http' });
    await partnerWith(db, 'other', { holds: false, rail: 'http' });
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'other' });
    expect(t.complianceStatus).toBe('cleared');
  });

  it('never downgrades: a watchlist-blocked row stays blocked with its own reasons', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', { holds: true, rail: 'http' });
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', recipientName: 'John Doe' });
    expect(t.complianceStatus).toBe('blocked');
    expect(t.complianceReasons).not.toContain(AML_HOLD_REASON);
  });

  it('never touches an already-flagged verdict: the reasons are exactly the screen\'s', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', { holds: true, rail: 'http' });
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', amountSource: 1500 });
    expect(t.complianceStatus).toBe('flagged');
    expect(t.complianceReasons).toEqual(['Large transfer amount.']);
  });
});

describe('AML hold — routed settlement: the RAIL partner\'s provider decides', { retry: 0 }, () => {
  const quote = {
    amountUsd: 600, feeUsd: 0, totalChargeUsd: 600, fxRate: 85, amountInr: 51_000,
    amountSource: 600, feeSource: 0, totalChargeSource: 600,
  };

  it('owner ON (simulator) routed to an http rail partner ⇒ held', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', { holds: true, rail: 'simulator' });
    await seedPartner(db, 'railco');
    await setRail(db, 'railco', 'http');
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', quote, settlementPartnerId: 'railco' });
    expect(t.complianceStatus).toBe('flagged');
  });

  it('owner ON (http) routed to a simulator rail partner ⇒ not held', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', { holds: true, rail: 'http' });
    await seedPartner(db, 'simco');
    await setRail(db, 'simco', 'simulator');
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', quote, settlementPartnerId: 'simco' });
    expect(t.complianceStatus).toBe('cleared');
  });

  it('routed to the default tenant ⇒ never held', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', { holds: true, rail: 'http' });
    await setRail(db, 'default', 'http');
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', quote, settlementPartnerId: 'default' });
    expect(t.complianceStatus).toBe('cleared');
  });
});

describe('AML hold — the check never throws out of the mint', { retry: 0 }, () => {
  it('a real SQL error inside the check: the mint still commits cleared, and ONE ops alert is queued', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', { holds: true, rail: 'http' });
    await db.execute(sql`ALTER TABLE partner_integrations RENAME TO partner_integrations_gone`);
    try {
      const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme' });
      expect(t.complianceStatus).toBe('cleared');
      expect((await createTransferRepo(db).getTransfer(t.id))?.complianceStatus).toBe('cleared');
      const t2 = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', amountSource: 100 });
      expect(t2.complianceStatus).toBe('cleared');
    } finally {
      await db.execute(sql`ALTER TABLE partner_integrations_gone RENAME TO partner_integrations`);
    }
    const a = await alerts(db);
    expect(a).toHaveLength(1); // hour-bucketed dedupe: one alert, not one per mint
    expect(a[0].dedupe_key).toMatch(/^aml-hold-check:acme:\d+$/);
    expect(a[0].payload.message).toContain('AML hold check');
    expect(a[0].payload.message).not.toContain(PHONE);
    expect(Object.keys(a[0].payload)).toEqual(['message']);
  });

  it('an ops method that throws is absorbed: no hold, the transfer is minted', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', { holds: true, rail: 'http' });
    const real = store.mintUnderSenderLock.bind(store);
    vi.spyOn(store, 'mintUnderSenderLock').mockImplementation(((p: string, ph: string, fn: (ops: SenderLedgerOps) => Promise<unknown>) =>
      real(p, ph, (ops) => fn({ ...ops, amlHoldInputs: async () => { throw new Error('boom'); } }))) as typeof store.mintUnderSenderLock);
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme' });
    expect(t.complianceStatus).toBe('cleared');
    expect(await createTransferRepo(db).getTransfer(t.id)).not.toBeNull();
  });

  it('inSavepoint: a failed statement rolls back to the savepoint and the outer transaction carries on', async () => {
    const { db } = await makeStores();
    await db.transaction(async (tx) => {
      const r = await inSavepoint(tx, (sp) => sp.execute(sql`SELECT 1/0`));
      expect(r.ok).toBe(false);
      const ok = await inSavepoint(tx, (sp) => sp.execute(sql`SELECT 1 AS one`));
      expect(ok.ok).toBe(true);
      await tx.execute(sql`UPDATE partners SET name = 'still-writable' WHERE id = 'default'`);
    });
    const r = await db.execute(sql`SELECT name FROM partners WHERE id = 'default'`);
    expect((r.rows[0] as { name: string }).name).toBe('still-writable');
  });
});
