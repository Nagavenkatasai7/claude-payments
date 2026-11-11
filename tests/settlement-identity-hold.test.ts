/**
 * Fix pack 4 T14 (R03, C19): a real-money consumer transfer with no
 * account-holder (legal) name on file is HELD with RECIPIENT_IDENTITY_MISSING
 * at settle, and no release (staff, staff re-screen, the automatic list sweep)
 * sends such a row to the rail, whether or not it carries the reason.
 * Partner-API, payment-link and B2B rows are exempt. Not real money: no
 * identity read at all.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import {
  settleOrHold,
  releaseHold,
  releaseHoldAfterRescreen,
  releaseRescreenedHold,
} from '@/lib/settlement';
import { createAuditRepo, createIdempotencyRepo } from '@/db/repos/aux-repos';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner, seedSender, captureQueries } from './helpers-db';
import { seedLiveEvidence } from './helpers-sanctions';
import type { Db } from '@/db/client';
import type { PartnerIntegrations } from '@/lib/partner-integrations';
import type { Transfer } from '@/lib/types';
import type { ComplianceResult } from '@/lib/compliance';
import {
  LARGE_AMOUNT_REASON,
  LIST_UNAVAILABLE_REASON,
  RECIPIENT_IDENTITY_MISSING_REASON,
} from '@/lib/compliance-config';
import { seedOriginatorForTest } from './helpers-live';

// The identity read, with a fault toggle (the "read throws" case). Every other
// method of the repo is the real one.
const identityFault = vi.hoisted(() => ({ throwOnRead: false }));
vi.mock('@/db/repos/transfer-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/transfer-repo')>();
  return {
    ...real,
    createTransferRepo: (...a: Parameters<typeof real.createTransferRepo>) => {
      const r = real.createTransferRepo(...a);
      return {
        ...r,
        recipientIdentityMissing: async (...b: Parameters<typeof r.recipientIdentityMissing>) => {
          if (identityFault.throwOnRead) throw new Error('identity read failed');
          return r.recipientIdentityMissing(...b);
        },
      };
    },
  };
});

function fixture(over: Partial<Transfer> = {}): Transfer {
  return {
    id: 'ih_t1', phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'awaiting_payment', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: new Date(Date.now() - 60_000).toISOString(), partnerId: 'acme', environment: 'live',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
    ...over,
  } as Transfer;
}

const HTTP: PartnerIntegrations = {
  kyc: {},
  payment: {
    providerType: 'http',
    credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 's' },
    webhookSecret: 'w',
  },
  whatsapp: {},
};
const SIMULATOR: PartnerIntegrations = {
  kyc: {},
  payment: {
    providerType: 'simulator',
    credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 's' },
    webhookSecret: 'w',
  },
  whatsapp: {},
};
const MOCK: PartnerIntegrations = { kyc: {}, payment: {}, whatsapp: {} };
const H = 3_600_000;
const STAFF = { actor: 'plat', reason: 'checked' };

let db: Db;
let store: ReturnType<typeof createStore>;

async function outboxRows(): Promise<Array<{ kind: string; dedupe_key: string | null }>> {
  const r = await db.execute(sql`SELECT kind, dedupe_key FROM outbox ORDER BY id`);
  return (r as unknown as { rows: Array<{ kind: string; dedupe_key: string | null }> }).rows;
}

async function auditActions(): Promise<string[]> {
  const r = await db.execute(sql`SELECT action FROM audit_events ORDER BY id`);
  return (r as unknown as { rows: Array<{ action: string }> }).rows.map((x) => x.action);
}

// The identity read is the one query that tests the legal-name column for NULL
// (other reads only list the column).
const IDENTITY_TEST = 'recipient_legal_name_enc" is null';
const identityQueries = (qs: Array<{ sql: string }>) => qs.filter((q) => q.sql.includes(IDENTITY_TEST));
const forUpdates = (qs: Array<{ sql: string }>) => qs.filter((q) => q.sql.toLowerCase().includes('for update'));

function clearLive(): ComplianceResult {
  const now = new Date().toISOString();
  return {
    status: 'cleared',
    reasons: [],
    evidence: {
      listSource: 'ofac-sdn', listVersion: 'v1', listHash: 'h', screenedAt: now,
      decision: 'clear', parties: [], listFitness: 'live', listCheckedAt: now,
    },
  };
}

function matchLive(): ComplianceResult {
  const now = new Date().toISOString();
  return {
    status: 'blocked',
    reasons: ['Sanctions list match.'],
    evidence: {
      listSource: 'ofac-sdn', listVersion: 'v1', listHash: 'h', screenedAt: now,
      decision: 'match', parties: [], listFitness: 'live', listCheckedAt: now,
    },
  };
}

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  await seedPartner(db, 'acme');
  // Fix pack 5 T20a (P0 rule 9): the sender's travel-rule data on file, ahead of the T20b/T23 gates.
  await seedOriginatorForTest(db, 'acme', '15551230000', { address: true, dob: true });
  identityFault.throwOnRead = false;
});

describe('settleOrHold: the identity-missing hold on a real-money rail (pack 4 T14, C19)', { retry: 0 }, () => {
  it('http rail, b2c, cleared, live evidence, no legal name -> held with [RECIPIENT_IDENTITY_MISSING], no settlement.instruct, one held stage-1', async () => {
    const t = fixture();
    await store.saveTransfer(t);
    await seedLiveEvidence(db, t);
    expect(await settleOrHold(db, t, HTTP)).toEqual({ kind: 'held' });
    const after = await store.getTransfer(t.id);
    expect(after?.status).toBe('in_review');
    expect(after?.complianceStatus).toBe('flagged');
    expect(after?.complianceReasons).toEqual([RECIPIENT_IDENTITY_MISSING_REASON]);
    expect(await outboxRows()).toEqual([{ kind: 'whatsapp.text', dedupe_key: 'stage1:ih_t1' }]);
  });

  it('the same row with a legal name on file -> started, instructed', async () => {
    const t = fixture();
    await store.saveTransfer({ ...t, recipientLegalName: 'Anita Legal' });
    await seedLiveEvidence(db, t);
    expect(await settleOrHold(db, t, HTTP)).toEqual({ kind: 'started', webhookDriven: true });
    expect((await outboxRows()).map((r) => r.dedupe_key)).toEqual(['stage1:ih_t1', 'instruct:ih_t1']);
  });

  it('stale evidence and no name -> held with [LIST_UNAVAILABLE, RECIPIENT_IDENTITY_MISSING]', async () => {
    const t = fixture();
    await store.saveTransfer(t);
    await seedLiveEvidence(db, t, { screenedAgoMs: 37 * H });
    expect(await settleOrHold(db, t, HTTP)).toEqual({ kind: 'held' });
    expect((await store.getTransfer(t.id))?.complianceReasons).toEqual([LIST_UNAVAILABLE_REASON, RECIPIENT_IDENTITY_MISSING_REASON]);
  });

  it('flagged LARGE and no name -> held with [LARGE, RECIPIENT_IDENTITY_MISSING]', async () => {
    const t = fixture({ complianceStatus: 'flagged', complianceReasons: [LARGE_AMOUNT_REASON] });
    await store.saveTransfer(t);
    await seedLiveEvidence(db, t);
    expect(await settleOrHold(db, t, HTTP)).toEqual({ kind: 'held' });
    expect((await store.getTransfer(t.id))?.complianceReasons).toEqual([LARGE_AMOUNT_REASON, RECIPIENT_IDENTITY_MISSING_REASON]);
  });

  it('exempt: a Partner-API row (idempotency claim) -> started', async () => {
    const t = fixture({ id: 'ih_api' });
    await store.saveTransfer(t);
    await createIdempotencyRepo(db).claim('acme', 'order-1', t.id);
    await seedLiveEvidence(db, t);
    expect(await settleOrHold(db, t, HTTP)).toEqual({ kind: 'started', webhookDriven: true });
  });

  it("exempt: an api_key 'transaction.create' audit row -> started", async () => {
    const t = fixture({ id: 'ih_api_audit' });
    await store.saveTransfer(t);
    await createAuditRepo(db).record({ partnerId: 'acme', actor: 'pk_1', actorType: 'api_key', action: 'transaction.create', subjectId: t.id });
    await seedLiveEvidence(db, t);
    expect(await settleOrHold(db, t, HTTP)).toEqual({ kind: 'started', webhookDriven: true });
  });

  it('exempt: a payment-link row -> started', async () => {
    const t = fixture({ id: 'ih_link' });
    await store.saveTransfer(t);
    await createIdempotencyRepo(db).claim('acme', 'paylink:l_1', t.id);
    await seedLiveEvidence(db, t);
    expect(await settleOrHold(db, t, HTTP)).toEqual({ kind: 'started', webhookDriven: true });
  });

  it('b2b row -> started, and no identity query runs', async () => {
    const t = fixture({ id: 'ih_b2b', transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business' });
    await store.saveTransfer(t);
    await seedLiveEvidence(db, t);
    const stop = captureQueries();
    const r = await settleOrHold(db, t, HTTP);
    const qs = stop();
    expect(r).toEqual({ kind: 'started', webhookDriven: true });
    expect(identityQueries(qs)).toEqual([]);
  });

  it("simulator / mock / env 'test': no identity query, unchanged", async () => {
    const runs: Array<[Transfer, PartnerIntegrations]> = [
      [fixture({ id: 'ih_sim' }), SIMULATOR],
      [fixture({ id: 'ih_mock' }), MOCK],
      [fixture({ id: 'ih_test', environment: 'test' }), HTTP],
    ];
    for (const [t, integrations] of runs) {
      await store.saveTransfer(t);
      const stop = captureQueries();
      const r = await settleOrHold(db, t, integrations);
      const qs = stop();
      expect(r.kind, t.id).toBe('started');
      expect(identityQueries(qs), t.id).toEqual([]);
      expect((await store.getTransfer(t.id))?.complianceStatus, t.id).toBe('cleared');
    }
  });

  it('the identity read throws -> settleOrHold throws, row awaiting_payment, nothing in the outbox', async () => {
    const t = fixture();
    await store.saveTransfer(t);
    await seedLiveEvidence(db, t);
    identityFault.throwOnRead = true;
    await expect(settleOrHold(db, t, HTTP)).rejects.toThrow('identity read failed');
    expect((await store.getTransfer(t.id))?.status).toBe('awaiting_payment');
    expect(await outboxRows()).toEqual([]);
  });
});

describe('releaseHold: refused while the name is missing on a real-money rail (pack 4 T14, C19)', { retry: 0 }, () => {
  const held = (over: Partial<Transfer> = {}) =>
    fixture({ status: 'in_review', complianceStatus: 'flagged', complianceReasons: [RECIPIENT_IDENTITY_MISSING_REASON], ...over });

  beforeEach(async () => {
    await seedSender(db, { partnerId: 'acme', phone: fixture().phone }); // a clear sender
  });

  it('platform, http, a held row with the reason and no name -> identity_missing, still in_review, nothing written', async () => {
    const t = held();
    await store.saveTransfer(t);
    expect(await releaseHold(db, t, HTTP, STAFF)).toEqual({ kind: 'identity_missing' });
    expect((await store.getTransfer(t.id))?.status).toBe('in_review');
    expect(await auditActions()).toEqual([]);
    expect(await outboxRows()).toEqual([]);
  });

  it('a held row with the reason whose stored row carries a legal name -> released', async () => {
    const t = held();
    await store.saveTransfer({ ...t, recipientLegalName: 'Anita Legal' });
    expect(await releaseHold(db, t, HTTP, STAFF)).toEqual({ kind: 'released', webhookDriven: true });
    expect((await outboxRows()).map((r) => r.dedupe_key)).toEqual(['instruct:ih_t1']);
  });

  it('a LARGE-only hold on http with no name (held before deploy) -> identity_missing (critic P4)', async () => {
    const t = held({ complianceReasons: [LARGE_AMOUNT_REASON] });
    await store.saveTransfer(t);
    expect(await releaseHold(db, t, HTTP, STAFF)).toEqual({ kind: 'identity_missing' });
    expect((await store.getTransfer(t.id))?.status).toBe('in_review');
    expect(await outboxRows()).toEqual([]);
  });

  it('a partner release of a LARGE hold on http with no name -> identity_missing', async () => {
    const t = held({ complianceReasons: [LARGE_AMOUNT_REASON] });
    await store.saveTransfer(t);
    expect(await releaseHold(db, t, HTTP, { ...STAFF, actorScope: 'partner' }, { partnerId: 'acme' })).toEqual({ kind: 'identity_missing' });
    expect(await outboxRows()).toEqual([]);
  });

  it('the same LARGE hold on a simulator rail -> released as today, no identity query and no extra FOR UPDATE (critic P12)', async () => {
    const t = held({ complianceReasons: [LARGE_AMOUNT_REASON] });
    await store.saveTransfer(t);
    const stop = captureQueries();
    const r = await releaseHold(db, t, SIMULATOR, STAFF);
    const qs = stop();
    expect(r).toEqual({ kind: 'released', webhookDriven: true });
    expect(identityQueries(qs)).toEqual([]);
    expect(forUpdates(qs)).toEqual([]);
  });

  it('a Partner-API-minted or payment-link row held LARGE on http with no name -> released (exempt)', async () => {
    const api = held({ id: 'ih_rapi', complianceReasons: [LARGE_AMOUNT_REASON] });
    const link = held({ id: 'ih_rlink', complianceReasons: [LARGE_AMOUNT_REASON] });
    await store.saveTransfer(api);
    await store.saveTransfer(link);
    await createIdempotencyRepo(db).claim('acme', 'order-2', api.id);
    await createIdempotencyRepo(db).claim('acme', 'paylink:l_2', link.id);
    expect(await releaseHold(db, api, HTTP, STAFF)).toEqual({ kind: 'released', webhookDriven: true });
    expect(await releaseHold(db, link, HTTP, STAFF)).toEqual({ kind: 'released', webhookDriven: true });
  });

  it('lock order unchanged: releaseHold on http (name on file) locks the transfer before the customer and both before the claim', async () => {
    const t = held({ complianceReasons: [LARGE_AMOUNT_REASON] });
    await store.saveTransfer({ ...t, recipientLegalName: 'Anita Legal' });
    const stop = captureQueries();
    expect(await releaseHold(db, t, HTTP, STAFF)).toEqual({ kind: 'released', webhookDriven: true });
    const lower = stop().map((q) => q.sql.toLowerCase());
    const identity = lower.findIndex((q) => q.includes(IDENTITY_TEST));
    const tLock = lower.findIndex((q) => q.includes('"transfers"') && q.includes('for update'));
    const cLock = lower.findIndex((q) => q.includes('"customers"') && q.includes('for update'));
    const claim = lower.findIndex((q) => q.startsWith('update "transfers"'));
    expect(identity).toBeGreaterThanOrEqual(0);
    expect(lower[identity]).not.toContain('for update'); // the identity check takes no lock
    expect(tLock).toBeGreaterThan(identity);
    expect(cLock).toBeGreaterThan(tLock);
    expect(claim).toBeGreaterThan(cLock);
  });
});

describe('releaseHoldAfterRescreen: the check sits after the evidence, block and held branches (pack 4 T14, critic C2)', { retry: 0 }, () => {
  const held = () => fixture({ status: 'in_review', complianceStatus: 'flagged', complianceReasons: [LARGE_AMOUNT_REASON] });

  beforeEach(async () => {
    await seedSender(db, { partnerId: 'acme', phone: fixture().phone });
  });

  it('a live CLEAR re-screen on a nameless row -> identity_missing, the sanctions.screen evidence row IS written', async () => {
    const t = held();
    await store.saveTransfer(t);
    const r = await releaseHoldAfterRescreen(db, t.id, { result: clearLive(), uncovered: [], railIntegrations: HTTP, audit: STAFF });
    expect(r).toEqual({ kind: 'identity_missing' });
    expect(await auditActions()).toEqual(['sanctions.screen']);
    expect((await store.getTransfer(t.id))?.status).toBe('in_review');
    expect(await outboxRows()).toEqual([]);
  });

  it('a MATCH re-screen on a nameless row -> blocked, evidence written, block notices enqueued', async () => {
    const t = held();
    await store.saveTransfer(t);
    const r = await releaseHoldAfterRescreen(db, t.id, { result: matchLive(), uncovered: [], railIntegrations: HTTP, audit: STAFF });
    expect(r).toEqual({ kind: 'blocked' });
    expect((await auditActions())[0]).toBe('sanctions.screen');
    expect((await store.getTransfer(t.id))?.complianceStatus).toBe('blocked');
    expect((await outboxRows()).length).toBeGreaterThan(0);
  });

  it('the same clear re-screen with a legal name on file -> released', async () => {
    const t = held();
    await store.saveTransfer({ ...t, recipientLegalName: 'Anita Legal' });
    const r = await releaseHoldAfterRescreen(db, t.id, { result: clearLive(), uncovered: [], railIntegrations: HTTP, audit: STAFF });
    expect(r).toEqual({ kind: 'released', webhookDriven: true });
  });
});

describe('releaseRescreenedHold (the list sweep): never releases a nameless real-money row (pack 4 T14, P4)', { retry: 0 }, () => {
  const listHeld = () => fixture({ status: 'in_review', complianceStatus: 'flagged', complianceReasons: [LIST_UNAVAILABLE_REASON] });
  const sweep = (id: string, realMoney: boolean, rail: PartnerIntegrations) =>
    releaseRescreenedHold(db, id, { result: clearLive(), railIntegrations: rail, senderHold: false, realMoney, uncovered: [] });

  it('LIST_UNAVAILABLE-only, real money, no name, clean live re-screen -> still_held, flagged with [RECIPIENT_IDENTITY_MISSING], one transfer.rescreen, no rail effect', async () => {
    const t = listHeld();
    await store.saveTransfer(t);
    expect(await sweep(t.id, true, HTTP)).toEqual({ kind: 'still_held' });
    const after = await store.getTransfer(t.id);
    expect(after?.status).toBe('in_review');
    expect(after?.complianceStatus).toBe('flagged');
    expect(after?.complianceReasons).toEqual([RECIPIENT_IDENTITY_MISSING_REASON]);
    expect((await auditActions()).filter((a) => a === 'transfer.rescreen')).toHaveLength(1);
    expect(await outboxRows()).toEqual([]);
  });

  it('with a name on file -> released as today', async () => {
    const t = listHeld();
    await store.saveTransfer({ ...t, recipientLegalName: 'Anita Legal' });
    expect(await sweep(t.id, true, HTTP)).toEqual({ kind: 'released' });
    expect((await outboxRows()).map((r) => r.dedupe_key)).toEqual(['instruct:ih_t1']);
  });

  it('not real money -> no identity query, released', async () => {
    const t = listHeld();
    await store.saveTransfer(t);
    const stop = captureQueries();
    const r = await sweep(t.id, false, SIMULATOR);
    const qs = stop();
    expect(r).toEqual({ kind: 'released' });
    expect(identityQueries(qs)).toEqual([]);
  });
});
