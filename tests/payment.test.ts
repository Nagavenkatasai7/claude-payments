import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildRefundMessage,
  completePaymentStage1,
  completePaymentStage2,
  recipientTemplateParams,
  recipientDeliveredFallbackText,
} from '@/lib/payment';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});

function awaitingTransfer(): Transfer {
  return {
    id: 'pay12345',
    phone: '15551234567',
    amountUsd: 500,
    feeUsd: 0,
    totalChargeUsd: 500,
    fxRate: 85.2,
    amountInr: 42600,
    recipientName: 'Mom',
    recipientPhone: '919876543210',
    payoutMethod: 'upi',
    payoutDestination: 'mom@upi',
    fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared',
    complianceReasons: [],
    status: 'awaiting_payment',
    createdAt: '2026-05-21T00:00:00.000Z',
    sourceCountry: 'US',
    sourceCurrency: 'USD',
    destinationCountry: 'IN',
    destinationCurrency: 'INR',
    partnerId: 'default',
    amountSource: 500,
    feeSource: 0,
    totalChargeSource: 500,
  };
}

function awaitingAedTransfer(): Transfer {
  return {
    id: 'pay99999',
    phone: '15557654321',
    amountUsd: 300,
    feeUsd: 5,
    totalChargeUsd: 305,
    fxRate: 3.67,
    amountInr: 1101,  // amountInr = destination amount (AED)
    recipientName: 'Ali',
    recipientPhone: '971501234567',
    payoutMethod: 'bank',
    payoutDestination: 'AE12345678901234567890',
    fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared',
    complianceReasons: [],
    status: 'awaiting_payment',
    createdAt: '2026-05-21T00:00:00.000Z',
    sourceCountry: 'US',
    sourceCurrency: 'USD',
    destinationCountry: 'AE',
    destinationCurrency: 'AED',
    partnerId: 'default',
    amountSource: 300,
    feeSource: 5,
    totalChargeSource: 305,
  };
}

describe('completePaymentStage1', () => {
  it('sets status to paid and paidAt, returns sender messages (INR → ₹)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(awaitingTransfer());

    const result = await completePaymentStage1(store, 'pay12345');

    expect(result.transfer.status).toBe('paid');
    expect(result.transfer.paidAt).toBeTruthy();
    expect(result.transfer.deliveredAt).toBeUndefined();

    expect(result.senderMessages).toHaveLength(1);
    // Source charge in USD
    expect(result.senderMessages[0]).toContain('$500.00');
    // Destination amount in INR — Intl formats as ₹42,600
    expect(result.senderMessages[0]).toContain('₹');
    expect(result.senderMessages[0]).toContain('42,600');
    expect(result.senderMessages[0]).toContain('Mom');
    expect(result.senderMessages[0]).toContain('Transfer ID: pay12345');
    expect(result.senderMessages[0]).not.toContain('…'); // no trailing ellipsis
    expect(result.senderMessages[0]).toContain('within ~10 minutes');
  });

  it('formats non-INR destination currency correctly (AED)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(awaitingAedTransfer());

    const result = await completePaymentStage1(store, 'pay99999');

    expect(result.senderMessages).toHaveLength(1);
    // Source charge in USD
    expect(result.senderMessages[0]).toContain('$305.00');
    // Destination amount in AED — Intl renders "AED" prefix
    expect(result.senderMessages[0]).toContain('AED');
    expect(result.senderMessages[0]).toContain('1,101');
    expect(result.senderMessages[0]).toContain('Ali');
    expect(result.senderMessages[0]).toContain('Transfer ID: pay99999');
    expect(result.senderMessages[0]).toContain('within ~10 minutes');
  });

  it('is idempotent — if already paid, returns empty message arrays', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(awaitingTransfer());
    await completePaymentStage1(store, 'pay12345');

    const second = await completePaymentStage1(store, 'pay12345');
    expect(second.transfer.status).toBe('paid');
    expect(second.senderMessages).toHaveLength(0);
  });

  it('is idempotent — if already delivered, returns empty message arrays', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer({ ...awaitingTransfer(), status: 'delivered' });

    const result = await completePaymentStage1(store, 'pay12345');
    expect(result.transfer.status).toBe('delivered');
    expect(result.senderMessages).toHaveLength(0);
  });

  it('throws for a missing transfer', async () => {
    const store = createStore(fakeRedis(), db);
    await expect(completePaymentStage1(store, 'missing')).rejects.toThrow(
      /not found/i,
    );
  });
});

describe('completePaymentStage1 — held=true (flagged transfer)', () => {
  it('sends a held message (no delivery ETA) when held=true', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(awaitingTransfer());

    const result = await completePaymentStage1(store, 'pay12345', { held: true });

    expect(result.transfer.status).toBe('paid');
    expect(result.senderMessages).toHaveLength(1);
    // Must contain the charge amount
    expect(result.senderMessages[0]).toContain('$500.00');
    // Must NOT promise delivery time
    expect(result.senderMessages[0]).not.toContain('within ~10 minutes');
    expect(result.senderMessages[0]).not.toContain('will get');
    // Must contain the review/hold message
    expect(result.senderMessages[0]).toContain('quick review');
    expect(result.senderMessages[0]).toContain('Transfer ID: pay12345');
  });

  it('held=false (default) still sends the normal message', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(awaitingTransfer());

    const result = await completePaymentStage1(store, 'pay12345');

    expect(result.senderMessages[0]).toContain('within ~10 minutes');
    expect(result.senderMessages[0]).not.toContain('quick review');
  });
});

describe('completePaymentStage2', () => {
  it('sets status to delivered and deliveredAt, returns sender messages (INR → ₹)', async () => {
    const store = createStore(fakeRedis(), db);
    // Pre-seed a paid transfer
    await store.saveTransfer({
      ...awaitingTransfer(),
      status: 'paid',
      paidAt: '2026-05-21T01:00:00.000Z',
    });

    const result = await completePaymentStage2(store, 'pay12345');

    expect(result.transfer.status).toBe('delivered');
    expect(result.transfer.deliveredAt).toBeTruthy();
    expect(result.transfer.paidAt).toBeTruthy();

    expect(result.senderMessages).toHaveLength(1);
    // Destination amount in INR — Intl formats as ₹42,600
    expect(result.senderMessages[0]).toContain('₹');
    expect(result.senderMessages[0]).toContain('42,600');
    expect(result.senderMessages[0]).toContain('Mom');
    // Always "via bank transfer" regardless of payoutMethod
    expect(result.senderMessages[0]).toContain('via bank transfer');
    expect(result.senderMessages[0]).toContain('Transfer ID: pay12345');
  });

  it('always uses "via bank transfer" label (payout method is irrelevant for message)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer({
      ...awaitingTransfer(),
      payoutMethod: 'bank',
      status: 'paid',
      paidAt: '2026-05-21T01:00:00.000Z',
    });

    const result = await completePaymentStage2(store, 'pay12345');
    expect(result.senderMessages[0]).toContain('via bank transfer');
    // Must not mention UPI
    expect(result.senderMessages[0]).not.toContain('UPI');
  });

  it('formats non-INR destination currency correctly (AED) in stage-2 message', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer({
      ...awaitingAedTransfer(),
      status: 'paid',
      paidAt: '2026-05-21T01:00:00.000Z',
    });

    const result = await completePaymentStage2(store, 'pay99999');

    expect(result.senderMessages).toHaveLength(1);
    expect(result.senderMessages[0]).toContain('AED');
    expect(result.senderMessages[0]).toContain('1,101');
    expect(result.senderMessages[0]).toContain('Ali');
    expect(result.senderMessages[0]).toContain('via bank transfer');
    expect(result.senderMessages[0]).toContain('Transfer ID: pay99999');
  });

  it('is idempotent — if already delivered, returns empty message arrays', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer({
      ...awaitingTransfer(),
      status: 'delivered',
      paidAt: '2026-05-21T01:00:00.000Z',
      deliveredAt: '2026-05-21T01:02:00.000Z',
    });

    const result = await completePaymentStage2(store, 'pay12345');
    expect(result.transfer.status).toBe('delivered');
    expect(result.senderMessages).toHaveLength(0);
  });

  it('does NOT deliver a cancelled transfer — returns empty messages', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer({
      ...awaitingTransfer(),
      status: 'cancelled',
    });

    const result = await completePaymentStage2(store, 'pay12345');
    expect(result.transfer.status).toBe('cancelled');
    expect(result.senderMessages).toHaveLength(0);
  });

  it('sets paidAt if somehow unset when delivering', async () => {
    const store = createStore(fakeRedis(), db);
    // Transfer is awaiting_payment (no paidAt)
    await store.saveTransfer(awaitingTransfer());

    const result = await completePaymentStage2(store, 'pay12345');
    expect(result.transfer.status).toBe('delivered');
    expect(result.transfer.paidAt).toBeTruthy();
    expect(result.transfer.deliveredAt).toBeTruthy();
  });

  it('throws for a missing transfer', async () => {
    const store = createStore(fakeRedis(), db);
    await expect(completePaymentStage2(store, 'missing')).rejects.toThrow(
      /not found/i,
    );
  });
});

describe('buildRefundMessage', () => {
  it('refunds the SOURCE-currency charge and names the transfer id', () => {
    const msg = buildRefundMessage(awaitingTransfer());
    expect(msg).toContain('pay12345');
    expect(msg).toContain('$500.00'); // totalChargeSource in USD
    expect(msg).toContain('refunded');
    expect(msg).toContain('original payment method');
    expect(msg).toContain('3-5 business days');
  });

  it('falls back to totalChargeUsd when totalChargeSource is absent (legacy row)', () => {
    const t = {
      ...awaitingTransfer(),
      totalChargeSource: undefined as unknown as number,
    };
    const msg = buildRefundMessage(t);
    expect(msg).toContain('$500.00');
  });

  it('formats a non-USD source charge in the source currency', () => {
    const t = {
      ...awaitingTransfer(),
      sourceCurrency: 'GBP' as import('@/lib/types').CurrencyCode,
      totalChargeSource: 410.5,
    };
    const msg = buildRefundMessage(t);
    expect(msg).toContain('£410.50');
  });

  it('NEVER mentions compliance or review reasons', () => {
    const t = {
      ...awaitingTransfer(),
      complianceStatus: 'blocked' as const,
      complianceReasons: ['Recipient name matches watchlist.'],
    };
    const msg = buildRefundMessage(t).toLowerCase();
    expect(msg).not.toContain('compliance');
    expect(msg).not.toContain('review');
    expect(msg).not.toContain('watchlist');
    expect(msg).not.toContain('sanction');
  });
});

describe('recipientTemplateParams', () => {
  it('returns 4 params in order for an INR transfer (₹ via Intl)', () => {
    const transfer = awaitingTransfer();
    const params = recipientTemplateParams(transfer);

    expect(params).toHaveLength(4);
    expect(params[0]).toBe('Mom'); // recipient name
    // Intl formats INR with ₹ symbol
    expect(params[1]).toContain('₹');
    expect(params[1]).toContain('42,600');
    expect(params[2]).toBe('+15551234567'); // sender phone with +
    expect(params[3]).toBe('bank account'); // always "bank account"
  });

  it('always returns "bank account" regardless of payoutMethod', () => {
    const transfer = { ...awaitingTransfer(), payoutMethod: 'upi' as const };
    const params = recipientTemplateParams(transfer);

    expect(params).toHaveLength(4);
    expect(params[3]).toBe('bank account');
  });

  it('formats AED destination amount using Intl', () => {
    const transfer = awaitingAedTransfer();
    const params = recipientTemplateParams(transfer);

    expect(params).toHaveLength(4);
    expect(params[0]).toBe('Ali');
    expect(params[1]).toContain('AED');
    expect(params[1]).toContain('1,101');
    expect(params[2]).toBe('+15557654321');
    expect(params[3]).toBe('bank account');
  });

  it('defaults to INR when destinationCurrency is absent (legacy record)', () => {
    const transfer = {
      ...awaitingTransfer(),
      destinationCurrency: undefined as unknown as import('@/lib/types').CurrencyCode,
      amountInr: 100000,
    };
    const params = recipientTemplateParams(transfer);
    // Should still render ₹ (INR default)
    expect(params[1]).toContain('₹');
  });
});

describe('recipientDeliveredFallbackText', () => {
  it('names the recipient, the dest amount, the sender, and the brand', () => {
    const text = recipientDeliveredFallbackText(awaitingTransfer(), 'Acme Remit');
    expect(text).toContain('Mom');            // recipient name
    expect(text).toContain('₹');              // dest amount in INR
    expect(text).toContain('42,600');
    expect(text).toContain('+15551234567');   // sender phone
    expect(text).toContain('Acme Remit');     // brand
  });

  it('defaults the brand to SmartRemit when omitted', () => {
    expect(recipientDeliveredFallbackText(awaitingTransfer())).toContain('SmartRemit');
  });

  it('uses the destination currency (AED) for the amount', () => {
    const text = recipientDeliveredFallbackText(awaitingAedTransfer());
    expect(text).toContain('AED');
    expect(text).toContain('Ali');
  });
});
