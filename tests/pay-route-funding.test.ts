/**
 * W1 — funds capture in the pay route. THE ORDER IS THE INVARIANT:
 * OTP → payout validation → compliance → capture() → setFundingRef → any
 * stage-1 "payment received" message / beginSettlement. Nothing may message
 * the customer or flip status before the charge succeeds; a capture failure
 * is a clean 402 with NOTHING mutated (the customer retries the same link);
 * blocked transfers are NEVER charged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import type { Transfer } from '@/lib/types';

// Swallow after() (poke fast paths) — this suite is about capture ordering,
// not worker pokes. vi.hoisted so the box exists before the mock factory.
const captured = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => unknown>,
  /** Interleaving record: 'capture' | 'sendText' | 'settle' in call order. */
  order: [] as string[],
}));
vi.mock('next/server', async (orig) => {
  const real = await orig<typeof import('next/server')>();
  return {
    ...real,
    after: (cb: () => unknown) => {
      captured.afterCallbacks.push(cb);
    },
  };
});

const sendText = vi.hoisted(() =>
  vi.fn(async (..._a: unknown[]) => {
    captured.order.push('sendText');
  }),
);
vi.mock('@/lib/whatsapp', () => ({
  sendText: (...a: unknown[]) => sendText(...a),
  sendTransactionOtp: vi.fn().mockResolvedValue(undefined),
  sendTemplate: vi.fn().mockResolvedValue(undefined),
  RECIPIENT_TEMPLATE_NAME: 'transfer_delivered',
  RECIPIENT_TEMPLATE_LANG: 'en',
}));

// OTP always passes; no draft (phone resolves from the existing transfer).
vi.mock('@/lib/transaction-otp', () => ({
  getTransactionOtpStore: () => ({
    issue: async () => ({ ok: true, code: '000000' }),
    verify: async () => ({ ok: true }),
  }),
}));
vi.mock('@/lib/draft-store', () => ({ getDraftStore: () => ({ getDraft: async () => null }) }));

let db: Awaited<ReturnType<typeof freshDb>>;
let store: ReturnType<typeof createStore>;
let customerStore: ReturnType<typeof createCustomerStore>;
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => db };
});
vi.mock('@/lib/store', async (orig) => {
  const real = await orig<typeof import('@/lib/store')>();
  return { ...real, getStore: () => store };
});
vi.mock('@/lib/customer-store', async (orig) => {
  const real = await orig<typeof import('@/lib/customer-store')>();
  return { ...real, getCustomerStore: () => customerStore };
});

vi.mock('@/lib/partner-store', () => ({
  getPartnerStore: () => ({
    getPartner: async () => null,
    ensureDefaultPartner: async () => ({
      id: 'default', name: 'SmartRemit Default', countries: ['US'], status: 'active',
      requireKycBeforeSend: true,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    }),
  }),
}));

vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({
    getIntegrations: async () => ({ kyc: {}, payment: {}, whatsapp: {} }), // mock rail
  }),
}));

vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));

// The funding seam under test: a controllable capture spy. It also snapshots
// the ledger state AT CALL TIME so ordering is provable, not inferred.
const capture = vi.hoisted(() => vi.fn());
vi.mock('@/lib/providers/funding-provider', async (orig) => {
  const real = await orig<typeof import('@/lib/providers/funding-provider')>();
  return {
    ...real,
    getFundingProvider: () => ({
      capture: (...a: unknown[]) => {
        captured.order.push('capture');
        return capture(...a);
      },
      refund: vi.fn(),
      handleWebhook: vi.fn(),
    }),
  };
});

// Wrap beginSettlement to observe what the LEDGER says at the moment
// settlement starts — the fundingRef must already be durable by then.
const observed = vi.hoisted(() => ({ fundingRefAtSettle: undefined as string | undefined,
  statusAtSettle: undefined as string | undefined }));
vi.mock('@/lib/settlement', async (orig) => {
  const real = await orig<typeof import('@/lib/settlement')>();
  return {
    ...real,
    beginSettlement: async (...args: Parameters<typeof real.beginSettlement>) => {
      captured.order.push('settle');
      const t = await store.getTransfer(args[1].id);
      observed.fundingRefAtSettle = t?.fundingRef;
      observed.statusAtSettle = t?.status;
      return real.beginSettlement(...args);
    },
  };
});

import { POST } from '@/app/api/pay/[transferId]/route';

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

function post(id: string) {
  // Bodyless POST — destination already set; the OTP gate is stubbed open.
  const req = new NextRequest('http://localhost/api/pay/' + id, { method: 'POST' });
  return POST(req, { params: Promise.resolve({ transferId: id }) });
}

const outboxCount = async () => {
  const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM outbox`)) as unknown as {
    rows: Array<{ n: number }>;
  };
  return rows.rows[0].n;
};

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  customerStore = createCustomerStore(db, store);
  const nowIso = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: '15551234567', firstSeenAt: nowIso, kycStatus: 'verified',
    senderCountry: 'US', partnerId: 'default', optInAt: nowIso,
    createdAt: nowIso, updatedAt: nowIso,
  });
  captured.afterCallbacks.length = 0;
  captured.order.length = 0;
  observed.fundingRefAtSettle = undefined;
  observed.statusAtSettle = undefined;
  sendText.mockClear();
  capture.mockReset();
  capture.mockResolvedValue({ fundingRef: 'fund-abc' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pay route — funds capture ordering (cleared branch)', () => {
  it('happy pay: capture runs, fundingRef is durable BEFORE the paid flip, settlement proceeds', async () => {
    await store.saveTransfer(makeTransfer({ id: 'f1' }));
    const res = await post('f1');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: 'paid' });

    // capture ran exactly once, against this transfer, while it was still unflipped.
    expect(capture).toHaveBeenCalledTimes(1);
    expect((capture.mock.calls[0][0] as Transfer).id).toBe('f1');

    // The invariant: at the moment beginSettlement ran, the fundingRef was
    // already persisted and the transfer had NOT flipped yet.
    expect(captured.order.indexOf('capture')).toBeLessThan(captured.order.indexOf('settle'));
    expect(observed.fundingRefAtSettle).toBe('fund-abc');
    expect(observed.statusAtSettle).toBe('awaiting_payment');

    const after = await store.getTransfer('f1');
    expect(after?.status).toBe('paid');
    expect(after?.fundingRef).toBe('fund-abc');

    // Settlement effects committed (stage-1 message + mock rail effect).
    const rows = (await db.execute(
      sql`SELECT kind FROM outbox ORDER BY id`,
    )) as unknown as { rows: Array<{ kind: string }> };
    expect(rows.rows.map((r) => r.kind)).toContain('whatsapp.text');
    expect(rows.rows.length).toBeGreaterThanOrEqual(2);
  });

  it('capture throw → 402 payment_failed; NOTHING mutated (retryable link)', async () => {
    capture.mockRejectedValue(new Error('card declined'));
    await store.saveTransfer(makeTransfer({ id: 'f2' }));
    const res = await post('f2');
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ ok: false, error: 'payment_failed' });

    const after = await store.getTransfer('f2');
    expect(after?.status).toBe('awaiting_payment'); // unflipped
    expect(after?.fundingRef).toBeUndefined();      // no charge recorded
    expect(await outboxCount()).toBe(0);            // no message, no rail effect
    expect(sendText).not.toHaveBeenCalled();

    // The link still works: a retry with a now-working card completes the pay.
    capture.mockResolvedValue({ fundingRef: 'fund-retry' });
    const retry = await post('f2');
    expect(retry.status).toBe(200);
    expect((await store.getTransfer('f2'))?.status).toBe('paid');
    expect((await store.getTransfer('f2'))?.fundingRef).toBe('fund-retry');
  });

  it('blocked compliance → 400 and capture is NEVER called (blocked transfers are never charged)', async () => {
    await store.saveTransfer(makeTransfer({ id: 'f3', complianceStatus: 'blocked' }));
    const res = await post('f3');
    expect(res.status).toBe(400);
    expect(capture).not.toHaveBeenCalled();
    expect((await store.getTransfer('f3'))?.fundingRef).toBeUndefined();
  });

  it('routed-rail fail-closed 400 fires BEFORE capture (never charge into a dead instruct)', async () => {
    // settlementPartnerId set but the rail resolves to the mock default — the
    // PR #94 guard refuses; the refusal must keep preceding any charge.
    await db.execute(sql`INSERT INTO partners (id, name, status, countries, kyc_mode)
      VALUES ('railp', 'railp', 'active', '["US"]'::jsonb, 'ours') ON CONFLICT (id) DO NOTHING`);
    await store.saveTransfer(makeTransfer({ id: 'f4', settlementPartnerId: 'railp' }));
    const res = await post('f4');
    expect(res.status).toBe(400);
    expect(capture).not.toHaveBeenCalled();
    expect((await store.getTransfer('f4'))?.status).toBe('awaiting_payment');
  });
});

describe('pay route — funds capture ordering (flagged/held branch)', () => {
  it('flagged transfer: capture runs BEFORE the held message; ends in_review with fundingRef', async () => {
    await store.saveTransfer(makeTransfer({ id: 'f5', complianceStatus: 'flagged' }));
    const res = await post('f5');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: 'in_review' });

    expect(capture).toHaveBeenCalledTimes(1);
    // The held "payment received" message went out AFTER the charge succeeded.
    expect(captured.order.indexOf('capture')).toBeLessThan(captured.order.indexOf('sendText'));

    const after = await store.getTransfer('f5');
    expect(after?.status).toBe('in_review');
    expect(after?.fundingRef).toBe('fund-abc');
  });

  it('flagged + capture throw → 402; still awaiting_payment; NO held message sent', async () => {
    capture.mockRejectedValue(new Error('card declined'));
    await store.saveTransfer(makeTransfer({ id: 'f6', complianceStatus: 'flagged' }));
    const res = await post('f6');
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ ok: false, error: 'payment_failed' });

    const after = await store.getTransfer('f6');
    expect(after?.status).toBe('awaiting_payment');
    expect(after?.fundingRef).toBeUndefined();
    expect(sendText).not.toHaveBeenCalled();
  });
});
