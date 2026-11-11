/**
 * W1 — /api/funding-webhook/[provider]: the funding provider's async callback
 * (captures/refunds confirmed out-of-band). Mirrors payment-webhook's posture:
 * per-IP limit fail-open, HMAC over the RAW body FAIL-CLOSED for every provider
 * including 'mock' (secret via FUNDING_WEBHOOK_SECRET_<PROVIDER>, '' ⇒ reject;
 * no carve-out — money-01 / F42), unknown/junk ⇒ 200 ignored. The route only
 * mirrors funding state:
 *  - captured      ⇒ setFundingRef (write-once; NO status change — the pay
 *                    route owns settlement)
 *  - refunded      ⇒ refundStatus pending→completed (+ref +refundedAt)
 *  - refund_failed ⇒ refundStatus pending→failed
 * It sends NO WhatsApp messages — the refund engine owns customer messaging.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { freshDb, seedPartner } from './helpers-db';
import { seedRealMoneyRail } from './helpers-live';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import type { Transfer } from '@/lib/types';

let db: Awaited<ReturnType<typeof freshDb>>;
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => db };
});

// Fix pack 5 T13a: the route pokes the worker after an ops.alert enqueue.
vi.mock('@/lib/outbox', () => ({ pokeWorker: () => {}, pokeWorkerDelayed: () => {} }));

// Stage 3 posture: the per-IP limiter would dial Upstash — always allow here.
vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));

import { POST } from '@/app/api/funding-webhook/[provider]/route';

const SECRET = 'stripe-funding-secret';
const MOCK_SECRET = 'mock-funding-secret';
const sig = (b: string, s = SECRET) => createHmac('sha256', s).update(b).digest('hex');

function post(provider: string, raw: string, signature?: string) {
  const req = new NextRequest('https://x/api/funding-webhook/' + provider, {
    method: 'POST', body: raw,
    headers: signature ? { 'x-signature': signature } : {},
  });
  return POST(req, { params: Promise.resolve({ provider }) });
}

function makeTransfer(o: Partial<Transfer> & { id: string }): Transfer {
  return {
    phone: '15551234567', amountUsd: 200, feeUsd: 0, totalChargeUsd: 200, fxRate: 85,
    amountInr: 17000, recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789 HDFC0001234',
    fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared', complianceReasons: [], status: 'awaiting_payment',
    createdAt: new Date().toISOString(), sourceCountry: 'US', sourceCurrency: 'USD',
    destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'default',
    amountSource: 200, feeSource: 0, totalChargeSource: 200, ...o,
  };
}

let repo: ReturnType<typeof createTransferRepo>;

beforeEach(async () => {
  db = await freshDb();
  repo = createTransferRepo(db);
  process.env.FUNDING_WEBHOOK_SECRET_STRIPE = SECRET;
  process.env.FUNDING_WEBHOOK_SECRET_MOCK = MOCK_SECRET;
});

afterEach(() => {
  delete process.env.FUNDING_WEBHOOK_SECRET_STRIPE;
  delete process.env.FUNDING_WEBHOOK_SECRET_MOCK;
});

describe('POST /api/funding-webhook/[provider] — refund lifecycle', () => {
  it('refunded event flips refundStatus pending→completed with ref + timestamp', async () => {
    await repo.saveTransfer(makeTransfer({
      id: 'fw1', status: 'paid', fundingRef: 'fund-fw1', refundStatus: 'pending',
    }));
    const body = JSON.stringify({ transfer_id: 'fw1', event: 'refunded', ref: 'rf-001' });
    const res = await post('mock', body, sig(body, MOCK_SECRET)); // mock is signed like every provider
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });

    const t = await repo.getTransfer('fw1');
    expect(t?.refundStatus).toBe('completed');
    expect(t?.refundRef).toBe('rf-001');
    expect(t?.refundedAt).toBeDefined();
    // Relative-time check (never hardcode dates): stamped just now.
    expect(Math.abs(Date.now() - new Date(t!.refundedAt!).getTime())).toBeLessThan(60_000);
    expect(t?.status).toBe('paid'); // settlement state untouched
  });

  it('refund_failed event flips refundStatus pending→failed', async () => {
    await repo.saveTransfer(makeTransfer({
      id: 'fw2', status: 'paid', fundingRef: 'fund-fw2', refundStatus: 'pending',
    }));
    const body = JSON.stringify({ transfer_id: 'fw2', event: 'refund_failed' });
    const res = await post('mock', body, sig(body, MOCK_SECRET));
    expect(res.status).toBe(200);

    const t = await repo.getTransfer('fw2');
    expect(t?.refundStatus).toBe('failed');
    expect(t?.refundedAt).toBeUndefined();
  });

  it("refunded for a transfer NOT pending → guarded no-op (replays are harmless), still 200", async () => {
    await repo.saveTransfer(makeTransfer({ id: 'fw3', status: 'paid', fundingRef: 'fund-fw3' }));
    const body = JSON.stringify({ transfer_id: 'fw3', event: 'refunded', ref: 'rf-x' });
    const res = await post('mock', body, sig(body, MOCK_SECRET));
    expect(res.status).toBe(200);

    const t = await repo.getTransfer('fw3');
    expect(t?.refundStatus ?? 'none').toBe('none'); // updateRefund's legal-from guard held
    expect(t?.refundRef).toBeUndefined();
  });

  it('mock provider with NO secret configured → 401 and no mutation (fail-closed like every other provider)', async () => {
    delete process.env.FUNDING_WEBHOOK_SECRET_MOCK;
    await repo.saveTransfer(makeTransfer({
      id: 'fw9', status: 'paid', fundingRef: 'fund-fw9', refundStatus: 'pending',
    }));
    const body = JSON.stringify({ transfer_id: 'fw9', event: 'refunded', ref: 'rf-009' });

    expect((await post('mock', body)).status).toBe(401);                 // unsigned
    expect((await post('mock', body, sig(body, ''))).status).toBe(401);  // signed with the empty secret
    expect((await repo.getTransfer('fw9'))?.refundStatus).toBe('pending');
  });
});

describe('POST /api/funding-webhook/[provider] — captured event', () => {
  it('captured sets fundingRef write-once and NEVER touches status', async () => {
    await repo.saveTransfer(makeTransfer({ id: 'fw4' })); // awaiting_payment, no fundingRef
    const body = JSON.stringify({ transfer_id: 'fw4', event: 'captured', ref: 'fund-async-1' });
    expect((await post('mock', body, sig(body, MOCK_SECRET))).status).toBe(200);

    let t = await repo.getTransfer('fw4');
    expect(t?.fundingRef).toBe('fund-async-1');
    expect(t?.status).toBe('awaiting_payment'); // the pay route owns settlement

    // Replay with a DIFFERENT ref → write-once guard keeps the first.
    const replay = JSON.stringify({ transfer_id: 'fw4', event: 'captured', ref: 'fund-async-2' });
    expect((await post('mock', replay, sig(replay, MOCK_SECRET))).status).toBe(200);
    t = await repo.getTransfer('fw4');
    expect(t?.fundingRef).toBe('fund-async-1');
  });
});

describe('POST /api/funding-webhook/[provider] — security posture', () => {
  it('real provider with a BAD signature → 401, nothing changes', async () => {
    await repo.saveTransfer(makeTransfer({
      id: 'fw5', status: 'paid', fundingRef: 'fund-fw5', refundStatus: 'pending',
    }));
    const body = JSON.stringify({ transfer_id: 'fw5', event: 'refunded', ref: 'rf-evil' });
    const res = await post('stripe', body, 'deadbeef');
    expect(res.status).toBe(401);

    const t = await repo.getTransfer('fw5');
    expect(t?.refundStatus).toBe('pending'); // untouched
    expect(t?.refundRef).toBeUndefined();
  });

  it('real provider with NO signature → 401 (fail-closed)', async () => {
    const body = JSON.stringify({ transfer_id: 'fw5', event: 'refunded', ref: 'rf-evil' });
    expect((await post('stripe', body)).status).toBe(401);
  });

  it("unconfigured secret ('' for the provider) → 401 even with a self-consistent signature", async () => {
    delete process.env.FUNDING_WEBHOOK_SECRET_STRIPE;
    const body = JSON.stringify({ transfer_id: 'fw5', event: 'refunded', ref: 'rf-evil' });
    expect((await post('stripe', body, sig(body, ''))).status).toBe(401);
    expect((await post('stripe', body, sig(body, 'guess'))).status).toBe(401);
  });

  it('mock provider WITH a secret: unsigned → 401, signed → processed', async () => {
    // Unlike the payment mock (a no-op handleWebhook), the funding mock ACTS
    // on parsed bodies — only a caller holding the configured secret gets through.
    process.env.FUNDING_WEBHOOK_SECRET_MOCK = 'mock-lock';
    try {
      await repo.saveTransfer(makeTransfer({
        id: 'fw8', status: 'paid', fundingRef: 'fund-fw8', refundStatus: 'pending',
      }));
      const body = JSON.stringify({ transfer_id: 'fw8', event: 'refunded', ref: 'rf-008' });

      expect((await post('mock', body)).status).toBe(401); // unsigned rejected
      expect((await repo.getTransfer('fw8'))?.refundStatus).toBe('pending');

      expect((await post('mock', body, sig(body, 'mock-lock'))).status).toBe(200);
      expect((await repo.getTransfer('fw8'))?.refundStatus).toBe('completed');
    } finally {
      delete process.env.FUNDING_WEBHOOK_SECRET_MOCK;
    }
  });

  it('real provider with a GOOD signature → processed', async () => {
    await repo.saveTransfer(makeTransfer({
      id: 'fw6', status: 'paid', fundingRef: 'fund-fw6', refundStatus: 'pending',
    }));
    const body = JSON.stringify({ transfer_id: 'fw6', event: 'refunded', ref: 'rf-006' });
    const res = await post('stripe', body, sig(body));
    expect(res.status).toBe(200);
    expect((await repo.getTransfer('fw6'))?.refundStatus).toBe('completed');
  });

  it('junk-but-valid JSON (no transfer_id / unknown event) → 200 ignored, no mutation', async () => {
    const junk = JSON.stringify({ hello: 'world' });
    const res = await post('mock', junk, sig(junk, MOCK_SECRET));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ignored: true });

    const unknownEvent = JSON.stringify({ transfer_id: 'fw1', event: 'exploded' });
    const res2 = await post('mock', unknownEvent, sig(unknownEvent, MOCK_SECRET));
    expect(res2.status).toBe(200);
    expect(await res2.json()).toMatchObject({ ok: true, ignored: true });
  });

  it('malformed JSON → 400', async () => {
    expect((await post('mock', '{not json', sig('{not json', MOCK_SECRET))).status).toBe(400);
  });

  it('sends NO WhatsApp messages and writes NO outbox rows (the refund engine owns messaging)', async () => {
    await repo.saveTransfer(makeTransfer({
      id: 'fw7', status: 'paid', fundingRef: 'fund-fw7', refundStatus: 'pending',
    }));
    const body = JSON.stringify({ transfer_id: 'fw7', event: 'refunded', ref: 'rf-007' });
    expect((await post('mock', body, sig(body, MOCK_SECRET))).status).toBe(200);
    const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM outbox`)) as unknown as {
      rows: Array<{ n: number }>;
    };
    expect(rows.rows[0].n).toBe(0);
  });
});

describe('pack 5 (T13a): no mock confirmation or refund on real money', () => {
  type AlertRow = { dedupe_key: string; payload: { message: string } };
  const alerts = async (): Promise<AlertRow[]> =>
    ((await db.execute(sql`SELECT dedupe_key, payload FROM outbox WHERE kind = 'ops.alert' ORDER BY id`)) as unknown as {
      rows: AlertRow[];
    }).rows;
  const signedMock = (b: Record<string, unknown>) => {
    const raw = JSON.stringify(b);
    return post('mock', raw, sig(raw, MOCK_SECRET));
  };
  async function simulatorRail(partnerId: string): Promise<void> {
    await createIntegrationsRepo(db).saveIntegrations(partnerId, {
      kyc: {}, whatsapp: {}, payment: { providerType: 'simulator', credentials: { signingSecret: 's' } },
    });
  }

  beforeEach(async () => {
    await seedPartner(db, 'acme');
    await seedRealMoneyRail(db, 'acme');
  });

  it('captured on a real-money row: 200 { ok: true, ignored: true }, funding_ref stays NULL, ONE fundcapture:<id> alert', async () => {
    await repo.saveTransfer(makeTransfer({ id: 'rm1', partnerId: 'acme' }));
    const res = await signedMock({ transfer_id: 'rm1', event: 'captured', ref: 'fund-x' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    const t = await repo.getTransfer('rm1');
    expect(t?.fundingRef).toBeUndefined();
    expect(t?.fundingProvider).toBeUndefined();
    expect(t?.status).toBe('awaiting_payment');
    let a = await alerts();
    expect(a.map((r) => r.dedupe_key)).toEqual(['fundcapture:rm1']);
    expect(a[0].payload.message).toContain('rm1');
    expect(a[0].payload.message).toContain('acme');
    for (const v of ['15551234567', 'Mom', '919876543210', '123456789', 'fund-x']) expect(a[0].payload.message).not.toContain(v);

    // A replay adds no second alert.
    expect((await signedMock({ transfer_id: 'rm1', event: 'captured', ref: 'fund-y' })).status).toBe(200);
    a = await alerts();
    expect(a).toHaveLength(1);
    expect((await repo.getTransfer('rm1'))?.fundingRef).toBeUndefined();
  });

  it("captured on the same partner's sandbox row ('test') is recorded as today", async () => {
    await repo.saveTransfer(makeTransfer({ id: 'sb1', partnerId: 'acme', environment: 'test' }));
    const res = await signedMock({ transfer_id: 'sb1', event: 'captured', ref: 'fund-sb' });
    expect(await res.json()).toEqual({ ok: true });
    expect((await repo.getTransfer('sb1'))?.fundingRef).toBe('fund-sb');
    expect(await alerts()).toEqual([]);
  });

  it('captured on a simulator row and on a default-tenant row is recorded as today', async () => {
    await seedPartner(db, 'simp');
    await simulatorRail('simp');
    await repo.saveTransfer(makeTransfer({ id: 'si1', partnerId: 'simp' }));
    await repo.saveTransfer(makeTransfer({ id: 'df1' }));
    expect(await (await signedMock({ transfer_id: 'si1', event: 'captured', ref: 'fund-si' })).json()).toEqual({ ok: true });
    expect(await (await signedMock({ transfer_id: 'df1', event: 'captured', ref: 'fund-df' })).json()).toEqual({ ok: true });
    expect((await repo.getTransfer('si1'))?.fundingRef).toBe('fund-si');
    expect((await repo.getTransfer('df1'))?.fundingRef).toBe('fund-df');
    expect(await alerts()).toEqual([]);
  });

  it('a routed row is judged by its settlement rail (owner simulator, settlement partner http -> refused)', async () => {
    await seedPartner(db, 'simp');
    await simulatorRail('simp');
    await repo.saveTransfer(makeTransfer({ id: 'ro1', partnerId: 'simp', settlementPartnerId: 'acme' }));
    expect(await (await signedMock({ transfer_id: 'ro1', event: 'captured', ref: 'fund-ro' })).json()).toEqual({ ok: true, ignored: true });
    expect((await repo.getTransfer('ro1'))?.fundingRef).toBeUndefined();
    expect((await alerts()).map((r) => r.dedupe_key)).toEqual(['fundcapture:ro1']);
  });

  it('refunded on a real-money row: 200 { ok: true, ignored: true }, refund_status stays pending, refund_ref NULL, ONE fundrefund:<id> alert', async () => {
    await repo.saveTransfer(makeTransfer({ id: 'rf1', partnerId: 'acme', status: 'paid', fundingRef: 'fund-rf1', refundStatus: 'pending' }));
    const res = await signedMock({ transfer_id: 'rf1', event: 'refunded', ref: 'rf-001' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    let t = await repo.getTransfer('rf1');
    expect(t?.refundStatus).toBe('pending');
    expect(t?.refundRef).toBeUndefined();
    expect(t?.refundedAt).toBeUndefined();
    let a = await alerts();
    expect(a.map((r) => r.dedupe_key)).toEqual(['fundrefund:rf1']);
    expect(a[0].payload.message).toContain('"refunded"');
    expect(a[0].payload.message).toContain('rf1');
    expect(a[0].payload.message).toContain('acme');
    for (const v of ['15551234567', 'Mom', '919876543210', '123456789', 'rf-001', 'fund-rf1']) expect(a[0].payload.message).not.toContain(v);

    expect((await signedMock({ transfer_id: 'rf1', event: 'refunded', ref: 'rf-002' })).status).toBe(200);
    a = await alerts();
    expect(a).toHaveLength(1);
    t = await repo.getTransfer('rf1');
    expect(t?.refundStatus).toBe('pending');
  });

  it('refund_failed on a real-money row: the same answer, refund_status stays pending, the same fundrefund:<id> dedupe', async () => {
    await repo.saveTransfer(makeTransfer({ id: 'rf2', partnerId: 'acme', status: 'paid', fundingRef: 'fund-rf2', refundStatus: 'pending' }));
    const res = await signedMock({ transfer_id: 'rf2', event: 'refund_failed' });
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect((await repo.getTransfer('rf2'))?.refundStatus).toBe('pending');
    // After a refused 'refunded', a 'refund_failed' for the same row shares the key.
    expect(await (await signedMock({ transfer_id: 'rf2', event: 'refunded' })).json()).toEqual({ ok: true, ignored: true });
    const a = await alerts();
    expect(a.map((r) => r.dedupe_key)).toEqual(['fundrefund:rf2']);
    expect(a[0].payload.message).toContain('"refund_failed"');
    expect((await repo.getTransfer('rf2'))?.refundStatus).toBe('pending');
  });

  it('refunded and refund_failed on a simulator row and a sandbox row are recorded as today', async () => {
    await seedPartner(db, 'simp');
    await simulatorRail('simp');
    await repo.saveTransfer(makeTransfer({ id: 'sr1', partnerId: 'simp', status: 'paid', fundingRef: 'f', refundStatus: 'pending' }));
    await repo.saveTransfer(makeTransfer({ id: 'sr2', partnerId: 'simp', status: 'paid', fundingRef: 'f', refundStatus: 'pending' }));
    await repo.saveTransfer(makeTransfer({ id: 'sb2', partnerId: 'acme', environment: 'test', status: 'paid', fundingRef: 'f', refundStatus: 'pending' }));
    await repo.saveTransfer(makeTransfer({ id: 'sb3', partnerId: 'acme', environment: 'test', status: 'paid', fundingRef: 'f', refundStatus: 'pending' }));
    expect(await (await signedMock({ transfer_id: 'sr1', event: 'refunded', ref: 'r-sr1' })).json()).toEqual({ ok: true });
    expect(await (await signedMock({ transfer_id: 'sr2', event: 'refund_failed' })).json()).toEqual({ ok: true });
    expect(await (await signedMock({ transfer_id: 'sb2', event: 'refunded', ref: 'r-sb2' })).json()).toEqual({ ok: true });
    expect(await (await signedMock({ transfer_id: 'sb3', event: 'refund_failed' })).json()).toEqual({ ok: true });
    expect(await repo.getTransfer('sr1')).toMatchObject({ refundStatus: 'completed', refundRef: 'r-sr1' });
    expect((await repo.getTransfer('sr2'))?.refundStatus).toBe('failed');
    expect(await repo.getTransfer('sb2')).toMatchObject({ refundStatus: 'completed', refundRef: 'r-sb2' });
    expect((await repo.getTransfer('sb3'))?.refundStatus).toBe('failed');
    expect(await alerts()).toEqual([]);
  });

  it('refunded with no ref completes with refund-webhook-<id>, never mockfund-', async () => {
    await seedPartner(db, 'simp');
    await simulatorRail('simp');
    await repo.saveTransfer(makeTransfer({ id: 'nr1', partnerId: 'simp', status: 'paid', fundingRef: 'f', refundStatus: 'pending' }));
    expect(await (await signedMock({ transfer_id: 'nr1', event: 'refunded' })).json()).toEqual({ ok: true });
    const t = await repo.getTransfer('nr1');
    expect(t).toMatchObject({ refundStatus: 'completed', refundRef: 'refund-webhook-nr1' });
    expect(t?.refundRef).not.toMatch(/^mockfund-/);
  });
});
