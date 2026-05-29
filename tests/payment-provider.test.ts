import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import type { Transfer } from '@/lib/types';

// Capture the after() callback so we can flush stage 2 deterministically.
const afterCbs: Array<() => Promise<void> | void> = [];
vi.mock('next/server', () => ({
  after: (cb: () => Promise<void> | void) => { afterCbs.push(cb); },
}));

const sendText = vi.fn(async (_phone: string, _msg: string) => {});
const sendTemplate = vi.fn(async (_phone: string, _name: string, _lang: string, _params: string[]) => {});
vi.mock('@/lib/whatsapp', () => ({
  sendText: (phone: string, msg: string) => sendText(phone, msg),
  sendTemplate: (phone: string, name: string, lang: string, params: string[]) => sendTemplate(phone, name, lang, params),
  RECIPIENT_TEMPLATE_NAME: 'transfer_delivered',
  RECIPIENT_TEMPLATE_LANG: 'en',
}));

import {
  MockPaymentProvider, getPaymentProvider, DELIVERY_DELAY_MS,
} from '@/lib/providers/payment-provider';

function fixture(): Transfer {
  return {
    id: 'pay_seam_1', phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer',
    status: 'awaiting_payment', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: '2026-05-29T00:00:00Z', partnerId: 'default',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
  } as Transfer;
}

beforeEach(() => { afterCbs.length = 0; sendText.mockClear(); sendTemplate.mockClear(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe('DELIVERY_DELAY_MS', () => {
  it('is the same 120000ms (2 min) the route used today', () => {
    expect(DELIVERY_DELAY_MS).toBe(120000);
  });
});

describe('MockPaymentProvider.initiateTransfer (stage 1 — byte-for-byte today)', () => {
  it('marks the transfer paid, sends the sender "received" text, returns mock-<id>', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer(fixture());
    const provider = new MockPaymentProvider(store);

    const { providerRef } = await provider.initiateTransfer(fixture());

    expect(providerRef).toBe('mock-pay_seam_1');
    expect((await store.getTransfer('pay_seam_1'))!.status).toBe('paid');
    expect(sendText).toHaveBeenCalledTimes(1);
    const stCall0 = sendText.mock.calls[0] as [string, string];
    expect(stCall0[0]).toBe('15551230000');
    expect(stCall0[1]).toContain('Payment received');
    // stage 2 is registered but NOT yet run
    expect(afterCbs).toHaveLength(1);
    expect(sendTemplate).not.toHaveBeenCalled();
  });
});

describe('MockPaymentProvider stage 2 self-advance (after the 120000ms sleep)', () => {
  it('marks delivered, sends sender "delivered" text + recipient template after the delay', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer(fixture());
    const provider = new MockPaymentProvider(store);
    await provider.initiateTransfer(fixture());
    sendText.mockClear();

    // Drive the registered after() callback through the 120000ms timer.
    const run = afterCbs[0]();
    await vi.advanceTimersByTimeAsync(DELIVERY_DELAY_MS);
    await run;

    expect((await store.getTransfer('pay_seam_1'))!.status).toBe('delivered');
    expect(sendText).toHaveBeenCalledTimes(1);
    const stCall = sendText.mock.calls[0] as [string, string];
    expect(stCall[1]).toContain('delivered');
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    const tmCall = sendTemplate.mock.calls[0] as [string, string, string, string[]];
    expect(tmCall[0]).toBe('919876543210');
    expect(tmCall[1]).toBe('transfer_delivered');
    expect(tmCall[2]).toBe('en');
    // recipientTemplateParams → [recipientName, amountInr, sender, destination]
    expect(tmCall[3]).toEqual(['Mom', '16,600', '+15551230000', 'UPI ID']);
  });

  it('skips the recipient template when there is no recipientPhone', async () => {
    const store = createStore(fakeRedis());
    const t = fixture(); t.recipientPhone = '';
    await store.saveTransfer(t);
    const provider = new MockPaymentProvider(store);
    await provider.initiateTransfer(t);
    const run = afterCbs[0](); await vi.advanceTimersByTimeAsync(DELIVERY_DELAY_MS); await run;
    expect(sendTemplate).not.toHaveBeenCalled();
  });
});

describe('MockPaymentProvider.getStatus (derives from stored TransferStatus)', () => {
  it('maps awaiting_payment→created, paid→funded, delivered→paid_out', async () => {
    const store = createStore(fakeRedis());
    const t = fixture(); await store.saveTransfer(t);
    const provider = new MockPaymentProvider(store);
    expect(await provider.getStatus('mock-pay_seam_1')).toBe('created');
    await store.saveTransfer({ ...t, status: 'paid' });
    expect(await provider.getStatus('mock-pay_seam_1')).toBe('funded');
    await store.saveTransfer({ ...t, status: 'delivered' });
    expect(await provider.getStatus('mock-pay_seam_1')).toBe('paid_out');
  });
  it('returns created for an unknown / malformed ref', async () => {
    const provider = new MockPaymentProvider(createStore(fakeRedis()));
    expect(await provider.getStatus('mock-nope')).toBe('created');
    expect(await provider.getStatus('garbage')).toBe('created');
  });
});

describe('MockPaymentProvider.handleWebhook + factory', () => {
  it('handleWebhook is a no-op returning null (mirrors MockKycProvider)', async () => {
    const provider = new MockPaymentProvider(createStore(fakeRedis()));
    expect(await provider.handleWebhook({ any: 'thing' })).toBeNull();
  });
  it('getPaymentProvider returns the mock under the default mode', () => {
    const provider = getPaymentProvider(createStore(fakeRedis()));
    expect(provider).toBeInstanceOf(MockPaymentProvider);
  });
});
