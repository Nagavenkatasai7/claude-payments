import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

const sendText = vi.fn(async (..._a: unknown[]) => {});
vi.mock('@/lib/whatsapp', () => ({
  sendText: (...a: unknown[]) => sendText(...a),
}));

import {
  HttpPaymentProvider,
  normalizeRailStatus,
  railCallbackTransferId,
  buildSettlementInstruction,
  signBody,
} from '@/lib/providers/http-payment-provider';

function fixture(): Transfer {
  return {
    id: 'rail_t1', phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '1234567890', fundingMethod: 'bank_transfer',
    status: 'awaiting_payment', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: '2026-06-09T00:00:00.000Z', partnerId: 'acme',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
  } as Transfer;
}

const PAYMENT = {
  providerType: 'simulator',
  credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 'sign-secret' },
  webhookSecret: 'cb-secret',
};

let db: Db;
beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'acme'); // transfers.partner_id has a real FK to partners
  sendText.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe('normalizeRailStatus', () => {
  it('maps the documented rail lifecycle to our domain', () => {
    expect(normalizeRailStatus('created')).toBe('awaiting_payment');
    expect(normalizeRailStatus('funded')).toBe('paid');
    expect(normalizeRailStatus('paid_out')).toBe('delivered');
    expect(normalizeRailStatus('PAID_OUT')).toBe('delivered'); // case-insensitive
  });
  it('failed/unknown/non-string → null (forward-only machine ignores them)', () => {
    expect(normalizeRailStatus('failed')).toBeNull();
    expect(normalizeRailStatus('refunded')).toBeNull();
    expect(normalizeRailStatus(42)).toBeNull();
    expect(normalizeRailStatus(undefined)).toBeNull();
  });
});

describe('railCallbackTransferId', () => {
  it('prefers reference, accepts transferId/transfer_id', () => {
    expect(railCallbackTransferId({ reference: 'a' })).toBe('a');
    expect(railCallbackTransferId({ transferId: 'b' })).toBe('b');
    expect(railCallbackTransferId({ transfer_id: 'c' })).toBe('c');
  });
  it('null for missing/empty/non-object', () => {
    expect(railCallbackTransferId({})).toBeNull();
    expect(railCallbackTransferId({ reference: '' })).toBeNull();
    expect(railCallbackTransferId('x')).toBeNull();
    expect(railCallbackTransferId(null)).toBeNull();
  });
});

describe('HttpPaymentProvider.initiateTransfer (the real rail loop, outbound leg)', () => {
  it('fires stage-1, POSTs the SIGNED instruction, returns the rail providerRef, arms NO timer', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(fixture());
    let captured: { url: string; body: string; sig: string } | null = null;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      captured = {
        url: String(url),
        body: String(init.body),
        sig: (init.headers as Record<string, string>)['x-signature'] ?? '',
      };
      return { ok: true, json: async () => ({ providerRef: 'rail-ref-99' }) } as Response;
    }));

    const provider = new HttpPaymentProvider(store, PAYMENT, 'Acme Pay');
    const { providerRef } = await provider.initiateTransfer(fixture());

    // stage-1 charged + sender message sent
    expect((await store.getTransfer('rail_t1'))!.status).toBe('paid');
    expect(sendText).toHaveBeenCalledTimes(1);
    // signed instruction went to the partner's endpoint
    expect(captured!.url).toBe('https://rail.example/settle');
    const expectedSig = createHmac('sha256', 'sign-secret').update(captured!.body).digest('hex');
    expect(captured!.sig).toBe(expectedSig);
    const instruction = JSON.parse(captured!.body) as Record<string, unknown>;
    expect(instruction.reference).toBe('rail_t1');
    expect(instruction.partner_id).toBe('acme');
    // rail's ref is persisted upstream by the caller
    expect(providerRef).toBe('rail-ref-99');
    // NO self-advance: status stays 'paid' until the rail's callback arrives
    expect((await store.getTransfer('rail_t1'))!.status).toBe('paid');
  });

  it('fail-closed: no settlementUrl configured → throws, nothing charged', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(fixture());
    const provider = new HttpPaymentProvider(store, { providerType: 'http' });
    await expect(provider.initiateTransfer(fixture())).rejects.toThrow(/not configured/);
    expect((await store.getTransfer('rail_t1'))!.status).toBe('awaiting_payment');
  });

  it('rail rejection (non-2xx) throws after stage-1 (caller surfaces the error)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(fixture());
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, text: async () => 'down' }) as unknown as Response));
    const provider = new HttpPaymentProvider(store, PAYMENT);
    await expect(provider.initiateTransfer(fixture())).rejects.toThrow(/503/);
  });
});

describe('HttpPaymentProvider.handleWebhook', () => {
  it('normalizes a rail callback to our domain', async () => {
    const provider = new HttpPaymentProvider(createStore(fakeRedis(), db), PAYMENT);
    expect(await provider.handleWebhook({ reference: 'rail_t1', status: 'paid_out' }))
      .toEqual({ transferId: 'rail_t1', status: 'delivered' });
    expect(await provider.handleWebhook({ reference: 'rail_t1', status: 'funded' }))
      .toEqual({ transferId: 'rail_t1', status: 'paid' });
  });
  it('null for missing reference or unmapped status', async () => {
    const provider = new HttpPaymentProvider(createStore(fakeRedis(), db), PAYMENT);
    expect(await provider.handleWebhook({ status: 'paid_out' })).toBeNull();
    expect(await provider.handleWebhook({ reference: 'rail_t1', status: 'failed' })).toBeNull();
  });
});

describe('signBody + buildSettlementInstruction', () => {
  it('instruction carries the locked FX + non-custodial routing fields', () => {
    const i = buildSettlementInstruction(fixture());
    expect(i).toMatchObject({
      reference: 'rail_t1',
      partner_id: 'acme',
      corridor: { source: 'US', destination: 'IN' },
      payout: { rail: 'bank', destination: '1234567890' },
      amount: { source: 200, currency: 'USD', destination: 16600, destination_currency: 'INR', fx_rate: 83 },
    });
  });
  it('signBody is HMAC-SHA256 hex over the exact body', () => {
    expect(signBody('abc', 'k')).toBe(createHmac('sha256', 'k').update('abc').digest('hex'));
  });
});

describe('buildSettlementInstruction — non-custodial funding legs', () => {
  // A US-domestic B2B ach_pull transfer.
  function achPull(): Transfer {
    return {
      ...fixture(),
      id: 'ach_t1', fundingMethod: 'ach_pull', achTokenRef: 'ach_abc123',
      transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business',
      senderBusinessName: 'Buyer LLC', recipientBusinessName: 'Acme Pvt Ltd',
    } as Transfer;
  }
  // A cross-border B2B bank_pull transfer: buyer in HK (HKD) → seller in IN (INR).
  // amountSource = PRINCIPAL (1000, reconciles: 1000 * 8.5 = 8500), feeSource = 10,
  // totalChargeSource = 1010 (the FULL buyer debit the funding leg carries).
  function bankPull(): Transfer {
    return {
      ...fixture(),
      id: 'bp_t1', fundingMethod: 'bank_pull', achTokenRef: 'bankpull_deadbeef',
      sourceCountry: 'HK', sourceCurrency: 'HKD', amountSource: 1000, feeSource: 10, totalChargeSource: 1010,
      destinationCountry: 'IN', destinationCurrency: 'INR', amountInr: 8500, fxRate: 8.5,
      payoutMethod: 'bank', payoutDestination: '123456789 HDFC0001234',
      recipientName: 'Mumbai Imports', recipientPhone: '919876543210',
      transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business',
      senderBusinessName: 'HK Buyer Co', recipientBusinessName: 'Mumbai Imports',
    } as Transfer;
  }

  it('b2c (card/bank) carries NO funding block — byte-unchanged', () => {
    const i = buildSettlementInstruction(fixture()) as Record<string, unknown>;
    expect('funding' in i).toBe(false);
    expect('parties' in i).toBe(false);
  });

  it('ach_pull funding block is byte-unchanged: {method:ach_debit, token} only', () => {
    const i = buildSettlementInstruction(achPull()) as Record<string, unknown>;
    expect(i.funding).toEqual({ method: 'ach_debit', token: 'ach_abc123' });
    // ach_pull must NOT gain the bank_pull cross-border fields.
    expect(i.funding).not.toHaveProperty('amount');
    expect(i.funding).not.toHaveProperty('country');
  });

  it('bank_pull is a SIGNED DUAL-LEG instruction: FUNDING (debit buyer) + PAYOUT (pay seller exactly)', () => {
    const i = buildSettlementInstruction(bankPull()) as Record<string, unknown>;
    // FUNDING leg — debit the BUYER's local bank for the FULL buyer total
    // (totalChargeSource = 1010, principal + fee) in HKD. token is OPAQUE (no raw
    // bank digits); SmartRemit captures nothing.
    expect(i.funding).toEqual({
      method: 'bank_debit',
      token: 'bankpull_deadbeef',
      amount: 1010,
      currency: 'HKD',
      country: 'HK',
    });
    // PAYOUT leg — pay the SELLER their EXACT invoiced amount in the seller currency,
    // to the seller-profile destination. amount.source = principal (1000), so
    // source * fx_rate (1000 * 8.5) === destination (8500) — reconciles.
    expect(i.payout).toEqual({ rail: 'bank', destination: '123456789 HDFC0001234' });
    expect(i.amount).toMatchObject({
      source: 1000, currency: 'HKD',
      destination: 8500, destination_currency: 'INR', fx_rate: 8.5,
    });
    // It's a B2B instruction (parties present), and the same HMAC recipe signs it.
    expect(i.parties).toMatchObject({ recipient_business_name: 'Mumbai Imports' });
    const body = JSON.stringify(i);
    expect(signBody(body, 'sign-secret')).toBe(createHmac('sha256', 'sign-secret').update(body).digest('hex'));
  });
});
