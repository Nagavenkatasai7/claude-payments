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
  // Faithful to the real helper: run the template send, fall back to free-form
  // text only if it throws (the recipient-delivery resilience under test).
  sendTemplateOrText: async (to: string, send: () => Promise<void>, fallbackText: string, creds?: unknown) => {
    try { await send(); } catch { await sendText(to, fallbackText, creds); }
  },
  RECIPIENT_TEMPLATE_NAME: 'transfer_delivered',
  RECIPIENT_TEMPLATE_LANG: 'en',
}));

// In-memory store double + a controllable handleWebhook. The default fixture
// state (no transfers, no integrations) keeps the legacy contract these tests
// pin: getTransfer → null so the WL3 partner-secret resolution falls through to
// the env per-provider secret. Routed tests set fixtures per test.
const fixtures = vi.hoisted(() => ({
  transfersById: {} as Record<string, unknown>,
  integrationsByPartner: {} as Record<string, unknown>,
  getPaymentProviderCalls: [] as unknown[][],
}));
const updateTransferFromWebhook = vi.fn();
const handleWebhook = vi.fn();
vi.mock('@/lib/store', () => ({
  getStore: () => ({
    updateTransferFromWebhook,
    getTransfer: async (id: string) => fixtures.transfersById[id] ?? null,
  }),
}));
vi.mock('@/lib/providers/payment-provider', () => ({
  getPaymentProvider: (...args: unknown[]) => {
    fixtures.getPaymentProviderCalls.push(args);
    return { handleWebhook };
  },
}));
// WL3: the route resolves the owning partner for branding/creds; stub to defaults.
vi.mock('@/lib/partner-store', () => ({
  getPartnerStore: () => ({ getPartner: async () => null }),
}));
vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({
    getIntegrations: async (partnerId: string) =>
      fixtures.integrationsByPartner[partnerId] ?? { kyc: {}, payment: {}, whatsapp: {} },
  }),
}));

// Stage 3: the per-IP limiter would dial Upstash — always allow in unit tests.
vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));

// fix 8: the failure path and the refused-delivery alert are PGlite-tested in
// tests/rail-failure.test.ts (state, transactionality, replay, both orders);
// here we pin DISPATCH: what the route calls, below the HMAC gate, and what it
// answers.
const handleRailFailure = vi.fn(async (..._a: unknown[]) => ({ kind: 'failed', refundStarted: true }));
const alertRefusedDelivery = vi.fn(async (..._a: unknown[]) => false);
vi.mock('@/lib/rail-failure', () => ({
  handleRailFailure: (...a: unknown[]) => handleRailFailure(...a),
  alertRefusedDelivery: (...a: unknown[]) => alertRefusedDelivery(...a),
}));

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
  handleRailFailure.mockClear(); alertRefusedDelivery.mockClear();
  fixtures.transfersById = {};
  fixtures.integrationsByPartner = {};
  fixtures.getPaymentProviderCalls.length = 0;
  afterPending.length = 0; // never leak an unflushed after() into the next test
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

  it('recipient TEMPLATE rejected by Meta → falls back to a free-form text so the recipient is still notified', async () => {
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', status: 'delivered' });
    updateTransferFromWebhook.mockResolvedValue(deliveredTransfer);
    // Meta rejects the template (bad params / not approved / wrong lang).
    sendTemplate.mockRejectedValueOnce(new Error('WhatsApp template send failed (400)'));
    const res = await post('uniteller', body, sig(body));
    expect(res.status).toBe(200);
    await flushAfter();
    // Template was ATTEMPTED, then the recipient got a free-form text instead.
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(2); // [0] sender's "delivered", [1] recipient fallback
    const recipientCall = sendText.mock.calls[1] as unknown[];
    expect(recipientCall[0]).toBe('919876543210');       // the RECIPIENT's phone, not the sender's
    expect(String(recipientCall[1])).toContain('Mom');   // recipient name in the fallback text
    expect(String(recipientCall[1])).toMatch(/received/i);
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

  it('DUPLICATE paid_out (update returns null) → 200 but NO notification; the refused delivery is checked for a conflict (fix 8)', async () => {
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', status: 'delivered' });
    updateTransferFromWebhook.mockResolvedValue(null); // no real transition
    const res = await post('uniteller', body, sig(body));
    expect(res.status).toBe(200);
    await flushAfter();
    expect(sendText).not.toHaveBeenCalled();
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(alertRefusedDelivery).toHaveBeenCalledTimes(1);
    expect(alertRefusedDelivery.mock.calls[0][1]).toBe('wh_1');
  });

  it('a REAL delivered transition, or a refused non-delivered status, never checks for a conflict', async () => {
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', status: 'delivered' });
    updateTransferFromWebhook.mockResolvedValue(deliveredTransfer);
    expect((await post('uniteller', body, sig(body))).status).toBe(200);
    await flushAfter();
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', status: 'paid' });
    updateTransferFromWebhook.mockResolvedValue(null); // a replayed `funded`
    expect((await post('uniteller', body, sig(body))).status).toBe(200);
    expect(alertRefusedDelivery).not.toHaveBeenCalled();
    expect(handleRailFailure).not.toHaveBeenCalled();
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

describe('POST /api/payment-webhook — settlement routing (settlementPartnerId)', () => {
  const ownerInteg = {
    kyc: {},
    payment: { providerType: 'simulator', webhookSecret: 'owner_whk' },
    whatsapp: { phoneNumberId: 'pn_owner', token: 'tok_owner' },
  };
  const railInteg = {
    kyc: {},
    payment: { providerType: 'simulator', webhookSecret: 'rail_whk' },
    whatsapp: { phoneNumberId: 'pn_rail', token: 'tok_rail' },
  };

  it("UNROUTED transfer: verifies with the OWNING partner's webhookSecret (pinned)", async () => {
    fixtures.transfersById['wh_1'] = { ...deliveredTransfer, partnerId: 'owner' };
    fixtures.integrationsByPartner['owner'] = ownerInteg;
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', status: 'delivered' });
    updateTransferFromWebhook.mockResolvedValue({ ...deliveredTransfer, partnerId: 'owner' });

    expect((await post('simulator', body, sig(body, 'rail_whk'))).status).toBe(401);
    const res = await post('simulator', body, sig(body, 'owner_whk'));
    expect(res.status).toBe(200);
    await flushAfter();
    // Unrouted: ONE integrations object drives both sides — owner's creds.
    expect((sendText.mock.calls[0] as unknown[])[2])
      .toEqual({ phoneNumberId: 'pn_owner', token: 'tok_owner' });
  });

  it("unsigned POST to /mock can NOT bypass HMAC when the transfer's RAIL is webhook-driven", async () => {
    // The URL segment is caller-chosen: 'mock' skips verification ONLY when the
    // resolved rail is actually mock — a routed (webhook-driven) transfer must
    // still demand a valid signature or an attacker could flip money state.
    fixtures.transfersById['wh_1'] = {
      ...deliveredTransfer, partnerId: 'owner', settlementPartnerId: 'railp',
    };
    fixtures.integrationsByPartner['railp'] = railInteg;
    const res = await post('mock', body); // no x-signature
    expect(res.status).toBe(401);
    expect(handleWebhook).not.toHaveBeenCalled();
    expect(updateTransferFromWebhook).not.toHaveBeenCalled();
  });

  it("ROUTED transfer: HMAC verifies with the SETTLEMENT partner's secret; notifications use the OWNER's creds", async () => {
    fixtures.transfersById['wh_1'] = {
      ...deliveredTransfer, partnerId: 'owner', settlementPartnerId: 'railp',
    };
    fixtures.integrationsByPartner['owner'] = ownerInteg;
    fixtures.integrationsByPartner['railp'] = railInteg;
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', status: 'delivered' });
    updateTransferFromWebhook.mockResolvedValue({
      ...deliveredTransfer, partnerId: 'owner', settlementPartnerId: 'railp',
    });

    // The callback comes from railp's rail — the OWNER's secret must NOT pass.
    expect((await post('simulator', body, sig(body, 'owner_whk'))).status).toBe(401);
    expect(updateTransferFromWebhook).not.toHaveBeenCalled();

    const res = await post('simulator', body, sig(body, 'rail_whk'));
    expect(res.status).toBe(200);
    // Provider resolution is rail-side: getPaymentProvider got railp's payment config.
    const lastCall = fixtures.getPaymentProviderCalls.at(-1)!;
    expect(lastCall[2]).toEqual(railInteg.payment);

    await flushAfter();
    // Brand-side: the delivered messages go out from the OWNING partner's number.
    expect(sendText).toHaveBeenCalledTimes(1);
    expect((sendText.mock.calls[0] as unknown[])[2])
      .toEqual({ phoneNumberId: 'pn_owner', token: 'tok_owner' });
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect((sendTemplate.mock.calls[0] as unknown[])[4])
      .toEqual({ phoneNumberId: 'pn_owner', token: 'tok_owner' });
  });
});

// Program-Fix 8 (money-02 / rail-02): a rail `failed` / `returned` callback is
// acted on — below the HMAC gate, never through the forward state machine.
describe('POST /api/payment-webhook — rail failure (fix 8)', () => {
  const failedBody = JSON.stringify({ reference: 'wh_1', status: 'failed', reason: 'account_unreachable' });
  const failure = { code: 'failed', reason: 'account_unreachable' };
  const paidTransfer = { ...deliveredTransfer, status: 'paid', partnerId: 'owner' };
  const ownerInteg = { kyc: {}, payment: { providerType: 'simulator', webhookSecret: 'owner_whk' }, whatsapp: {} };
  const otherInteg = { kyc: {}, payment: { providerType: 'simulator', webhookSecret: 'other_whk' }, whatsapp: {} };
  const mockInteg = { kyc: {}, payment: { providerType: 'mock' }, whatsapp: {} };

  it('a SIGNED failure → handleRailFailure(db, id, failure) once, 200 { ok }, and the forward machine is never touched', async () => {
    fixtures.transfersById['wh_1'] = paidTransfer;
    fixtures.integrationsByPartner['owner'] = ownerInteg;
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', failure });
    const res = await post('simulator', failedBody, sig(failedBody, 'owner_whk'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(handleRailFailure).toHaveBeenCalledTimes(1);
    expect(handleRailFailure.mock.calls[0].slice(1)).toEqual(['wh_1', failure]);
    expect(updateTransferFromWebhook).not.toHaveBeenCalled();
    expect(alertRefusedDelivery).not.toHaveBeenCalled();
    await flushAfter();
    expect(sendText).not.toHaveBeenCalled(); // the customer notice is an OUTBOX row, not an after() send
  });

  it("TENANT: partner A's transfer, a failure signed with partner B's secret → 401, nothing acts", async () => {
    // Unrouted (no settlementPartnerId): the rail partner IS the owner.
    fixtures.transfersById['wh_1'] = paidTransfer;
    fixtures.integrationsByPartner['owner'] = ownerInteg;
    fixtures.integrationsByPartner['other'] = otherInteg;
    const res = await post('simulator', failedBody, sig(failedBody, 'other_whk'));
    expect(res.status).toBe(401);
    expect(handleWebhook).not.toHaveBeenCalled();
    expect(handleRailFailure).not.toHaveBeenCalled();
  });

  it('an UNSIGNED failure to /simulator → 401 (fail-closed)', async () => {
    fixtures.transfersById['wh_1'] = paidTransfer;
    fixtures.integrationsByPartner['owner'] = ownerInteg;
    const res = await post('simulator', failedBody);
    expect(res.status).toBe(401);
    expect(handleRailFailure).not.toHaveBeenCalled();
  });

  it('an UNSIGNED failure to /mock for a MOCK-rail transfer → 200 ignored: the mock provider parses nothing, the row is untouched', async () => {
    fixtures.transfersById['wh_1'] = paidTransfer;
    fixtures.integrationsByPartner['owner'] = mockInteg;
    handleWebhook.mockResolvedValue(null); // MockPaymentProvider.handleWebhook (pinned in payment-provider.test.ts)
    const res = await post('mock', failedBody);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(handleRailFailure).not.toHaveBeenCalled();
    expect(updateTransferFromWebhook).not.toHaveBeenCalled();
  });

  it('AT-LEAST-ONCE: when the handler throws (db down) the POST rejects — a 500 to the rail, which retries the signed callback', async () => {
    fixtures.transfersById['wh_1'] = paidTransfer;
    fixtures.integrationsByPartner['owner'] = ownerInteg;
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', failure });
    handleRailFailure.mockRejectedValueOnce(new Error('db down'));
    await expect(post('simulator', failedBody, sig(failedBody, 'owner_whk'))).rejects.toThrow('db down');
    expect(handleRailFailure).toHaveBeenCalledTimes(1);
    expect(updateTransferFromWebhook).not.toHaveBeenCalled();
    // The rail's retry lands on the idempotent claim and succeeds.
    expect((await post('simulator', failedBody, sig(failedBody, 'owner_whk'))).status).toBe(200);
    expect(handleRailFailure).toHaveBeenCalledTimes(2);
  });

  it('a REPLAYED signed failure dispatches again (the handler is the idempotent claim) and still answers 200', async () => {
    fixtures.transfersById['wh_1'] = paidTransfer;
    fixtures.integrationsByPartner['owner'] = ownerInteg;
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', failure });
    handleRailFailure.mockResolvedValueOnce({ kind: 'failed', refundStarted: true });
    handleRailFailure.mockResolvedValueOnce({ kind: 'noop', refundStarted: false });
    expect((await post('simulator', failedBody, sig(failedBody, 'owner_whk'))).status).toBe(200);
    expect((await post('simulator', failedBody, sig(failedBody, 'owner_whk'))).status).toBe(200);
    expect(handleRailFailure).toHaveBeenCalledTimes(2);
  });
});
