/**
 * W1 — /api/funding-webhook/[provider]: the funding provider's async callback
 * (captures/refunds confirmed out-of-band). Mirrors payment-webhook's posture:
 * per-IP limit fail-open, HMAC over the RAW body FAIL-CLOSED for any provider
 * !== 'mock' (secret via FUNDING_WEBHOOK_SECRET_<PROVIDER>, '' ⇒ reject),
 * unknown/junk ⇒ 200 ignored. The route only mirrors funding state:
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
import { freshDb } from './helpers-db';
import type { Transfer } from '@/lib/types';

let db: Awaited<ReturnType<typeof freshDb>>;
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => db };
});

// Stage 3 posture: the per-IP limiter would dial Upstash — always allow here.
vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));

import { POST } from '@/app/api/funding-webhook/[provider]/route';

const SECRET = 'stripe-funding-secret';
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
});

afterEach(() => {
  delete process.env.FUNDING_WEBHOOK_SECRET_STRIPE;
});

describe('POST /api/funding-webhook/[provider] — refund lifecycle', () => {
  it('refunded event flips refundStatus pending→completed with ref + timestamp', async () => {
    await repo.saveTransfer(makeTransfer({
      id: 'fw1', status: 'paid', fundingRef: 'fund-fw1', refundStatus: 'pending',
    }));
    const body = JSON.stringify({ transfer_id: 'fw1', event: 'refunded', ref: 'rf-001' });
    const res = await post('mock', body); // mock carve-out: no signature required
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
    const res = await post('mock', body);
    expect(res.status).toBe(200);

    const t = await repo.getTransfer('fw2');
    expect(t?.refundStatus).toBe('failed');
    expect(t?.refundedAt).toBeUndefined();
  });

  it("refunded for a transfer NOT pending → guarded no-op (replays are harmless), still 200", async () => {
    await repo.saveTransfer(makeTransfer({ id: 'fw3', status: 'paid', fundingRef: 'fund-fw3' }));
    const body = JSON.stringify({ transfer_id: 'fw3', event: 'refunded', ref: 'rf-x' });
    const res = await post('mock', body);
    expect(res.status).toBe(200);

    const t = await repo.getTransfer('fw3');
    expect(t?.refundStatus ?? 'none').toBe('none'); // updateRefund's legal-from guard held
    expect(t?.refundRef).toBeUndefined();
  });
});

describe('POST /api/funding-webhook/[provider] — captured event', () => {
  it('captured sets fundingRef write-once and NEVER touches status', async () => {
    await repo.saveTransfer(makeTransfer({ id: 'fw4' })); // awaiting_payment, no fundingRef
    const body = JSON.stringify({ transfer_id: 'fw4', event: 'captured', ref: 'fund-async-1' });
    expect((await post('mock', body)).status).toBe(200);

    let t = await repo.getTransfer('fw4');
    expect(t?.fundingRef).toBe('fund-async-1');
    expect(t?.status).toBe('awaiting_payment'); // the pay route owns settlement

    // Replay with a DIFFERENT ref → write-once guard keeps the first.
    const replay = JSON.stringify({ transfer_id: 'fw4', event: 'captured', ref: 'fund-async-2' });
    expect((await post('mock', replay)).status).toBe(200);
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

  it("mock carve-out closes when FUNDING_WEBHOOK_SECRET_MOCK is set: unsigned → 401, signed → processed", async () => {
    // Unlike the payment mock (a no-op handleWebhook), the funding mock ACTS
    // on parsed bodies — so prod can lock /mock by configuring its secret.
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
    const res = await post('mock', JSON.stringify({ hello: 'world' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ignored: true });

    const res2 = await post('mock', JSON.stringify({ transfer_id: 'fw1', event: 'exploded' }));
    expect(res2.status).toBe(200);
    expect(await res2.json()).toMatchObject({ ok: true, ignored: true });
  });

  it('malformed JSON → 400', async () => {
    expect((await post('mock', '{not json')).status).toBe(400);
  });

  it('sends NO WhatsApp messages and writes NO outbox rows (the refund engine owns messaging)', async () => {
    await repo.saveTransfer(makeTransfer({
      id: 'fw7', status: 'paid', fundingRef: 'fund-fw7', refundStatus: 'pending',
    }));
    const body = JSON.stringify({ transfer_id: 'fw7', event: 'refunded', ref: 'rf-007' });
    expect((await post('mock', body)).status).toBe(200);
    const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM outbox`)) as unknown as {
      rows: Array<{ n: number }>;
    };
    expect(rows.rows[0].n).toBe(0);
  });
});
