import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTransfer, MintRefusedError } from '@/lib/transfer-create';
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
import { LIST_UNAVAILABLE_REASON } from '@/lib/compliance-config';
import { primeOfacSource, restoreOfacSource } from './helpers-sanctions';
import { certifyPartnerForTest } from './helpers-live';
import { amlMintFixture, seedPriorSends } from './helpers-mint';
import { AML_HOLD_AUDIT_ACTOR } from '@/lib/transfer-create';
import { isPartnerReleasableHold } from '@/lib/compliance-config';
import { partnerMayRejectHold } from '@/lib/partner-reviews';
import { canReleaseHeld } from '@/lib/dashboard-ops';

// Fix pack 6 (P16): a REAL SQL error in the in-mint stats read, on the handle
// the store gave the repo (the mint's savepoint), while `fault.stats` is on.
const fault = vi.hoisted(() => ({ stats: false }));
vi.mock('@/db/repos/transfer-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/transfer-repo')>();
  return {
    ...real,
    createTransferRepo: (handle: Parameters<typeof real.createTransferRepo>[0]) => {
      const repo = real.createTransferRepo(handle);
      return {
        ...repo,
        senderAmlStats: async (...args: Parameters<typeof repo.senderAmlStats>) => {
          if (fault.stats) await handle.execute(sql`SELECT 1/0`);
          return repo.senderAmlStats(...args);
        },
      };
    },
  };
});

// Program-Fix 43 PR B and fix pack 6 (P16): the optional per-partner AML hold
// inside mintLocked. Owner decision (binding): AML rules raise alerts only; a
// hard hold comes ONLY from partners.corridor_compliance[<country>].amlHolds
// === true with at least one rule (OFF by default), only on real money
// (p.realMoney), and NEVER on the default (demo) tenant. A hold adds the
// generic reason to a cleared or flagged verdict (blocked is never touched),
// writes one ids-only `aml.hold` audit row, and FAILS CLOSED: a check that
// cannot run holds the row. The check never throws out of the mint.

const PHONE = '15550100043';

// Fix pack 2 T2 (R02): a live http mint clears only on a live OFAC list, so
// every test here screens against a fresh one (checked an hour ago).
const ORIGINAL_LIST = process.env.SANCTIONS_LIST;
beforeEach(() => {
  fault.stats = false;
  resetRateCacheForTests();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85 } }) }));
  primeOfacSource({ checkedAgoMs: 3_600_000 });
});
afterEach(() => {
  restoreOfacSource(ORIGINAL_LIST);
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

/**
 * A partner with the setting ON, a rail of `rail`, and a seasoned (T1) sender.
 * Fix pack 3 T4: an http partner is certified for live money (the mint's live
 * gate refuses an uncertified real-money rail).
 */
async function partnerWith(db: Db, id: string, opts: { holds: boolean; rail?: string }) {
  await seedPartner(db, id);
  await setHolds(db, id, opts.holds);
  if (opts.rail) await setRail(db, id, opts.rail);
  if (opts.rail === 'http') await certifyPartnerForTest(db, id);
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

/** Split at the sender lock: statements before it ran on the root handle. */
function atLock(log: Array<{ sql: string }>): { pre: string[]; locked: string[] } {
  const sqls = log.map((q) => q.sql.toLowerCase());
  const lock = sqls.findIndex((q) => q.includes('set local lock_timeout'));
  return { pre: sqls.slice(0, lock), locked: sqls.slice(lock) };
}

/** The AML hold's statements: savepoints and rail reads INSIDE the lock. */
function amlStatements(log: Array<{ sql: string }>): string[] {
  return atLock(log).locked.filter((s) => s.includes('partner_integrations') || s.includes('savepoint'));
}

/** Fix pack 2 (R02): the one real-money rail read, on the root handle ABOVE the lock. */
function preLockRailReads(log: Array<{ sql: string }>): string[] {
  return atLock(log).pre.filter((s) => s.includes('partner_integrations'));
}

async function amlAudits(db: Db, subjectId?: string) {
  const r = await db.execute(sql`
    SELECT partner_id, actor, actor_type, subject_id, meta FROM audit_events WHERE action = 'aml.hold' ORDER BY id`);
  const rows = r.rows as Array<{ partner_id: string; actor: string; actor_type: string; subject_id: string; meta: unknown }>;
  return subjectId ? rows.filter((x) => x.subject_id === subjectId) : rows;
}

async function screenAudits(db: Db, subjectId: string) {
  const r = await db.execute(sql`SELECT id FROM audit_events WHERE action = 'sanctions.screen' AND subject_id = ${subjectId}`);
  return r.rows;
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
    expect(preLockRailReads(log)).toHaveLength(1);
  });

  it('a partner with no corridor config at all is untouched', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await seedPartner(db, 'plain');
    await setRail(db, 'plain', 'http');
    await certifyPartnerForTest(db, 'plain');
    await seedSender(db, { partnerId: 'plain', phone: PHONE, firstSeenDaysAgo: 10 });
    const stop = captureQueries();
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'plain' });
    expect(t.complianceStatus).toBe('cleared');
    const log = stop();
    expect(amlStatements(log)).toEqual([]);
    expect(preLockRailReads(log)).toHaveLength(1);
  });
});

describe('AML hold — demo is NEVER held (structural)', { retry: 0 }, () => {
  // Fix pack 3 T4: the default tenant may not mint real money at all.
  it('the default tenant with the setting forced ON and an http rail: refused default_on_live_rail, zero AML statements', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await setHolds(db, 'default', true);
    await setRail(db, 'default', 'http');
    await seedSender(db, { partnerId: 'default', phone: PHONE, firstSeenDaysAgo: 10 });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stop = captureQueries();
    const err = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'default' }).then(() => null, (e: unknown) => e);
    const log = stop();
    expect(err).toBeInstanceOf(MintRefusedError);
    expect((err as MintRefusedError).code).toBe('default_on_live_rail');
    expect(log.some((q) => q.sql.toLowerCase().includes('set local lock_timeout'))).toBe(false);
    expect(log.filter((q) => q.sql.toLowerCase().includes('savepoint'))).toEqual([]);
    // No lock was taken, so every statement is pre-lock: the one rail read.
    expect(log.filter((q) => q.sql.toLowerCase().includes('partner_integrations'))).toHaveLength(1);
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
    // Fix pack 6 (P16): one ids-only aml.hold row (no phone, amount or name).
    const audits = await amlAudits(db);
    expect(audits).toEqual([{
      partner_id: 'acme', actor: AML_HOLD_AUDIT_ACTOR, actor_type: 'system', subject_id: t.id, meta: { rules: ['first_transfer'] },
    }]);
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
    const stop = captureQueries();
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', recipientName: 'John Doe' });
    const log = stop();
    expect(t.complianceStatus).toBe('blocked');
    expect(t.complianceReasons).not.toContain(AML_HOLD_REASON);
    expect(await amlAudits(db)).toEqual([]);
    expect(amlStatements(log)).toEqual([]);
  });

  it('an already-flagged verdict gains the AML reason once (first send $1,500)', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', { holds: true, rail: 'http' });
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', amountSource: 1500 });
    expect(t.complianceStatus).toBe('flagged');
    expect(t.complianceReasons).toEqual(['Large transfer amount.', AML_HOLD_REASON]);
    expect((await createTransferRepo(db).getTransfer(t.id))?.complianceReasons).toEqual(['Large transfer amount.', AML_HOLD_REASON]);
    expect((await amlAudits(db, t.id)).map((a) => a.meta)).toEqual([{ rules: ['first_transfer'] }]);
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
    await certifyPartnerForTest(db, 'railco');
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

  // Fix pack 3 T4: the default tenant is never certified, so a real-money
  // route to it is refused before the AML hold could run.
  it('routed to the default tenant on an http rail ⇒ refused live_not_certified', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', { holds: true, rail: 'http' });
    await setRail(db, 'default', 'http');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', quote, settlementPartnerId: 'default' })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(MintRefusedError);
    expect((err as MintRefusedError).code).toBe('live_not_certified');
  });
});

describe('AML hold — the check never throws out of the mint', { retry: 0 }, () => {
  it('a real SQL error in the stats read: held, the transaction stays usable, ONE alert saying HELD', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await amlMintFixture(db, { phone: PHONE });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fault.stats = true;
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme' });
    const t2 = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', amountSource: 100 });
    fault.stats = false;
    for (const x of [t, t2]) {
      expect(x.complianceStatus).toBe('flagged');
      expect(x.complianceReasons).toEqual([AML_HOLD_REASON]);
      const stored = await createTransferRepo(db).getTransfer(x.id);
      expect(stored?.complianceStatus).toBe('flagged');
      expect(stored?.complianceReasons).toEqual([AML_HOLD_REASON]);
      expect((await amlAudits(db, x.id)).map((a) => a.meta)).toEqual([{ rules: ['check_failed'] }]);
      // The outer transaction kept working after the savepoint rollback.
      expect(await screenAudits(db, x.id)).toHaveLength(1);
    }
    const a = await alerts(db);
    expect(a).toHaveLength(1); // hour-bucketed dedupe: one alert, not one per mint
    expect(a[0].dedupe_key).toMatch(/^aml-hold-check:acme:\d+$/);
    expect(a[0].payload.message).toContain('HELD');
    expect(a[0].payload.message).toContain('AML hold check');
    expect(a[0].payload.message).not.toContain(PHONE);
    expect(Object.keys(a[0].payload)).toEqual(['message']);
  });

  // Fix pack 2 T2 (R02): the same rename also fails the pre-lock rail read,
  // which counts as real money: held on a stale list, cleared on a fresh one.
  it('the renamed table also fails the pre-lock rail read: held LIST_UNAVAILABLE on a stale list, cleared on a fresh one', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', { holds: true, rail: 'http' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await db.execute(sql`ALTER TABLE partner_integrations RENAME TO partner_integrations_gone`);
    try {
      primeOfacSource({ checkedAgoMs: 40 * 3_600_000 });
      const stale = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', amountSource: 100 });
      expect(stale.complianceStatus).toBe('flagged');
      expect(stale.complianceReasons).toEqual([LIST_UNAVAILABLE_REASON]);
      primeOfacSource({ checkedAgoMs: 3_600_000 });
      const fresh = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', amountSource: 100 });
      expect(fresh.complianceStatus).toBe('cleared');
    } finally {
      await db.execute(sql`ALTER TABLE partner_integrations_gone RENAME TO partner_integrations`);
    }
  });

  it('an ops method that throws HOLDS (fail closed): flagged, one aml.hold check_failed row, the mint commits', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', { holds: true, rail: 'http' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const real = store.mintUnderSenderLock.bind(store);
    vi.spyOn(store, 'mintUnderSenderLock').mockImplementation(((p: string, ph: string, fn: (ops: SenderLedgerOps) => Promise<unknown>) =>
      real(p, ph, (ops) => fn({ ...ops, amlHoldInputs: async () => { throw new Error('boom'); } }))) as typeof store.mintUnderSenderLock);
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme' });
    expect(t.complianceStatus).toBe('flagged');
    expect(t.complianceReasons).toEqual([AML_HOLD_REASON]);
    expect((await createTransferRepo(db).getTransfer(t.id))?.complianceStatus).toBe('flagged');
    expect((await amlAudits(db, t.id)).map((a) => a.meta)).toEqual([{ rules: ['check_failed'] }]);
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

describe('AML hold — per-corridor rules on real money (fix pack 6 P16)', { retry: 0 }, () => {
  it('a sandbox (test) mint on a certified http rail with holds on: cleared, zero AML statements', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await amlMintFixture(db, { phone: PHONE });
    const stop = captureQueries();
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', environment: 'test' });
    const log = stop();
    expect(t.complianceStatus).toBe('cleared');
    expect(amlStatements(log)).toEqual([]);
    expect(await amlAudits(db)).toEqual([]);
  });

  it('holds on but every rule off (amlHoldRules []): cleared, zero AML statements, even when the read would fail', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await amlMintFixture(db, { phone: PHONE, rules: [] });
    fault.stats = true;
    const stop = captureQueries();
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme' });
    const log = stop();
    expect(t.complianceStatus).toBe('cleared');
    expect(amlStatements(log)).toEqual([]);
    expect(await amlAudits(db)).toEqual([]);
    expect(await alerts(db)).toEqual([]);
  });

  it('per-corridor rules: only structuring stored -> a $600 first send is cleared', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await amlMintFixture(db, { phone: PHONE, rules: ['structuring'] });
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme' });
    expect(t.complianceStatus).toBe('cleared');
    expect(await amlAudits(db)).toEqual([]);
  });

  it('new_beneficiary: seedPriorSends(paid 2, toRecipient 0) then $600 -> held, aml.hold { rules: ["new_beneficiary"] }', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await amlMintFixture(db, { phone: PHONE });
    await seedPriorSends(db, 'acme', PHONE, { paid: 2, toRecipient: 0, recipientPhone: base.recipientPhone });
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme' });
    expect(t.complianceStatus).toBe('flagged');
    expect(t.complianceReasons).toEqual([AML_HOLD_REASON]);
    expect((await amlAudits(db, t.id)).map((a) => a.meta)).toEqual([{ rules: ['new_beneficiary'] }]);
  });

  it('an awaiting_payment prior row does not count as a prior send: $600 -> first_transfer hold', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await amlMintFixture(db, { phone: PHONE });
    await seedLedgerSpend(db, {
      partnerId: 'acme', phone: PHONE, amountUsd: 100, status: 'awaiting_payment',
      createdAt: new Date(Date.now() - 86_400_000), recipientPhone: base.recipientPhone,
    });
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme' });
    expect(t.complianceStatus).toBe('flagged');
    expect((await amlAudits(db, t.id)).map((a) => a.meta)).toEqual([{ rules: ['first_transfer'] }]);
  });

  it('empty recipient phone (Partner API shape) with 2 prior paid sends: no new_beneficiary verdict, cleared', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await amlMintFixture(db, { phone: PHONE });
    await seedPriorSends(db, 'acme', PHONE, { paid: 2, toRecipient: 0, recipientPhone: base.recipientPhone });
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', recipientPhone: '' });
    expect(t.complianceStatus).toBe('cleared');
    expect(await amlAudits(db)).toEqual([]);
  });

  it('a check_failed hold is platform-only: isPartnerReleasableHold and partnerMayRejectHold are false for a delegated owner; platform staff may release it (releaseTransferAction -> canReleaseHeld)', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await amlMintFixture(db, { phone: PHONE });
    await db.execute(sql`UPDATE partners SET kyc_mode = 'delegated' WHERE id = 'acme'`);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fault.stats = true;
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', amountSource: 100 });
    fault.stats = false;
    expect(t.complianceReasons).toEqual([AML_HOLD_REASON]);
    expect((await amlAudits(db, t.id)).map((a) => a.meta)).toEqual([{ rules: ['check_failed'] }]);
    const owner = { kycMode: 'delegated' as const };
    const sender = { watchlistHit: false, pepHit: false };
    const held = { ...t, status: 'in_review' as const };
    expect(isPartnerReleasableHold(held, owner, sender)).toBe(false);
    expect(partnerMayRejectHold(held, owner, sender)).toBe(false);
    expect(canReleaseHeld({ kind: 'partner', partnerId: 'acme' }, owner, held, sender)).toBe(false);
    expect(canReleaseHeld({ kind: 'platform' }, owner, held, sender)).toBe(true);
  });
});
