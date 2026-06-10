import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';

// after() callbacks are captured as promises so tests can deterministically
// await them before asserting sends (the WL3 notify path now awaits partner
// resolution before the first send, so fire-and-forget would race).
const afterPending: Promise<void>[] = [];
vi.mock('next/server', async (orig) => {
  const real = await orig<typeof import('next/server')>();
  return {
    ...real,
    after: (cb: () => Promise<void> | void) => {
      afterPending.push(Promise.resolve().then(cb));
    },
  };
});
const flushAfter = async () => { await Promise.all(afterPending.splice(0)); };

const sendText = vi.fn(async (..._a: unknown[]) => {});
const sendTemplate = vi.fn(async (..._a: unknown[]) => {});
vi.mock('@/lib/whatsapp', () => ({
  sendText: (...a: unknown[]) => sendText(...a),
  sendTemplate: (...a: unknown[]) => sendTemplate(...a),
  RECIPIENT_TEMPLATE_NAME: 'transfer_delivered',
  RECIPIENT_TEMPLATE_LANG: 'en',
}));

// In-memory store double + a controllable handleWebhook. getTransfer → null so
// the WL3 partner-secret resolution falls through to the env per-provider secret
// (the legacy contract these tests pin).
const updateTransferFromWebhook = vi.fn();
const handleWebhook = vi.fn();
vi.mock('@/lib/store', () => ({
  getStore: () => ({ updateTransferFromWebhook, getTransfer: async () => null }),
}));
vi.mock('@/lib/providers/payment-provider', () => ({
  getPaymentProvider: () => ({ handleWebhook }),
}));
// WL3: the route resolves the owning partner for branding/creds; stub to defaults.
vi.mock('@/lib/partner-store', () => ({
  getPartnerStore: () => ({ getPartner: async () => null }),
}));
vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({
    getIntegrations: async () => ({ kyc: {}, payment: {}, whatsapp: {} }),
  }),
}));

// Stage 3: the per-IP limiter would dial Upstash — always allow in unit tests.
vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));

import { POST } from '@/app/api/payment-webhook/[provider]/route';

const deliveredTransfer = {
  id: 'wh_1', phone: '15551230000', amountInr: 16600, recipientName: 'Mom',
  recipientPhone: '919876543210', payoutMethod: 'upi', status: 'delivered',
};
// A non-INR corridor: amountInr holds the DESTINATION amount (GBP here).
const deliveredGbp = {
  id: 'wh_2', phone: '447911123456', amountInr: 745, destinationCurrency: 'GBP',
  recipientName: 'Liam', recipientPhone: '447911000000', payoutMethod: 'bank', status: 'delivered',
};
const SECRET = 'uniteller-secret';
const body = JSON.stringify({ reference: 'wh_1', status: 'paid_out' });
const sig = (b: string, s = SECRET) => createHmac('sha256', s).update(b).digest('hex');

function post(provider: string, raw: string, signature?: string) {
  const req = new NextRequest('https://x/api/payment-webhook/' + provider, {
    method: 'POST', body: raw,
    headers: signature ? { 'x-signature': signature } : {},
  });
  return POST(req, { params: Promise.resolve({ provider }) });
}

beforeEach(() => {
  sendText.mockClear(); sendTemplate.mockClear();
  updateTransferFromWebhook.mockReset(); handleWebhook.mockReset();
  process.env.PAYMENT_WEBHOOK_SECRET_UNITELLER = SECRET;
});

describe('POST /api/payment-webhook/[provider]', () => {
  it('real provider with a BAD signature → 401, no mutation', async () => {
    const res = await post('uniteller', body, 'deadbeef');
    expect(res.status).toBe(401);
    expect(handleWebhook).not.toHaveBeenCalled();
    expect(updateTransferFromWebhook).not.toHaveBeenCalled();
  });

  it('real provider, GOOD signature + paid_out → updates + fires stage-2 notifications once', async () => {
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', status: 'delivered' });
    updateTransferFromWebhook.mockResolvedValue(deliveredTransfer);
    const res = await post('uniteller', body, sig(body));
    expect(res.status).toBe(200);
    await flushAfter();
    expect(updateTransferFromWebhook).toHaveBeenCalledWith('wh_1', 'delivered');
    expect(sendText).toHaveBeenCalledTimes(1);
    expect((sendText.mock.calls[0] as unknown[])[1]).toContain('delivered');
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect((sendTemplate.mock.calls[0] as unknown[])[1]).toBe('transfer_delivered');
  });

  it('delivered message uses the DESTINATION currency (GBP shows £, never ₹)', async () => {
    handleWebhook.mockResolvedValue({ transferId: 'wh_2', status: 'delivered' });
    updateTransferFromWebhook.mockResolvedValue(deliveredGbp);
    const res = await post('uniteller', body, sig(body));
    expect(res.status).toBe(200);
    await flushAfter();
    expect(sendText).toHaveBeenCalledTimes(1);
    const msg = (sendText.mock.calls[0] as unknown[])[1] as string;
    expect(msg).toContain('£');
    expect(msg).not.toContain('₹');
    expect(msg).toContain('delivered');
  });

  it('DUPLICATE paid_out (update returns null) → 200 but NO notification', async () => {
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', status: 'delivered' });
    updateTransferFromWebhook.mockResolvedValue(null); // no real transition
    const res = await post('uniteller', body, sig(body));
    expect(res.status).toBe(200);
    await flushAfter();
    expect(sendText).not.toHaveBeenCalled();
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('malformed JSON → 400, no mutation', async () => {
    const raw = '{not json';
    const res = await post('uniteller', raw, sig(raw));
    expect(res.status).toBe(400);
    expect(updateTransferFromWebhook).not.toHaveBeenCalled();
  });

  it('unparseable-but-valid-JSON (handleWebhook → null) → 200 ignored, no mutation', async () => {
    handleWebhook.mockResolvedValue(null);
    const res = await post('uniteller', body, sig(body));
    expect(res.status).toBe(200);
    expect(updateTransferFromWebhook).not.toHaveBeenCalled();
  });

  it('mock provider path → verification skipped (no signature needed)', async () => {
    handleWebhook.mockResolvedValue(null); // mock handleWebhook is a no-op
    const res = await post('mock', body); // no x-signature header
    expect(res.status).toBe(200);
    expect(handleWebhook).toHaveBeenCalled();
  });
});
