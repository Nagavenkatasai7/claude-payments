import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
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
    createdAt: '2026-06-09T00:00:00Z', partnerId: 'acme',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
  } as Transfer;
}

const PAYMENT = {
  providerType: 'simulator',
  credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 'sign-secret' },
  webhookSecret: 'cb-secret',
};

beforeEach(() => sendText.mockClear());
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
    const store = createStore(fakeRedis());
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
    const store = createStore(fakeRedis());
    await store.saveTransfer(fixture());
    const provider = new HttpPaymentProvider(store, { providerType: 'http' });
    await expect(provider.initiateTransfer(fixture())).rejects.toThrow(/not configured/);
    expect((await store.getTransfer('rail_t1'))!.status).toBe('awaiting_payment');
  });

  it('rail rejection (non-2xx) throws after stage-1 (caller surfaces the error)', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer(fixture());
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, text: async () => 'down' }) as unknown as Response));
    const provider = new HttpPaymentProvider(store, PAYMENT);
    await expect(provider.initiateTransfer(fixture())).rejects.toThrow(/503/);
  });
});

describe('HttpPaymentProvider.handleWebhook', () => {
  it('normalizes a rail callback to our domain', async () => {
    const provider = new HttpPaymentProvider(createStore(fakeRedis()), PAYMENT);
    expect(await provider.handleWebhook({ reference: 'rail_t1', status: 'paid_out' }))
      .toEqual({ transferId: 'rail_t1', status: 'delivered' });
    expect(await provider.handleWebhook({ reference: 'rail_t1', status: 'funded' }))
      .toEqual({ transferId: 'rail_t1', status: 'paid' });
  });
  it('null for missing reference or unmapped status', async () => {
    const provider = new HttpPaymentProvider(createStore(fakeRedis()), PAYMENT);
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
