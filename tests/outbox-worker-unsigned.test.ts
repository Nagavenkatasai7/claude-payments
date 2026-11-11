import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { certifyPartnerForTest, seedRealMoneyRail } from './helpers-live';
import { createOutboxRepo, MAX_ATTEMPTS } from '@/db/repos/outbox-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { drainOnce, RAILFAIL_ALERT_MIN_ATTEMPT, type WorkerDeps } from '@/lib/outbox-worker';
import { invalidateFlagCache } from '@/lib/flags';
import { env } from '@/lib/env';
import type { PartnerIntegrations } from '@/lib/partner-integrations';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

// Fix pack 5 T1 (P5, G11 in P8): nothing is ever POSTed to or from a rail
// unsigned. The instruct refuses an empty signing secret as a rail
// configuration failure (RailInstructError, like a missing URL, after the URL
// check); the partner-pulled reverse and the reference rail's callback refuse
// with UnsignedRailError (default policy: dead at MAX_ATTEMPTS + dead:<id>).

const ID = 'us_t1';
const URL_ = 'https://rail.example/settle';

function transferFixture(over: Partial<Transfer> = {}): Transfer {
  return {
    id: ID, phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'paid', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: new Date(Date.now() - 3_600_000).toISOString(), paidAt: new Date(Date.now() - 3_000_000).toISOString(), partnerId: 'acme',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
    ...over,
  } as Transfer;
}

let db: Db;
let store: ReturnType<typeof createStore>;
let outbox: ReturnType<typeof createOutboxRepo>;
const fetchFn = vi.fn();

function deps(): WorkerDeps {
  return {
    db,
    store,
    sendText: vi.fn(async () => {}) as unknown as WorkerDeps['sendText'],
    sendTemplate: vi.fn(async () => {}) as unknown as WorkerDeps['sendTemplate'],
    fetchFn: fetchFn as unknown as typeof fetch,
    recipientTemplateName: 'transfer_delivered',
    recipientTemplateLang: 'en',
    listStaff: async () => [],
    runAgentTurn: vi.fn(async () => '') as unknown as WorkerDeps['runAgentTurn'],
  };
}

async function saveRail(payment: PartnerIntegrations['payment']) {
  await createIntegrationsRepo(db).saveIntegrations('acme', { kyc: {}, whatsapp: {}, payment });
}

type RowState = { status: string; attempts: number; last_error: string | null };
async function rowState(kind: string): Promise<RowState> {
  const r = (await db.execute(sql`SELECT status, attempts, last_error FROM outbox WHERE kind = ${kind}`)) as unknown as {
    rows: RowState[];
  };
  return r.rows[0];
}
async function opsAlerts(): Promise<string[]> {
  const r = (await db.execute(sql`SELECT dedupe_key AS k FROM outbox WHERE kind = 'ops.alert' ORDER BY id`)) as unknown as {
    rows: Array<{ k: string }>;
  };
  return r.rows.map((x) => x.k);
}
const setAttempts = (kind: string, n: number) =>
  db.execute(sql`UPDATE outbox SET attempts = ${n}, next_attempt_at = now() WHERE kind = ${kind}`);
const enqueueInstruct = () => outbox.enqueue('settlement.instruct', { transferId: ID }, { dedupeKey: `instruct:${ID}` });

beforeEach(async () => {
  db = await freshDb();
  invalidateFlagCache(db);
  store = createStore(fakeRedis(), db);
  outbox = createOutboxRepo(db);
  await seedPartner(db, 'acme');
  fetchFn.mockReset();
  fetchFn.mockResolvedValue(new Response(JSON.stringify({ providerRef: 'rail-1' }), { status: 200 }));
  await store.saveTransfer(transferFixture());
});

describe('settlement.instruct never sends unsigned (pack 5 T1, G11)', { retry: 0 }, () => {
  it("simulator rail with no signing secret: no fetch, RailInstructError 'Signing secret not configured.', retried under the instruct policy", async () => {
    await saveRail({ providerType: 'simulator', credentials: {}, webhookSecret: 'whk' });
    await enqueueInstruct();
    const r = await drainOnce(deps(), 'w1');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(r).toMatchObject({ processed: 0, failed: 1, dead: 0 });
    expect(await rowState('settlement.instruct')).toEqual({ status: 'failed', attempts: 1, last_error: 'Signing secret not configured.' });
    expect((await store.getTransfer(ID))!.paymentProviderRef).toBeFalsy();
    expect(await opsAlerts()).toEqual([]);
  });

  it('http rail with a URL but no secret: no fetch; at attempt 3 one railfail:<rail>:<hour> alert (same as a missing URL)', async () => {
    await certifyPartnerForTest(db, 'acme');
    await seedRealMoneyRail(db, 'acme', { signingSecret: null });
    await enqueueInstruct();
    await drainOnce(deps(), 'w1');
    expect(fetchFn).not.toHaveBeenCalled();
    expect((await rowState('settlement.instruct')).last_error).toBe('Signing secret not configured.');
    expect(await opsAlerts()).toEqual([]);

    await setAttempts('settlement.instruct', RAILFAIL_ALERT_MIN_ATTEMPT - 1);
    await drainOnce(deps(), 'w1');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await rowState('settlement.instruct')).toMatchObject({ status: 'failed', attempts: RAILFAIL_ALERT_MIN_ATTEMPT });
    expect(await opsAlerts()).toEqual([expect.stringMatching(/^railfail:acme:\d+$/)]);
  });

  it("a missing URL still answers 'Settlement endpoint not configured.' first (URL before secret)", async () => {
    await saveRail({ providerType: 'http', credentials: {}, webhookSecret: 'whk' });
    await certifyPartnerForTest(db, 'acme');
    await enqueueInstruct();
    await drainOnce(deps(), 'w1');
    expect(fetchFn).not.toHaveBeenCalled();
    expect((await rowState('settlement.instruct')).last_error).toBe('Settlement endpoint not configured.');
  });

  it('a rotated-out previous secret alone never signs', async () => {
    await certifyPartnerForTest(db, 'acme');
    await saveRail({
      providerType: 'http',
      credentials: {
        settlementUrl: URL_,
        previousSigningSecret: 'old',
        previousSigningSecretUntil: new Date(Date.now() + 3_600_000).toISOString(),
      },
      webhookSecret: 'whk',
    });
    await enqueueInstruct();
    await drainOnce(deps(), 'w1');
    expect(fetchFn).not.toHaveBeenCalled();
    expect((await rowState('settlement.instruct')).last_error).toBe('Signing secret not configured.');
  });
});

describe('funding.refund reverse and rail.callback never send unsigned (pack 5 T1)', { retry: 0 }, () => {
  it("partner-pulled B2B reverse on a rail with no signing secret: no fetch, last_error 'no_signing_secret', refund stays pending, dead at MAX_ATTEMPTS with dead:<id>", async () => {
    await saveRail({ providerType: 'http', credentials: { settlementUrl: URL_ }, webhookSecret: 'whk' });
    await store.saveTransfer({
      ...transferFixture(),
      fundingMethod: 'ach_pull',
      transferType: 'b2b',
      achTokenRef: 'ach_deadbeef',
      senderBusinessName: 'Raj Trading Co',
      recipientBusinessName: 'Wilson HK Ltd',
      refundStatus: 'pending',
    } as Transfer);
    await outbox.enqueue('funding.refund', { transferId: ID }, { dedupeKey: `refund:${ID}` });
    let r = await drainOnce(deps(), 'w1');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(r.failed).toBe(1);
    expect(await rowState('funding.refund')).toEqual({ status: 'failed', attempts: 1, last_error: 'no_signing_secret' });
    expect((await store.getTransfer(ID))!.refundStatus).toBe('pending');

    await setAttempts('funding.refund', MAX_ATTEMPTS - 1);
    r = await drainOnce(deps(), 'w1');
    expect(r.dead).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect((await rowState('funding.refund')).status).toBe('dead');
    expect((await store.getTransfer(ID))!.refundStatus).toBe('pending');
    expect(await opsAlerts()).toEqual([expect.stringMatching(/^dead:\d+$/)]);
  });

  it("rail.callback with an empty webhook secret: no fetch, last_error 'no_signing_secret'", async () => {
    await saveRail({ providerType: 'simulator', credentials: { signingSecret: 'sgn' }, webhookSecret: '' });
    await outbox.enqueue('rail.callback', { reference: ID, partner_id: 'acme' });
    const r = await drainOnce(deps(), 'w1');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(r.failed).toBe(1);
    expect(await rowState('rail.callback')).toMatchObject({ status: 'failed', attempts: 1, last_error: 'no_signing_secret' });
  });

  it('with both secrets nothing changes: instruct, reverse and callback POST with both headers', async () => {
    await saveRail({ providerType: 'simulator', credentials: { signingSecret: 'sgn' }, webhookSecret: 'whk' });
    await enqueueInstruct();
    await outbox.enqueue('rail.callback', { reference: ID, partner_id: 'acme' });
    await store.saveTransfer({
      ...transferFixture({ id: 'us_t2' }),
      fundingMethod: 'ach_pull',
      transferType: 'b2b',
      achTokenRef: 'ach_deadbeef',
      senderBusinessName: 'Raj Trading Co',
      recipientBusinessName: 'Wilson HK Ltd',
      refundStatus: 'pending',
    } as Transfer);
    await outbox.enqueue('funding.refund', { transferId: 'us_t2' }, { dedupeKey: 'refund:us_t2' });
    fetchFn.mockImplementation(async () => new Response(JSON.stringify({ providerRef: 'rail-1' }), { status: 200 }));
    await drainOnce(deps(), 'w1');
    expect(fetchFn).toHaveBeenCalledTimes(3);
    const urls = fetchFn.mock.calls.map((c) => (c as [string])[0]).sort();
    expect(urls).toEqual(
      [`${env.appBaseUrl}/api/partner-rail`, `${env.appBaseUrl}/api/partner-rail`, `${env.appBaseUrl}/api/payment-webhook/simulator`].sort(),
    );
    for (const c of fetchFn.mock.calls) {
      const h = (c as [string, RequestInit])[1].headers as Record<string, string>;
      expect(h['x-signature']).toMatch(/^[0-9a-f]{64}$/);
      expect(h['x-smartremit-signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    }
    const st = (await db.execute(sql`SELECT kind, status FROM outbox WHERE kind <> 'ops.alert' ORDER BY id`)) as unknown as {
      rows: Array<{ kind: string; status: string }>;
    };
    expect(st.rows.filter((x) => x.kind !== 'whatsapp.text' && x.kind !== 'whatsapp.template').map((x) => x.status)).toEqual(['done', 'done', 'done']);
  });
});
