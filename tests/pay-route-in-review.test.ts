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

import { completePaymentStage1 } from '@/lib/payment';

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
  it('flagged: completePaymentStage1(held=true) sets status=paid; route then saves in_review', async () => {
    const store = createStore(fakeRedis(), await freshDb());
    const t = makeTransfer({ id: 'f1', complianceStatus: 'flagged', complianceReasons: ['Large transfer amount.'] });
    await store.saveTransfer(t);

    // Simulate what the route does for flagged:
    const { transfer: paid, senderMessages } = await completePaymentStage1(store, 'f1', { held: true });
    // Route then saves in_review:
    const held = await store.getTransfer('f1');
    await store.saveTransfer({ ...held!, status: 'in_review' });

    const final = await store.getTransfer('f1');
    expect(paid.status).toBe('paid');
    expect(final?.status).toBe('in_review');
    expect(senderMessages[0]).toContain('quick review');
    expect(senderMessages[0]).not.toContain('within ~10 minutes');
  });

  it('flagged: the held message does NOT promise delivery time', async () => {
    const store = createStore(fakeRedis(), await freshDb());
    const t = makeTransfer({ id: 'f2', complianceStatus: 'flagged' });
    await store.saveTransfer(t);

    const { senderMessages } = await completePaymentStage1(store, 'f2', { held: true });
    expect(senderMessages[0]).not.toContain('will get');
    expect(senderMessages[0]).toContain('Transfer ID: f2');
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
