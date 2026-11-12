import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createTransfer,
  createTransferWithOutcome,
  RiskAckRequiredError,
  RISK_AUDIT_ACTOR,
  type CreateTransferInput,
} from '@/lib/transfer-create';
import { createStore, type SenderLedgerOps } from '@/lib/store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { AML_HOLD_REASON } from '@/lib/aml-hold';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { resetRateCacheForTests } from '@/lib/rate';
import { RISK_SIGNALS, type RiskSignal } from '@/lib/risk-signals';
import { RISK_WARNING_VERSION } from '@/lib/legal/risk-warning';
import { fakeRedis } from './helpers';
import { captureQueries, freshDb, seedLedgerSpend, seedPartner, seedSender } from './helpers-db';
import type { Db } from '@/db/client';
import { primeOfacSource, restoreOfacSource } from './helpers-sanctions';
import { amlMintFixture, seedPriorSends } from './helpers-mint';
import { riskConfigFor } from './helpers-risk';

// Fix pack 6 (R48, P19 T25): risk signals inside mintLocked. A caller that
// showed a warning passes input.risk; a shown signal without the tick refuses
// (nothing written); the mint derives the signals itself when the corridor
// turned them on, records them in one `risk.signals` audit row, and holds the
// row (AML_HOLD_REASON through addHoldReason) for a signal in the CURRENT hold
// list. A failed prior-sends read is recorded and never holds (owner Q25).
// Off by default, never for the default tenant, 'test' or b2b.

const logs = vi.hoisted(() => ({ errors: [] as Array<{ scope: string; fields?: Record<string, unknown> }> }));
vi.mock('@/lib/log', async (orig) => {
  const real = await orig<typeof import('@/lib/log')>();
  return {
    ...real,
    logError: (scope: string, err: unknown, fields?: Record<string, unknown>) => {
      logs.errors.push({ scope, fields });
      return real.logError(scope, err, fields);
    },
  };
});

const PHONE = '15550100251';
const RECIPIENT = '919000000251';
const HOUR = 3_600_000;

const ORIGINAL_LIST = process.env.SANCTIONS_LIST;
beforeEach(() => {
  logs.errors.length = 0;
  resetRateCacheForTests();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85 } }) }));
  primeOfacSource({ checkedAgoMs: HOUR });
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

/** Write the US corridor's riskSignals entry, keeping the entry's other keys (amlHolds). */
async function setRisk(db: Db, partnerId: string, cfg: unknown) {
  await db.execute(sql`
    UPDATE partners SET corridor_compliance = jsonb_set(
      coalesce(corridor_compliance, '{}'::jsonb), '{US}',
      coalesce(corridor_compliance->'US', '{}'::jsonb) || jsonb_build_object('riskSignals', ${JSON.stringify(cfg)}::jsonb)
    ) WHERE id = ${partnerId}`);
}

/** Partner on the mock rail (no real money: risk signals do not need it, owner Q24), seasoned sender. */
async function riskPartner(db: Db, id = 'acme', cfg: unknown = riskConfigFor()) {
  await seedPartner(db, id);
  await setRisk(db, id, cfg);
  await seedSender(db, { partnerId: id, phone: PHONE, firstSeenDaysAgo: 10, kycStatus: 'verified' });
}

const base: CreateTransferInput = {
  partnerId: 'acme',
  phone: PHONE,
  amountSource: 200,
  sourceCurrency: 'USD',
  recipientName: 'Mom',
  recipientPhone: RECIPIENT,
  payoutMethod: 'upi',
  payoutDestination: 'mom@upi',
  fundingMethod: 'bank_transfer',
  senderKycStatus: 'verified',
};

type AuditRow = { partner_id: string; actor: string; actor_type: string; subject_id: string; meta: Record<string, unknown> };
async function riskAudits(db: Db): Promise<AuditRow[]> {
  const r = await db.execute(sql`
    SELECT partner_id, actor, actor_type, subject_id, meta FROM audit_events WHERE action = 'risk.signals' ORDER BY id`);
  return r.rows as AuditRow[];
}

async function counts(db: Db) {
  const n = async (table: string) =>
    Number(((await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`))).rows[0] as { n: number }).n);
  return { transfers: await n('transfers'), outbox: await n('outbox'), audit: await n('audit_events') };
}

function atLock(log: Array<{ sql: string }>): { pre: string[]; locked: string[] } {
  const sqls = log.map((q) => q.sql.toLowerCase());
  const lock = sqls.findIndex((q) => q.includes('set local lock_timeout'));
  return { pre: sqls.slice(0, lock), locked: lock < 0 ? [] : sqls.slice(lock) };
}
const savepoints = (log: Array<{ sql: string }>) => atLock(log).locked.filter((s) => s.includes('savepoint'));
/** priorSends' select: the only locked statement with a refund_status filter and a count. */
const priorSendReads = (log: Array<{ sql: string }>) =>
  atLock(log).locked.filter((s) => s.includes('refund_status') && s.includes('count(*)'));

type Stores = Awaited<ReturnType<typeof makeStores>>;
/** Run the mint with the lock's ops replaced by `wrap(ops)`. */
function wrapOps(store: Stores['store'], wrap: (ops: SenderLedgerOps) => SenderLedgerOps) {
  const real = store.mintUnderSenderLock.bind(store);
  vi.spyOn(store, 'mintUnderSenderLock').mockImplementation(((p: string, ph: string, fn: (ops: SenderLedgerOps) => Promise<unknown>) =>
    real(p, ph, (ops) => fn(wrap(ops)))) as typeof store.mintUnderSenderLock);
}

describe('risk ack (P19 step 1)', { retry: 0 }, () => {
  it('shown ["first_to_recipient"] without acked -> RiskAckRequiredError; nothing written', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await riskPartner(db);
    const before = await counts(db);
    const err = await createTransfer(store, partnerStore, mvs, {
      ...base, risk: { shown: ['first_to_recipient'], acked: false },
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RiskAckRequiredError);
    expect((err as Error).message).toBe('risk_ack_required');
    expect(await counts(db)).toEqual(before);
    expect(before.transfers).toBe(0);
  });

  it('shown with acked:true and ackedAt -> minted; risk.signals records shown, derived, ack and the version', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await riskPartner(db);
    const ackedAt = new Date(Date.now() - 1000).toISOString();
    const t = await createTransfer(store, partnerStore, mvs, {
      ...base, amountSource: 600, risk: { shown: ['first_to_recipient'], acked: true, ackedAt },
    });
    expect(t.complianceStatus).toBe('cleared');
    expect(await riskAudits(db)).toEqual([{
      partner_id: 'acme', actor: RISK_AUDIT_ACTOR, actor_type: 'system', subject_id: t.id,
      meta: {
        shown: ['first_to_recipient'],
        derived: ['first_to_recipient', 'first_transfer', 'amount_over_threshold'],
        acked: true, held: [], warningVersion: RISK_WARNING_VERSION, ackedAt,
      },
    }]);
  });

  it('ack is checked after the replay: a claim-first replay of an existing id with shown and no ack returns the row', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await riskPartner(db);
    const id = 'RiskReplayId0123456789';
    const first = await createTransferWithOutcome(store, partnerStore, mvs, { ...base, id });
    expect(first.replayed).toBe(false);
    const again = await createTransferWithOutcome(store, partnerStore, mvs, {
      ...base, id, risk: { shown: ['first_transfer'], acked: false },
    });
    expect(again.replayed).toBe(true);
    expect(again.transfer.id).toBe(id);
  });

  it('a missing ack on a would-be blocked mint still throws RiskAckRequiredError (before screening)', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await riskPartner(db);
    const before = await counts(db);
    await expect(createTransfer(store, partnerStore, mvs, {
      ...base, recipientName: 'John Doe', risk: { shown: ['chat_cue'], acked: false },
    })).rejects.toBeInstanceOf(RiskAckRequiredError);
    expect(await counts(db)).toEqual(before);
  });
});

describe('risk signals: derive, record, hold (P19 steps 2, 3, 5)', { retry: 0 }, () => {
  it('record only: no input.risk, a $600 first send to a new recipient -> derived in enum order, nothing held', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await riskPartner(db);
    const t = await createTransfer(store, partnerStore, mvs, { ...base, amountSource: 600 });
    expect(t.complianceStatus).toBe('cleared');
    expect(t.complianceReasons).toEqual([]);
    const [a] = await riskAudits(db);
    expect(a.meta).toEqual({
      shown: [], derived: ['first_to_recipient', 'first_transfer', 'amount_over_threshold'],
      acked: false, held: [], warningVersion: RISK_WARNING_VERSION, ackedAt: null,
    });
  });

  it('hold ["first_to_recipient"] -> flagged with exactly [AML_HOLD_REASON]; held recorded', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await riskPartner(db, 'acme', riskConfigFor({ hold: ['first_to_recipient'] }));
    const t = await createTransfer(store, partnerStore, mvs, base);
    expect(t.complianceStatus).toBe('flagged');
    expect(t.complianceReasons).toEqual([AML_HOLD_REASON]);
    expect((await createTransferRepo(db).getTransfer(t.id))?.complianceReasons).toEqual([AML_HOLD_REASON]);
    const [a] = await riskAudits(db);
    expect(a.meta.held).toEqual(['first_to_recipient']);
    expect(a.meta.derived).toEqual(['first_to_recipient', 'first_transfer']);
  });

  it('a row already flagged (LARGE_AMOUNT, $1,000) gets AML_HOLD_REASON appended once', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await riskPartner(db, 'acme', riskConfigFor({ hold: ['first_to_recipient', 'amount_over_threshold'] }));
    const t = await createTransfer(store, partnerStore, mvs, { ...base, amountSource: 1000 });
    expect(t.complianceStatus).toBe('flagged');
    expect(t.complianceReasons).toEqual(['Large transfer amount.', AML_HOLD_REASON]);
    const [a] = await riskAudits(db);
    expect(a.meta.held).toEqual(['first_to_recipient', 'amount_over_threshold']);
  });

  it('a prior paid send to the same recipient: first_to_recipient and first_transfer not derived', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await riskPartner(db, 'acme', riskConfigFor({ hold: ['first_to_recipient', 'first_transfer'] }));
    await seedPriorSends(db, 'acme', PHONE, { paid: 1, toRecipient: 1, recipientPhone: RECIPIENT });
    const t = await createTransfer(store, partnerStore, mvs, { ...base, amountSource: 600 });
    expect(t.complianceStatus).toBe('cleared');
    const [a] = await riskAudits(db);
    expect(a.meta.derived).toEqual(['amount_over_threshold']);
    expect(a.meta.held).toEqual([]);
  });

  it('an awaiting_payment or cancelled earlier row does NOT count (still first_transfer)', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await riskPartner(db);
    for (const status of ['awaiting_payment', 'cancelled'] as const) {
      await seedLedgerSpend(db, {
        partnerId: 'acme', phone: PHONE, amountUsd: 100, status,
        createdAt: new Date(Date.now() - 24 * HOUR), recipientPhone: RECIPIENT,
      });
    }
    await createTransfer(store, partnerStore, mvs, base);
    const [a] = await riskAudits(db);
    expect(a.meta.derived).toEqual(['first_to_recipient', 'first_transfer']);
  });

  it('new_account: first seen 1 hour ago (72 h window) -> new_account; 100 hours ago -> not', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await riskPartner(db);
    await seedPriorSends(db, 'acme', PHONE, { paid: 1, toRecipient: 1, recipientPhone: RECIPIENT });
    await seedSender(db, { partnerId: 'acme', phone: PHONE, firstSeenDaysAgo: 1 / 24, kycStatus: 'verified' });
    await createTransfer(store, partnerStore, mvs, base);
    await seedSender(db, { partnerId: 'acme', phone: PHONE, firstSeenDaysAgo: 100 / 24, kycStatus: 'verified' });
    await createTransfer(store, partnerStore, mvs, base);
    const rows = await riskAudits(db);
    expect(rows.map((r) => r.meta.derived)).toEqual([['new_account']]);
  });

  it('chat_cue is derived only when shown includes it', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await riskPartner(db);
    await seedPriorSends(db, 'acme', PHONE, { paid: 1, toRecipient: 1, recipientPhone: RECIPIENT });
    await createTransfer(store, partnerStore, mvs, base);
    expect(await riskAudits(db)).toEqual([]); // record-only callers never derive chat_cue
    await createTransfer(store, partnerStore, mvs, { ...base, risk: { shown: ['chat_cue'], acked: true, ackedAt: new Date().toISOString() } });
    const [a] = await riskAudits(db);
    expect(a.meta.derived).toEqual(['chat_cue']);
    expect(a.meta.shown).toEqual(['chat_cue']);
  });

  it('tenant scoping: another partner\'s paid sends by the same phone to the same recipient never count', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await riskPartner(db);
    await seedPartner(db, 'other');
    await seedPriorSends(db, 'other', PHONE, { paid: 2, toRecipient: 2, recipientPhone: RECIPIENT });
    await createTransfer(store, partnerStore, mvs, base);
    const [a] = await riskAudits(db);
    expect(a.meta.derived).toEqual(['first_to_recipient', 'first_transfer']);
  });
});

describe('risk signals: a failed read is recorded, never a hold or a refusal (owner Q25, D6)', { retry: 0 }, () => {
  it('priorSends null: checkFailed, sends signals not derived, not held; the row commits', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await riskPartner(db, 'acme', riskConfigFor({ hold: ['first_to_recipient', 'first_transfer'] }));
    wrapOps(store, (ops) => ({ ...ops, priorSends: async () => null }));
    const t = await createTransfer(store, partnerStore, mvs, base);
    expect(t.complianceStatus).toBe('cleared');
    expect(await createTransferRepo(db).getTransfer(t.id)).not.toBeNull();
    const [a] = await riskAudits(db);
    expect(a.meta).toEqual({
      shown: [], derived: [], acked: false, held: [], warningVersion: RISK_WARNING_VERSION, ackedAt: null, checkFailed: true,
    });
  });

  it('priorSends throws: absorbed like null, one logError("risk.signals_check") with { partnerId } only', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await riskPartner(db, 'acme', riskConfigFor({ hold: ['first_to_recipient'] }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    wrapOps(store, (ops) => ({ ...ops, priorSends: async () => { throw new Error('boom'); } }));
    const t = await createTransfer(store, partnerStore, mvs, base);
    expect(t.complianceStatus).toBe('cleared');
    const [a] = await riskAudits(db);
    expect(a.meta.checkFailed).toBe(true);
    expect(a.meta.held).toEqual([]);
    const errs = logs.errors.filter((e) => e.scope === 'risk.signals_check');
    expect(errs).toEqual([{ scope: 'risk.signals_check', fields: { partnerId: 'acme' } }]);
  });
});

describe('risk signals: reuse of the AML read (P19 step 2)', { retry: 0 }, () => {
  it('AML on (real money) and risk on: ONE prior-sends read inside the lock', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await amlMintFixture(db, { phone: PHONE });
    await setRisk(db, 'acme', riskConfigFor());
    const stop = captureQueries();
    const t = await createTransfer(store, partnerStore, mvs, { ...base, amountSource: 600 });
    const log = stop();
    expect(priorSendReads(log)).toHaveLength(1);
    expect(t.complianceReasons).toEqual([AML_HOLD_REASON]); // AML first_transfer, unchanged
    const [a] = await riskAudits(db);
    expect(a.meta.derived).toEqual(['first_to_recipient', 'first_transfer', 'amount_over_threshold']);
  });

  it('AML read failed (null): risk records checkFailed from the same read, no second read', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await amlMintFixture(db, { phone: PHONE });
    await setRisk(db, 'acme', riskConfigFor());
    let riskReads = 0;
    wrapOps(store, (ops) => ({
      ...ops,
      amlHoldInputs: async () => null,
      priorSends: async (...args) => { riskReads++; return ops.priorSends(...args); },
    }));
    const t = await createTransfer(store, partnerStore, mvs, base);
    expect(riskReads).toBe(0);
    expect(t.complianceReasons).toEqual([AML_HOLD_REASON]);
    const [a] = await riskAudits(db);
    expect(a.meta.checkFailed).toBe(true);
  });
});

describe('risk signals: config changed since the draft (P19 step 4)', { retry: 0 }, () => {
  it('switched off: shown still needs the ack; with it, derived [] and held [] even when hold lists it', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await riskPartner(db, 'acme', riskConfigFor({ enabled: false, hold: ['first_transfer'] }));
    await expect(createTransfer(store, partnerStore, mvs, { ...base, risk: { shown: ['first_transfer'], acked: false } }))
      .rejects.toBeInstanceOf(RiskAckRequiredError);
    const stop = captureQueries();
    const t = await createTransfer(store, partnerStore, mvs, {
      ...base, risk: { shown: ['first_transfer'], acked: true, ackedAt: new Date().toISOString() },
    });
    const log = stop();
    expect(t.complianceStatus).toBe('cleared');
    expect(priorSendReads(log)).toEqual([]);
    const [a] = await riskAudits(db);
    expect(a.meta.shown).toEqual(['first_transfer']);
    expect(a.meta.derived).toEqual([]);
    expect(a.meta.held).toEqual([]);
  });

  it('new thresholds decide derivation; a newly held signal that was only shown -> held', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await riskPartner(db, 'acme', riskConfigFor({ amountUsd: 1000, hold: ['chat_cue'] }));
    await seedPriorSends(db, 'acme', PHONE, { paid: 1, toRecipient: 1, recipientPhone: RECIPIENT });
    const t = await createTransfer(store, partnerStore, mvs, {
      ...base, amountSource: 600, risk: { shown: ['amount_over_threshold', 'chat_cue'], acked: true, ackedAt: new Date().toISOString() },
    });
    expect(t.complianceReasons).toEqual([AML_HOLD_REASON]);
    const [a] = await riskAudits(db);
    expect(a.meta.derived).toEqual(['chat_cue']); // $600 < the new $1,000 threshold
    expect(a.meta.held).toEqual(['chat_cue']);
  });

  it('a shown signal in the current hold list holds even when not derived now', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await riskPartner(db, 'acme', riskConfigFor({ amountUsd: 1000, hold: ['amount_over_threshold'] }));
    await seedPriorSends(db, 'acme', PHONE, { paid: 1, toRecipient: 1, recipientPhone: RECIPIENT });
    const t = await createTransfer(store, partnerStore, mvs, {
      ...base, amountSource: 600, risk: { shown: ['amount_over_threshold'], acked: true, ackedAt: new Date().toISOString() },
    });
    expect(t.complianceReasons).toEqual([AML_HOLD_REASON]);
    const [a] = await riskAudits(db);
    expect(a.meta.derived).toEqual([]);
    expect(a.meta.held).toEqual(['amount_over_threshold']);
  });
});

describe('risk signals: never for sandbox, b2b, the default tenant, blocked rows, or with config off', { retry: 0 }, () => {
  it('sandbox (environment test): no read, no savepoint, no risk.signals row', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await riskPartner(db, 'acme', riskConfigFor({ hold: ['first_transfer'] }));
    const stop = captureQueries();
    const t = await createTransfer(store, partnerStore, mvs, { ...base, environment: 'test' });
    const log = stop();
    expect(t.complianceStatus).toBe('cleared');
    expect(savepoints(log)).toEqual([]);
    expect(await riskAudits(db)).toEqual([]);
  });

  it('b2b: no read, no savepoint, no risk.signals row', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await riskPartner(db, 'acme', riskConfigFor({ hold: ['first_transfer'] }));
    const stop = captureQueries();
    const t = await createTransfer(store, partnerStore, mvs, {
      ...base, recipientName: 'Globex Trading LLC', fundingMethod: 'ach_pull', payoutDestination: '',
      transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business',
      senderBusinessName: 'Acme Imports Ltd', recipientBusinessName: 'Globex Trading LLC',
    });
    const log = stop();
    expect(t.complianceStatus).toBe('cleared');
    expect(savepoints(log)).toEqual([]);
    expect(await riskAudits(db)).toEqual([]);
  });

  it('default tenant with the config forced on by SQL: no read, no savepoint, no risk.signals row', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await setRisk(db, 'default', riskConfigFor({ hold: ['first_transfer'] }));
    await seedSender(db, { partnerId: 'default', phone: PHONE, firstSeenDaysAgo: 10, kycStatus: 'verified' });
    const stop = captureQueries();
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'default' });
    const log = stop();
    expect(t.complianceStatus).toBe('cleared');
    expect(savepoints(log)).toEqual([]);
    expect(await riskAudits(db)).toEqual([]);
  });

  it('blocked (watchlist name): no risk.signals row, no risk read, still blocked', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await riskPartner(db, 'acme', riskConfigFor({ hold: ['first_transfer'] }));
    const stop = captureQueries();
    const t = await createTransfer(store, partnerStore, mvs, {
      ...base, recipientName: 'John Doe', risk: { shown: ['first_transfer'], acked: true, ackedAt: new Date().toISOString() },
    });
    const log = stop();
    expect(t.complianceStatus).toBe('blocked');
    expect(t.complianceReasons).not.toContain(AML_HOLD_REASON);
    expect(priorSendReads(log)).toEqual([]);
    expect(await riskAudits(db)).toEqual([]);
  });

  it('config off (the default) and no input.risk: zero savepoint statements inside the lock, no risk.signals row', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await seedPartner(db, 'acme');
    await seedSender(db, { partnerId: 'acme', phone: PHONE, firstSeenDaysAgo: 10, kycStatus: 'verified' });
    const stop = captureQueries();
    const t = await createTransfer(store, partnerStore, mvs, { ...base, amountSource: 600 });
    const log = stop();
    expect(t.complianceStatus).toBe('cleared');
    expect(atLock(log).locked.length).toBeGreaterThan(0);
    expect(savepoints(log)).toEqual([]);
    expect(await riskAudits(db)).toEqual([]);
  });
});

describe('risk.signals meta is ids-only (P0 rule 5)', { retry: 0 }, () => {
  it('holds only enum strings, booleans, the version and the ISO ackedAt', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await riskPartner(db, 'acme', riskConfigFor({ hold: ['first_transfer'] }));
    const ackedAt = new Date().toISOString();
    await createTransfer(store, partnerStore, mvs, {
      ...base, amountSource: 600, risk: { shown: ['first_transfer', 'chat_cue'], acked: true, ackedAt },
    });
    const [a] = await riskAudits(db);
    const allowed = new Set<unknown>([...RISK_SIGNALS, RISK_WARNING_VERSION, ackedAt, true, false, null]);
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (v !== null && typeof v === 'object') { Object.values(v).forEach(walk); return; }
      expect(allowed.has(v)).toBe(true);
    };
    walk(a.meta);
    expect(Object.keys(a.meta).sort()).toEqual(['acked', 'ackedAt', 'derived', 'held', 'shown', 'warningVersion']);
    const text = JSON.stringify(a.meta);
    for (const pii of [PHONE, RECIPIENT, 'Mom', '600']) expect(text).not.toContain(pii);
  });

  it('a non-enum shown value is dropped before the ack check and the record', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await riskPartner(db);
    await seedPriorSends(db, 'acme', PHONE, { paid: 1, toRecipient: 1, recipientPhone: RECIPIENT });
    const t = await createTransfer(store, partnerStore, mvs, {
      ...base, risk: { shown: ['not_a_signal' as RiskSignal], acked: false },
    });
    expect(t.complianceStatus).toBe('cleared');
    expect(await riskAudits(db)).toEqual([]);
  });
});
