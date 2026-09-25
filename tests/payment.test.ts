import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildRailFailureMessage,
  buildRefundMessage,
  buildStage1Message,
  completePaymentStage1,
  completePaymentStage2,
  recipientTemplateParams,
  recipientDeliveredFallbackText,
  recipientDisplayName,
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

describe('buildStage1Message — B2B / ACH-pull wording', () => {
  // A B2B transfer: business sender debited via ACH pull, business recipient.
  function b2bTransfer(): Transfer {
    return {
      ...awaitingTransfer(),
      id: 'payb2b01',
      transferType: 'b2b',
      fundingMethod: 'ach_pull',
      senderEntityType: 'business',
      recipientEntityType: 'business',
      senderBusinessName: 'Acme Imports LLC',
      recipientBusinessName: 'Mumbai Textiles Pvt Ltd',
    };
  }

  it('b2c wording is unchanged (byte-identical) — control', () => {
    const msg = buildStage1Message(awaitingTransfer());
    expect(msg).toBe(
      '✅ Payment received — $500.00 charged. Mom will get ₹42,600 within ~10 minutes. Transfer ID: pay12345',
    );
  });

  it('B2B uses "debited from your business account" instead of "charged"', () => {
    const msg = buildStage1Message(b2bTransfer());
    expect(msg).toContain('will be debited from your business account');
    expect(msg).not.toContain(' charged.');
    expect(msg).toContain('$500.00');
    expect(msg).toContain('Transfer ID: payb2b01');
  });

  it('B2B names the recipient business and uses "will receive" + the dest amount', () => {
    const msg = buildStage1Message(b2bTransfer());
    expect(msg).toContain('Mumbai Textiles Pvt Ltd will receive ₹42,600');
    expect(msg).toContain('within ~10 minutes');
  });

  it('B2B NEVER leaks the raw bank account / ACH token', () => {
    const msg = buildStage1Message({
      ...b2bTransfer(),
      payoutDestination: 'AE12345678901234567890',
      achTokenRef: 'ach-mandate-secret-xyz',
    });
    expect(msg).not.toContain('AE12345678901234567890');
    expect(msg).not.toContain('ach-mandate-secret-xyz');
  });

  it('ach_pull alone (no explicit transferType) still triggers the B2B wording', () => {
    const msg = buildStage1Message({
      ...awaitingTransfer(),
      fundingMethod: 'ach_pull',
    });
    expect(msg).toContain('will be debited from your business account');
  });

  it('falls back to the display recipient name when the business name is masked', () => {
    const msg = buildStage1Message({
      ...b2bTransfer(),
      recipientBusinessName: '****Ltd', // masked ****last4 — must NOT be named
    });
    expect(msg).not.toContain('****Ltd');
    expect(msg).toContain('Mom will receive');
  });

  it('held B2B keeps the review copy AND the business-debit wording', () => {
    const msg = buildStage1Message(b2bTransfer(), { held: true });
    expect(msg).toContain('will be debited from your business account');
    expect(msg).toContain('quick review');
    expect(msg).not.toContain('within ~10 minutes');
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

  it('does NOT deliver a paid transfer with a refund pending — returns empty messages', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer({
      ...awaitingTransfer(),
      status: 'paid',
      paidAt: '2026-05-21T01:00:00.000Z',
      refundStatus: 'pending',
    });

    const result = await completePaymentStage2(store, 'pay12345');
    // Stays paid — the recipient must never be paid while the sender is refunded.
    expect(result.transfer.status).toBe('paid');
    expect(result.transfer.deliveredAt).toBeUndefined();
    expect(result.senderMessages).toHaveLength(0);
  });

  it('does NOT deliver a paid transfer with a refund requested — returns empty messages', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer({
      ...awaitingTransfer(),
      status: 'paid',
      paidAt: '2026-05-21T01:00:00.000Z',
      refundStatus: 'requested',
    });

    const result = await completePaymentStage2(store, 'pay12345');
    expect(result.transfer.status).toBe('paid');
    expect(result.transfer.deliveredAt).toBeUndefined();
    expect(result.senderMessages).toHaveLength(0);
  });

  it('STILL delivers a normal paid transfer with refundStatus none (regression)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer({
      ...awaitingTransfer(),
      status: 'paid',
      paidAt: '2026-05-21T01:00:00.000Z',
      refundStatus: 'none',
    });

    const result = await completePaymentStage2(store, 'pay12345');
    expect(result.transfer.status).toBe('delivered');
    expect(result.transfer.deliveredAt).toBeTruthy();
    expect(result.senderMessages).toHaveLength(1);
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
    // Partner-demo R6a: the sender phone reaches the RECIPIENT masked to last 4.
    expect(params[2]).toBe('****4567');
    expect(params.join(' ')).not.toContain('5551234567');
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
    expect(params[2]).toBe('****4321');
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
    expect(text).toContain('****4567');       // sender phone, masked (R6a)
    expect(text).not.toContain('5551234567');
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

// Program-Fix 8: the customer notice for a rail failure. Pure; three variants
// chosen by the FINAL refund status (rail-failure.ts). The rail's reason and
// every internal term stay out of it.
describe('buildRailFailureMessage (fix 8)', () => {
  const FORBIDDEN = ['partner', 'sanction', 'blocked', 'compliance', 'rail', 'account_unreachable', 'review'];
  const variants = ['refund', 'reversal', 'contact'] as const;

  it('every variant names the transfer id and the recipient, and leaks no internal term', () => {
    for (const v of variants) {
      const msg = buildRailFailureMessage(awaitingTransfer(), v);
      expect(msg).toContain('pay12345');
      expect(msg).toContain('Mom');
      for (const w of FORBIDDEN) expect(msg.toLowerCase()).not.toContain(w);
    }
  });

  it('refund: the SOURCE-currency charge is being refunded to the original payment method', () => {
    const msg = buildRailFailureMessage(awaitingTransfer(), 'refund');
    expect(msg).toContain('$500.00');
    expect(msg).toMatch(/refund/i);
    expect(msg).toContain('original payment method');
  });

  it('reversal (partner-pulled): says the debit is being reversed, never "refunded to your payment method"', () => {
    const t: Transfer = { ...awaitingTransfer(), fundingMethod: 'bank_pull', transferType: 'b2b', sourceCurrency: 'GBP', totalChargeSource: 410.5 };
    const msg = buildRailFailureMessage(t, 'reversal');
    expect(msg).toContain('£410.50');
    expect(msg).toMatch(/revers/i);
    expect(msg).not.toContain('payment method');
  });

  it('contact: promises a follow-up, promises no refund', () => {
    const msg = buildRailFailureMessage(awaitingTransfer(), 'contact');
    expect(msg).toMatch(/contact you/i);
    expect(msg.toLowerCase()).not.toContain('refund');
  });
});

// Program-Fix 38: an outsider-written recipient name (a partner-API mint) never
// carries a web address into a system-sent message — pre-fix rows included.
describe('fix 38: recipient names are display-clamped at render', () => {
  const hostile = (recipientName: string): Transfer => ({ ...awaitingTransfer(), recipientName });

  it('recipientDisplayName strips the address, and an all-address name falls back to "your recipient"', () => {
    expect(recipientDisplayName(hostile('Mom www.x.io'))).toBe('Mom');
    expect(recipientDisplayName(hostile('Mom\nwww.x.io'))).toBe('Mom');
    expect(recipientDisplayName(hostile('www.x.io'))).toBe('your recipient');
    expect(recipientDisplayName(hostile('https://evil.example/x'))).toBe('your recipient');
    expect(recipientDisplayName(awaitingTransfer())).toBe('Mom');
  });

  it('template params: 4 params in the same order, no address, never empty, no newline', () => {
    for (const name of ['Mom www.x.io', 'Mom\nwww.x.io', 'www.x.io']) {
      const params = recipientTemplateParams(hostile(name));
      expect(params).toHaveLength(4);
      expect(params[0]).toBe(name === 'www.x.io' ? 'your recipient' : 'Mom');
      expect(params[3]).toBe('bank account');
      for (const p of params) {
        expect(p).not.toBe('');
        expect(p).not.toContain('x.io');
        expect(p).not.toMatch(/[\n\r]/);
      }
    }
  });

  it('the recipient fallback text, the stage-1 line and the rail-failure line carry no address', () => {
    const t = hostile('Mom www.x.io');
    for (const msg of [
      recipientDeliveredFallbackText(t, 'Acme Remit'),
      buildStage1Message(t),
      buildRailFailureMessage(t, 'refund'),
    ]) {
      expect(msg).not.toContain('x.io');
      expect(msg).toContain('Mom');
    }
    expect(buildStage1Message(hostile('www.x.io'))).toContain('your recipient will get');
  });

  it('the B2B stage-1 line clamps the recipient business name too', () => {
    const t: Transfer = {
      ...awaitingTransfer(), transferType: 'b2b', fundingMethod: 'ach_pull',
      recipientEntityType: 'business', recipientBusinessName: 'Mumbai Textiles acme.com',
    };
    const msg = buildStage1Message(t);
    expect(msg).toContain('Mumbai Textiles will receive');
    expect(msg).not.toContain('acme.com');
  });

  it('the stage-2 sender line carries no address (a pre-fix row)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer({ ...hostile('Mom www.x.io'), status: 'paid' });
    const result = await completePaymentStage2(store, 'pay12345');
    expect(result.senderMessages[0]).toContain('delivered to Mom via bank transfer');
    expect(result.senderMessages[0]).not.toContain('x.io');
  });

  it('a clean name is byte-identical to before (control)', () => {
    expect(buildStage1Message(awaitingTransfer())).toBe(
      '✅ Payment received — $500.00 charged. Mom will get ₹42,600 within ~10 minutes. Transfer ID: pay12345',
    );
  });
});
