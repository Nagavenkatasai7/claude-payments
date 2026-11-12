/**
 * Fix pack 5 T20b (P22): a real-money consumer transfer whose travel-rule band
 * needs originator data that is not on file (the address always, the date of
 * birth by band), or that is ROUTED to another tenant's rail (the data cannot
 * be sent, owner decision C3), is HELD at settle with ORIGINATOR_INFO_MISSING,
 * and no release (staff, staff re-screen, the list sweep) sends such a row to
 * the rail while the data is missing. B2B and Partner-API-minted rows are
 * exempt. Not real money: no originator read at all.
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
import { createIdempotencyRepo } from '@/db/repos/aux-repos';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner, seedSender } from './helpers-db';
import { seedLiveEvidence } from './helpers-sanctions';
import { seedOriginatorForTest } from './helpers-live';
import type { Db } from '@/db/client';
import type { PartnerIntegrations } from '@/lib/partner-integrations';
import type { Transfer } from '@/lib/types';
import type { ComplianceResult } from '@/lib/compliance';
import {
  LARGE_AMOUNT_REASON,
  LIST_UNAVAILABLE_REASON,
  ORIGINATOR_INFO_MISSING_REASON,
} from '@/lib/compliance-config';

// The on-file read, counted and with a fault toggle. Every other method of the
// customer repo (and every other export) is the real one.
const onFile = vi.hoisted(() => ({ calls: 0, throwOnRead: false }));
vi.mock('@/db/repos/customer-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/customer-repo')>();
  return {
    ...real,
    createCustomerRepo: (...a: Parameters<typeof real.createCustomerRepo>) => {
      const r = real.createCustomerRepo(...a);
      return {
        ...r,
        originatorOnFile: async (...b: Parameters<typeof r.originatorOnFile>) => {
          onFile.calls += 1;
          if (onFile.throwOnRead) throw new Error('originator read failed');
          return r.originatorOnFile(...b);
        },
      };
    },
  };
});

const PHONE = '15551230000';

function fixture(over: Partial<Transfer> = {}): Transfer {
  return {
    id: 'oh_t1', phone: PHONE, amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'awaiting_payment', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: new Date(Date.now() - 60_000).toISOString(), partnerId: 'acme', environment: 'live',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
    ...over,
  } as Transfer;
}

const rail = (providerType: 'http' | 'simulator'): PartnerIntegrations => ({
  kyc: {},
  payment: {
    providerType,
    credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 's' },
    webhookSecret: 'w',
  },
  whatsapp: {},
});
const HTTP = rail('http');
const SIMULATOR = rail('simulator');
const MOCK: PartnerIntegrations = { kyc: {}, payment: {}, whatsapp: {} };
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

/** Saves the row with a legal name on file (so the pack 4 identity hold never fires) and fresh live evidence. */
async function awaiting(over: Partial<Transfer> = {}): Promise<Transfer> {
  const t = fixture(over);
  await store.saveTransfer({ ...t, recipientLegalName: 'Anita Legal' });
  await seedLiveEvidence(db, t);
  return t;
}

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  await seedPartner(db, 'acme');
  await seedPartner(db, 'railp');
  onFile.calls = 0;
  onFile.throwOnRead = false;
});

describe('settleOrHold: the originator hold on a real-money rail (pack 5 T20b, P22)', { retry: 0 }, () => {
  it('real money, address required and not on file: held in_review with ORIGINATOR_INFO_MISSING (and no other new reason); no instruct row', async () => {
    const t = await awaiting();
    expect(await settleOrHold(db, t, HTTP)).toEqual({ kind: 'held' });
    const after = await store.getTransfer(t.id);
    expect(after?.status).toBe('in_review');
    expect(after?.complianceStatus).toBe('flagged');
    expect(after?.complianceReasons).toEqual([ORIGINATOR_INFO_MISSING_REASON]);
    expect(await outboxRows()).toEqual([{ kind: 'whatsapp.text', dedupe_key: 'stage1:oh_t1' }]);
  });

  it('address on file (seedOriginatorForTest), $999 to IN: settles', async () => {
    await seedOriginatorForTest(db, 'acme', PHONE);
    const t = await awaiting({ amountUsd: 999 });
    expect(await settleOrHold(db, t, HTTP)).toEqual({ kind: 'started', webhookDriven: true });
    expect((await outboxRows()).map((r) => r.dedupe_key)).toEqual(['stage1:oh_t1', 'instruct:oh_t1']);
  });

  it('$1,000 to GB without a DOB: held', async () => {
    await seedOriginatorForTest(db, 'acme', PHONE);
    const t = await awaiting({ amountUsd: 1000, destinationCountry: 'GB', destinationCurrency: 'GBP' });
    expect(await settleOrHold(db, t, HTTP)).toEqual({ kind: 'held' });
    expect((await store.getTransfer(t.id))?.complianceReasons).toEqual([ORIGINATOR_INFO_MISSING_REASON]);
  });

  it('$3,000 to IN with address and DOB: settles', async () => {
    await seedOriginatorForTest(db, 'acme', PHONE, { address: true, dob: true });
    const t = await awaiting({ amountUsd: 3000 });
    expect(await settleOrHold(db, t, HTTP)).toEqual({ kind: 'started', webhookDriven: true });
  });

  it('$3,000 to IN with the address only: held', async () => {
    await seedOriginatorForTest(db, 'acme', PHONE);
    const t = await awaiting({ amountUsd: 3000 });
    expect(await settleOrHold(db, t, HTTP)).toEqual({ kind: 'held' });
  });

  it('a ROUTED real-money row is held even with everything on file', async () => {
    await seedOriginatorForTest(db, 'acme', PHONE, { address: true, dob: true });
    const t = await awaiting({ settlementPartnerId: 'railp' });
    expect(await settleOrHold(db, t, HTTP)).toEqual({ kind: 'held' });
    expect((await store.getTransfer(t.id))?.complianceReasons).toEqual([ORIGINATOR_INFO_MISSING_REASON]);
    expect((await outboxRows()).map((r) => r.dedupe_key)).toEqual(['stage1:oh_t1']);
  });

  it('exempt: a b2b row and a Partner-API-minted row settle with nothing on file', async () => {
    const b2b = await awaiting({ id: 'oh_b2b', transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business' });
    expect(await settleOrHold(db, b2b, HTTP)).toEqual({ kind: 'started', webhookDriven: true });
    const api = fixture({ id: 'oh_api' });
    await store.saveTransfer({ ...api, recipientLegalName: 'Anita Legal' });
    await createIdempotencyRepo(db).claim('acme', 'order-1', api.id);
    await seedLiveEvidence(db, api);
    expect(await settleOrHold(db, api, HTTP)).toEqual({ kind: 'started', webhookDriven: true });
  });

  it("not real money (simulator, mock, sandbox 'test'): settles, and originatorOnFile is never called", async () => {
    const runs: Array<[Transfer, PartnerIntegrations]> = [
      [fixture({ id: 'oh_sim' }), SIMULATOR],
      [fixture({ id: 'oh_mock' }), MOCK],
      [fixture({ id: 'oh_test', environment: 'test' }), HTTP],
      [fixture({ id: 'oh_sim_routed', settlementPartnerId: 'railp' }), SIMULATOR],
    ];
    for (const [t, integrations] of runs) {
      await store.saveTransfer(t);
      const r = await settleOrHold(db, t, integrations);
      expect(r.kind, t.id).toBe('started');
      expect((await store.getTransfer(t.id))?.complianceStatus, t.id).toBe('cleared');
    }
    expect(onFile.calls).toBe(0);
  });

  it('a failed originator read throws: nothing settles, nothing held', async () => {
    const t = await awaiting();
    onFile.throwOnRead = true;
    await expect(settleOrHold(db, t, HTTP)).rejects.toThrow('originator read failed');
    const after = await store.getTransfer(t.id);
    expect(after?.status).toBe('awaiting_payment');
    expect(after?.complianceStatus).toBe('cleared');
    expect(await outboxRows()).toEqual([]);
  });
});

describe('releaseHold: refused while the originator data is missing on a real-money rail (pack 5 T20b)', { retry: 0 }, () => {
  const held = (over: Partial<Transfer> = {}) =>
    fixture({ status: 'in_review', complianceStatus: 'flagged', complianceReasons: [ORIGINATOR_INFO_MISSING_REASON], ...over });
  const saveHeld = async (t: Transfer) => store.saveTransfer({ ...t, recipientLegalName: 'Anita Legal' });

  beforeEach(async () => {
    await seedSender(db, { partnerId: 'acme', phone: PHONE }); // a clear sender, nothing on file
  });

  it("refuses { kind: 'originator_missing' } while missing (nothing written); once the address is on file the release goes through", async () => {
    const t = held();
    await saveHeld(t);
    expect(await releaseHold(db, t, HTTP, STAFF)).toEqual({ kind: 'originator_missing' });
    expect((await store.getTransfer(t.id))?.status).toBe('in_review');
    expect(await auditActions()).toEqual([]);
    expect(await outboxRows()).toEqual([]);

    await seedOriginatorForTest(db, 'acme', PHONE);
    expect(await releaseHold(db, t, HTTP, STAFF)).toEqual({ kind: 'released', webhookDriven: true });
    expect((await outboxRows()).map((r) => r.dedupe_key)).toEqual(['instruct:oh_t1']);
  });

  it('a partner release is refused the same way', async () => {
    const t = held({ complianceReasons: [LARGE_AMOUNT_REASON] });
    await saveHeld(t);
    expect(await releaseHold(db, t, HTTP, { ...STAFF, actorScope: 'partner' }, { partnerId: 'acme' })).toEqual({ kind: 'originator_missing' });
    expect(await outboxRows()).toEqual([]);
  });

  it('a routed row is always refused', async () => {
    await seedOriginatorForTest(db, 'acme', PHONE, { address: true, dob: true });
    const t = held({ settlementPartnerId: 'railp' });
    await saveHeld(t);
    expect(await releaseHold(db, t, HTTP, STAFF)).toEqual({ kind: 'originator_missing' });
    expect(await outboxRows()).toEqual([]);
  });

  it('a held row WITHOUT the tag (held before deploy) is refused the same way', async () => {
    const t = held({ complianceReasons: [LARGE_AMOUNT_REASON] });
    await saveHeld(t);
    expect(await releaseHold(db, t, HTTP, STAFF)).toEqual({ kind: 'originator_missing' });
    expect((await store.getTransfer(t.id))?.status).toBe('in_review');
    expect(await auditActions()).toEqual([]);
    expect(await outboxRows()).toEqual([]);
  });

  it('not real money: released as today, no originator read', async () => {
    const t = held({ complianceReasons: [LARGE_AMOUNT_REASON] });
    await saveHeld(t);
    expect(await releaseHold(db, t, SIMULATOR, STAFF)).toEqual({ kind: 'released', webhookDriven: true });
    expect(onFile.calls).toBe(0);
  });

  it('the pack 4 identity refusal still comes first (no legal name and no address -> identity_missing)', async () => {
    const t = held({ complianceReasons: [LARGE_AMOUNT_REASON] });
    await store.saveTransfer(t);
    expect(await releaseHold(db, t, HTTP, STAFF)).toEqual({ kind: 'identity_missing' });
  });
});

describe('releaseHoldAfterRescreen: originator_missing after the evidence row, before the claim (pack 5 T20b)', { retry: 0 }, () => {
  beforeEach(async () => {
    await seedSender(db, { partnerId: 'acme', phone: PHONE });
  });

  it('returns originator_missing after the evidence row (kept), before the claim', async () => {
    const t = fixture({ status: 'in_review', complianceStatus: 'flagged', complianceReasons: [LARGE_AMOUNT_REASON] });
    await store.saveTransfer({ ...t, recipientLegalName: 'Anita Legal' });
    const r = await releaseHoldAfterRescreen(db, t.id, { result: clearLive(), uncovered: [], railIntegrations: HTTP, audit: STAFF });
    expect(r).toEqual({ kind: 'originator_missing' });
    expect(await auditActions()).toEqual(['sanctions.screen']);
    expect((await store.getTransfer(t.id))?.status).toBe('in_review');
    expect(await outboxRows()).toEqual([]);

    await seedOriginatorForTest(db, 'acme', PHONE);
    const again = await releaseHoldAfterRescreen(db, t.id, { result: clearLive(), uncovered: [], railIntegrations: HTTP, audit: STAFF });
    expect(again).toEqual({ kind: 'released', webhookDriven: true });
  });
});

describe('releaseRescreenedHold (the list sweep): adds ORIGINATOR_INFO_MISSING (pack 5 T20b)', { retry: 0 }, () => {
  const sweep = (id: string, realMoney: boolean, r: PartnerIntegrations) =>
    releaseRescreenedHold(db, id, { result: clearLive(), railIntegrations: r, senderHold: false, realMoney, uncovered: [] });
  const listHeld = async (over: Partial<Transfer> = {}) => {
    const t = fixture({ status: 'in_review', complianceStatus: 'flagged', complianceReasons: [LIST_UNAVAILABLE_REASON], ...over });
    await store.saveTransfer({ ...t, recipientLegalName: 'Anita Legal' });
    return t;
  };

  it('the list sweep adds ORIGINATOR_INFO_MISSING and keeps the row held', async () => {
    const t = await listHeld();
    expect(await sweep(t.id, true, HTTP)).toEqual({ kind: 'still_held' });
    const after = await store.getTransfer(t.id);
    expect(after?.status).toBe('in_review');
    expect(after?.complianceStatus).toBe('flagged');
    expect(after?.complianceReasons).toEqual([ORIGINATOR_INFO_MISSING_REASON]);
    expect((await auditActions()).filter((a) => a === 'transfer.rescreen')).toHaveLength(1);
    expect(await outboxRows()).toEqual([]);
  });

  it('with the address on file -> released as today', async () => {
    await seedOriginatorForTest(db, 'acme', PHONE);
    const t = await listHeld();
    expect(await sweep(t.id, true, HTTP)).toEqual({ kind: 'released' });
  });

  it('not real money -> no originator read, released', async () => {
    const t = await listHeld();
    expect(await sweep(t.id, false, SIMULATOR)).toEqual({ kind: 'released' });
    expect(onFile.calls).toBe(0);
  });
});
