/**
 * Integration tests for the pay route's complianceStatus branching.
 * We test at the lib level (not via HTTP) to verify the observable side-effects
 * (store state) of what the route does for flagged/cleared transfers.
 */
import { describe, it, expect, vi } from 'vitest';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import type { Transfer } from '@/lib/types';

// Mock next/server after() to be a no-op (prevents stage-2 from running in tests)
vi.mock('next/server', () => ({
  after: vi.fn(),
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }),
  },
}));

vi.mock('@/lib/whatsapp', () => ({
  sendText: vi.fn().mockResolvedValue(undefined),
  sendTemplate: vi.fn().mockResolvedValue(undefined),
  RECIPIENT_TEMPLATE_NAME: 'transfer_delivered',
  RECIPIENT_TEMPLATE_LANG: 'en',
}));

import { buildStage1Message, completePaymentStage1 } from '@/lib/payment';
import { sql } from 'drizzle-orm';
import { beginHold } from '@/lib/settlement';
import { sendText } from '@/lib/whatsapp';

function makeTransfer(overrides: Partial<Transfer> & { id: string }): Transfer {
  return {
    phone: '15551234567',
    amountUsd: 200,
    feeUsd: 0,
    totalChargeUsd: 200,
    fxRate: 85,
    amountInr: 17000,
    recipientName: 'Mom',
    recipientPhone: '919876543210',
    payoutMethod: 'upi',
    payoutDestination: 'mom@upi',
    fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared',
    complianceReasons: [],
    status: 'awaiting_payment',
    createdAt: '2026-05-30T00:00:00Z',
    sourceCountry: 'US',
    sourceCurrency: 'USD',
    destinationCountry: 'IN',
    destinationCurrency: 'INR',
    partnerId: 'default',
    amountSource: 200,
    feeSource: 0,
    totalChargeSource: 200,
    ...overrides,
  };
}

describe('pay route logic: flagged transfer → in_review', () => {
  it('flagged: the hold is ONE atomic transition — no intermediate paid state is ever observable, the held message is an outbox row', async () => {
    const db = await freshDb();
    const store = createStore(fakeRedis(), db);
    const t = makeTransfer({ id: 'f1', complianceStatus: 'flagged', complianceReasons: ['Large transfer amount.'] });
    await store.saveTransfer(t);

    // What the route does for flagged now: ONE transaction via beginHold.
    const r = await beginHold(db, t);
    expect(r).toEqual({ kind: 'held' });

    const final = await store.getTransfer('f1');
    expect(final?.status).toBe('in_review');
    expect(final?.paidAt).toBeTruthy(); // the >24h stale-review sweep keys on it
    // No direct send — the held message is durable (dedupe stage1:<id>), and
    // there is no rail effect of any kind.
    expect(sendText).not.toHaveBeenCalled();
    const rows = (await db.execute(sql`SELECT kind, dedupe_key, payload->>'body' AS body FROM outbox ORDER BY id`)) as unknown as {
      rows: Array<{ kind: string; dedupe_key: string; body: string }>;
    };
    expect(rows.rows.map((x) => [x.kind, x.dedupe_key])).toEqual([['whatsapp.text', 'stage1:f1']]);
    expect(rows.rows[0].body).toContain('quick review');
    expect(rows.rows[0].body).not.toContain('within ~10 minutes');
  });

  it('flagged: the held message does NOT promise delivery time', async () => {
    const store = createStore(fakeRedis(), await freshDb());
    const t = makeTransfer({ id: 'f2', complianceStatus: 'flagged' });
    await store.saveTransfer(t);

    // Program-Fix 14: the legacy stage-1 helper no longer marks a flagged
    // (not cleared) transfer paid, so it sends nothing; the held wording is the
    // one beginHold enqueues (pinned above) — built by buildStage1Message.
    const legacy = await completePaymentStage1(store, 'f2', { held: true });
    expect(legacy.senderMessages).toEqual([]);
    expect(legacy.transfer.status).toBe('awaiting_payment');
    const held = buildStage1Message(t, { held: true });
    expect(held).not.toContain('will get');
    expect(held).toContain('Transfer ID: f2');
  });

  it('cleared: completePaymentStage1 (normal) sends delivery-time message', async () => {
    const store = createStore(fakeRedis(), await freshDb());
    const t = makeTransfer({ id: 'c1', complianceStatus: 'cleared' });
    await store.saveTransfer(t);

    const { senderMessages } = await completePaymentStage1(store, 'c1');
    expect(senderMessages[0]).toContain('within ~10 minutes');
    expect(senderMessages[0]).toContain('will get');
  });
});
