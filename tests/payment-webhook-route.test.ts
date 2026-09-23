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
  // text only if it throws (the recipient-delivery resilience under test), and
  // RETURN the outcome (Program-Fix 25 PR B) — never throw.
  sendTemplateOrText: async (to: string, send: () => Promise<void>, fallbackText: string, creds?: unknown) => {
    const { sendOutcomeFromError } = await vi.importActual<typeof import('@/lib/whatsapp-errors')>('@/lib/whatsapp-errors');
    try { await send(); return { ok: true, via: 'template' }; } catch { /* fall back */ }
    try { await sendText(to, fallbackText, creds); return { ok: true, via: 'text' }; } catch (e) { return sendOutcomeFromError(e); }
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
const alertCallbackOnHold = vi.fn(async (..._a: unknown[]) => false);
vi.mock('@/lib/rail-failure', () => ({
  handleRailFailure: (...a: unknown[]) => handleRailFailure(...a),
  alertRefusedDelivery: (...a: unknown[]) => alertRefusedDelivery(...a),
  alertCallbackOnHold: (...a: unknown[]) => alertCallbackOnHold(...a),
}));

// fix 29: the replay guard (check-then-mark) is unit-tested in
// tests/rail-replay.test.ts; here an in-memory set pins the route's ORDER.
const replay = vi.hoisted(() => ({ marked: new Set<string>(), state: null as null | 'unavailable', markCalls: 0 }));
vi.mock('@/lib/rail-replay', () => ({
  railNonceSeen: async (n: string) => replay.state ?? (replay.marked.has(n) ? 'seen' : 'fresh'),
  markRailNonce: async (n: string) => { replay.markCalls++; replay.marked.add(n); },
}));
// fix 29: the held-row marker + the mismatch alert go through the outbox repo.
const outboxFake = vi.hoisted(() => ({ keys: new Set<string>(), enqueued: [] as Array<{ kind: string; payload: unknown; dedupeKey?: string }> }));
vi.mock('@/db/repos/outbox-repo', () => ({
  createOutboxRepo: () => ({
    hasDedupeKey: async (k: string) => outboxFake.keys.has(k),
    enqueue: async (kind: string, payload: unknown, opts: { dedupeKey?: string } = {}) => {
      if (opts.dedupeKey && outboxFake.keys.has(opts.dedupeKey)) return false;
      if (opts.dedupeKey) outboxFake.keys.add(opts.dedupeKey);
      outboxFake.enqueued.push({ kind, payload, dedupeKey: opts.dedupeKey });
      return true;
    },
  }),
}));
const logWarnSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/log', async (orig) => {
  const real = await orig<typeof import('@/lib/log')>();
  return { ...real, logWarn: (...a: unknown[]) => { logWarnSpy(...a); } };
});

import { POST } from '@/app/api/payment-webhook/[provider]/route';
import { WhatsAppSendError } from '@/lib/whatsapp-errors';

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

function post(provider: string, raw: string, signature?: string, extra: Record<string, string> = {}) {
  const req = new NextRequest('https://x/api/payment-webhook/' + provider, {
    method: 'POST', body: raw,
    headers: { ...(signature ? { 'x-signature': signature } : {}), ...extra },
  });
  return POST(req, { params: Promise.resolve({ provider }) });
}
/** fix 29: the v2 header, built straight from the documented recipe (not via signRailHeaders). */
const v2 = (b: string, s = SECRET, t = Math.floor(Date.now() / 1000)) =>
  ({ 'x-smartremit-signature': `t=${t},v1=${createHmac('sha256', s).update(`${t}.${b}`).digest('hex')}` });

beforeEach(() => {
  sendText.mockClear(); sendTemplate.mockClear();
  updateTransferFromWebhook.mockReset(); handleWebhook.mockReset();
  handleRailFailure.mockClear(); alertRefusedDelivery.mockClear(); alertCallbackOnHold.mockClear();
  fixtures.transfersById = {};
  fixtures.integrationsByPartner = {};
  fixtures.getPaymentProviderCalls.length = 0;
  afterPending.length = 0; // never leak an unflushed after() into the next test
  process.env.PAYMENT_WEBHOOK_SECRET_UNITELLER = SECRET;
  delete process.env.PAYMENT_WEBHOOK_SECRET_UNITELLER_PREVIOUS;
  replay.marked.clear(); replay.state = null; replay.markCalls = 0;
  outboxFake.keys.clear(); outboxFake.enqueued.length = 0;
  logWarnSpy.mockClear();
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

  it('compliance holds: a refused paid / delivered update checks the row for a hold and answers the usual 200 { ok: true }', async () => {
    for (const status of ['paid', 'delivered'] as const) {
      alertCallbackOnHold.mockClear();
      handleWebhook.mockResolvedValue({ transferId: 'wh_1', status });
      updateTransferFromWebhook.mockResolvedValue(null); // the guarded UPDATE did not advance the row
      const res = await post('uniteller', body, sig(body));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      await flushAfter();
      expect(alertCallbackOnHold).toHaveBeenCalledTimes(1);
      expect(alertCallbackOnHold.mock.calls[0][1]).toBe('wh_1');
    }
    expect(sendText).not.toHaveBeenCalled();
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('compliance holds: a REAL transition, or a refused non-advancing status, never checks for a hold', async () => {
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', status: 'delivered' });
    updateTransferFromWebhook.mockResolvedValue(deliveredTransfer);
    expect((await post('uniteller', body, sig(body))).status).toBe(200);
    await flushAfter();
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', status: 'awaiting_payment' });
    updateTransferFromWebhook.mockResolvedValue(null); // a `created` callback
    expect((await post('uniteller', body, sig(body))).status).toBe(200);
    expect(alertCallbackOnHold).not.toHaveBeenCalled();
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

  it('fix 29 (authz-08): the /mock segment no longer skips verification — unsigned → 401, nothing parsed', async () => {
    handleWebhook.mockResolvedValue(null);
    const res = await post('mock', body); // no signature header
    expect(res.status).toBe(401);
    expect(handleWebhook).not.toHaveBeenCalled();
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

  it('an UNSIGNED failure to /mock for a MOCK-rail transfer → 401 (fix 29, authz-08): nothing is parsed, the row is untouched', async () => {
    fixtures.transfersById['wh_1'] = paidTransfer;
    fixtures.integrationsByPartner['owner'] = mockInteg;
    handleWebhook.mockResolvedValue(null);
    const res = await post('mock', failedBody);
    expect(res.status).toBe(401);
    expect(handleWebhook).not.toHaveBeenCalled();
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

// Program-Fix 29: timestamped signature, replay guard, rotation, amount check.
describe('POST /api/payment-webhook — rail signature v2 (fix 29)', () => {
  const paidOwner = { ...deliveredTransfer, status: 'paid', partnerId: 'owner', amountInr: 16600, destinationCurrency: 'INR' };
  const ownerInteg = { kyc: {}, payment: { providerType: 'simulator', webhookSecret: 'owner_whk' }, whatsapp: {} };
  const withAmount = (destination: unknown, cur = 'INR') =>
    JSON.stringify({ reference: 'wh_1', status: 'paid_out', amount: { destination, destination_currency: cur } });

  beforeEach(() => {
    fixtures.transfersById['wh_1'] = paidOwner;
    fixtures.integrationsByPartner['owner'] = ownerInteg;
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', status: 'delivered' });
    updateTransferFromWebhook.mockResolvedValue({ ...deliveredTransfer, partnerId: 'owner' });
  });

  it('a valid v2 header → 200, delivered, and the nonce is marked after success', async () => {
    const res = await post('simulator', body, undefined, v2(body, 'owner_whk'));
    expect(res.status).toBe(200);
    expect(updateTransferFromWebhook).toHaveBeenCalledWith('wh_1', 'delivered');
    expect(replay.markCalls).toBe(1);
  });

  it('a stale v2 timestamp → 401, nothing parsed', async () => {
    const stale = Math.floor(Date.now() / 1000) - 3600;
    const res = await post('simulator', body, undefined, v2(body, 'owner_whk', stale));
    expect(res.status).toBe(401);
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  it('a bad v2 header next to a VALID legacy header → 401 (the new header decides alone)', async () => {
    const res = await post('simulator', body, sig(body, 'owner_whk'), { 'x-smartremit-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` });
    expect(res.status).toBe(401);
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  it('legacy-only header → 200 with a deprecation log that names the rail partner', async () => {
    const res = await post('simulator', body, sig(body, 'owner_whk'));
    expect(res.status).toBe(200);
    const call = logWarnSpy.mock.calls.find((c) => c[0] === 'rail-sig.legacy');
    expect(call?.[2]).toMatchObject({ partnerId: 'owner' });
    expect(replay.markCalls).toBe(0); // legacy carries no nonce
  });

  it('the same v2 message again → 200 duplicate, NO handling', async () => {
    const h = v2(body, 'owner_whk');
    expect((await post('simulator', body, undefined, h)).status).toBe(200);
    handleWebhook.mockClear(); updateTransferFromWebhook.mockClear();
    const res = await post('simulator', body, undefined, h);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, duplicate: true });
    expect(handleWebhook).not.toHaveBeenCalled();
    expect(updateTransferFromWebhook).not.toHaveBeenCalled();
  });

  it('Redis unavailable → fail-open: the signed request is handled', async () => {
    replay.state = 'unavailable';
    const res = await post('simulator', body, undefined, v2(body, 'owner_whk'));
    expect(res.status).toBe(200);
    expect(updateTransferFromWebhook).toHaveBeenCalledTimes(1);
  });

  it('a handler throw rethrows and leaves NO mark, so the retry is handled', async () => {
    const failedBody = JSON.stringify({ reference: 'wh_1', status: 'failed' });
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', failure: { code: 'failed', reason: 'unspecified' } });
    handleRailFailure.mockRejectedValueOnce(new Error('db down'));
    const h = v2(failedBody, 'owner_whk');
    await expect(post('simulator', failedBody, undefined, h)).rejects.toThrow('db down');
    expect(replay.markCalls).toBe(0);
    expect((await post('simulator', failedBody, undefined, h)).status).toBe(200);
    expect(handleRailFailure).toHaveBeenCalledTimes(2);
    expect(replay.markCalls).toBe(1);
  });

  it('rotation: a v1 made with the unexpired PREVIOUS webhook secret verifies', async () => {
    fixtures.integrationsByPartner['owner'] = {
      ...ownerInteg,
      payment: {
        ...ownerInteg.payment,
        credentials: { previousWebhookSecret: 'old_whk', previousWebhookSecretUntil: new Date(Date.now() + 86_400_000).toISOString() },
      },
    };
    expect((await post('simulator', body, undefined, v2(body, 'old_whk'))).status).toBe(200);
  });

  it('rotation (env): PAYMENT_WEBHOOK_SECRET_<P>_PREVIOUS also verifies when no partner secret applies', async () => {
    delete fixtures.transfersById['wh_1'];
    process.env.PAYMENT_WEBHOOK_SECRET_UNITELLER_PREVIOUS = 'uni_old';
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', status: 'delivered' });
    updateTransferFromWebhook.mockResolvedValue(deliveredTransfer);
    expect((await post('uniteller', body, sig(body, 'uni_old'))).status).toBe(200);
    expect((await post('uniteller', body, undefined, v2(body, 'uni_old'))).status).toBe(200);
  });

  it('matching amount (number or numeric string) → delivered', async () => {
    const a = withAmount('16600.00');
    expect((await post('simulator', a, undefined, v2(a, 'owner_whk'))).status).toBe(200);
    expect(updateTransferFromWebhook).toHaveBeenCalledWith('wh_1', 'delivered');
    expect(outboxFake.enqueued).toEqual([]);
  });

  it('absent amount → delivered with a deprecation log', async () => {
    expect((await post('simulator', body, undefined, v2(body, 'owner_whk'))).status).toBe(200);
    expect(updateTransferFromWebhook).toHaveBeenCalledTimes(1);
    expect(logWarnSpy.mock.calls.some((c) => c[0] === 'payment-webhook.amount_absent')).toBe(true);
  });

  it('MISMATCH → never delivered: 200 held, ONE railamount:<id> ops alert (id only), nonce marked', async () => {
    const a = withAmount(99999);
    const res = await post('simulator', a, undefined, v2(a, 'owner_whk'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, held: true });
    expect(updateTransferFromWebhook).not.toHaveBeenCalled();
    expect(outboxFake.enqueued).toHaveLength(1);
    expect(outboxFake.enqueued[0]).toMatchObject({ kind: 'ops.alert', dedupeKey: 'railamount:wh_1' });
    const msg = String((outboxFake.enqueued[0].payload as { message: string }).message);
    expect(msg).toContain('wh_1');
    expect(msg).not.toContain('99999');
    expect(msg).not.toContain('919876543210');
    expect(replay.markCalls).toBe(1);
    await flushAfter();
    expect(sendText).not.toHaveBeenCalled();
  });

  it('a held row + a later MATCHING paid_out → stays paid (no update), no stage-2 message', async () => {
    const bad = withAmount(99999);
    await post('simulator', bad, undefined, v2(bad, 'owner_whk'));
    const good = withAmount(16600);
    const res = await post('simulator', good, undefined, v2(good, 'owner_whk'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, held: true });
    expect(updateTransferFromWebhook).not.toHaveBeenCalled();
    await flushAfter();
    expect(sendText).not.toHaveBeenCalled();
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(outboxFake.enqueued).toHaveLength(1); // the alert fired once
  });

  it('a held row still accepts a signed FAILURE (the resolution path is cancel/refund)', async () => {
    outboxFake.keys.add('railamount:wh_1');
    const failedBody = JSON.stringify({ reference: 'wh_1', status: 'failed' });
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', failure: { code: 'failed', reason: 'unspecified' } });
    expect((await post('simulator', failedBody, undefined, v2(failedBody, 'owner_whk'))).status).toBe(200);
    expect(handleRailFailure).toHaveBeenCalledTimes(1);
  });
});

// Program-Fix 25 PR B (§3.7): the delivered notice is no longer silent on
// failure. A failed send enqueues ONE deduped ops alert per transfer — except
// 131030 (the sandbox allow-list), which fires on every demo delivery.
describe('POST /api/payment-webhook — delivered-notice honesty (Program-Fix 25 PR B)', { retry: 0 }, () => {
  const graphErr = (code: number) =>
    WhatsAppSendError.fromResponse('WhatsApp send failed', 400, JSON.stringify({ error: { message: `(#${code}) x`, code } }));
  const notifyAlerts = () => outboxFake.enqueued.filter((e) => e.dedupeKey?.startsWith('notifyfail:'));

  beforeEach(() => {
    sendText.mockReset().mockResolvedValue(undefined);
    sendTemplate.mockReset().mockResolvedValue(undefined);
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', status: 'delivered' });
    updateTransferFromWebhook.mockResolvedValue(deliveredTransfer);
  });

  it('both sends succeed → no alert', async () => {
    await post('uniteller', body, sig(body));
    await flushAfter();
    expect(notifyAlerts()).toEqual([]);
  });

  it('131030 on the recipient template AND fallback → logged only, no ops alert', async () => {
    sendTemplate.mockRejectedValueOnce(graphErr(131030));
    sendText.mockResolvedValueOnce(undefined).mockRejectedValueOnce(graphErr(131030));
    await post('uniteller', body, sig(body));
    await flushAfter();
    expect(notifyAlerts()).toEqual([]);
  });

  it('132001 template + a failing fallback → exactly one notifyfail:<code>:<hour> alert naming the transfer (no PII)', async () => {
    sendTemplate.mockRejectedValueOnce(graphErr(132001));
    sendText.mockResolvedValueOnce(undefined).mockRejectedValueOnce(graphErr(132001));
    await post('uniteller', body, sig(body));
    await flushAfter();
    const a = notifyAlerts();
    expect(a).toHaveLength(1);
    expect(a[0].kind).toBe('ops.alert');
    expect(a[0].dedupeKey).toMatch(/^notifyfail:132001:\d+$/);
    const msg = (a[0].payload as { message: string }).message;
    expect(msg).toContain('wh_1');
    expect(msg).toContain('#132001');
    expect(msg).not.toMatch(/\d{7,}/); // no phone number
    expect(msg).not.toContain('Mom');
  });

  // Review r1: on a production number the notice often hits 131047 (window
  // closed). Coalesce per code per hour so a real outage still alerts ONCE.
  it('two transfers failing with the same code in one hour → ONE alert; another code → its own', async () => {
    const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(hour + 30 * 60_000); // mid-hour: never straddles a bucket boundary
    try {
      sendText.mockRejectedValueOnce(graphErr(131047));
      await post('uniteller', body, sig(body));
      await flushAfter();
      sendText.mockRejectedValueOnce(graphErr(131047));
      updateTransferFromWebhook.mockResolvedValueOnce({ ...deliveredTransfer, id: 'wh_9' });
      await post('uniteller', body, sig(body));
      await flushAfter();
      expect(notifyAlerts()).toHaveLength(1);
      expect((notifyAlerts()[0].payload as { message: string }).message).toContain('wh_1');
      sendText.mockRejectedValueOnce(new Error('network down')); // no Graph code
      await post('uniteller', body, sig(body));
      await flushAfter();
      expect(notifyAlerts().map((x) => x.dedupeKey!.replace(/:\d+$/, '')).sort()).toEqual([
        'notifyfail:131047',
        'notifyfail:none',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the SENDER notice throwing (non-131030) → one alert; a 131030 throw → none', async () => {
    sendText.mockRejectedValueOnce(graphErr(131026));
    await post('uniteller', body, sig(body));
    await flushAfter();
    expect(notifyAlerts()).toHaveLength(1);

    outboxFake.keys.clear(); outboxFake.enqueued.length = 0;
    sendText.mockRejectedValueOnce(graphErr(131030));
    await post('uniteller', body, sig(body));
    await flushAfter();
    expect(notifyAlerts()).toEqual([]);
  });
});
