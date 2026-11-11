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

// In-memory store double + a controllable handleWebhook. The base fixture is
// ONE paid wh_1 (16600 INR, no partnerId) and no integrations (fix pack 5 T3:
// a paid_out must name a transfer and report its amount): with no rail partner
// resolved, verification still falls through to the env per-provider secret.
// Routed tests set fixtures per test.
const fixtures = vi.hoisted(() => ({
  transfersById: {} as Record<string, unknown>,
  integrationsByPartner: {} as Record<string, unknown>,
  getPaymentProviderCalls: [] as unknown[][],
}));
const updateTransferFromWebhook = vi.fn();
const handleWebhook = vi.fn();
// The sender's 24-hour window marker (2026-10-03): present by default, so the
// delivered notice is the plain text as before; a test sets null for "outside".
const windowMarker = { value: '2026-10-03T00:00:00.000Z' as string | null };
vi.mock('@/lib/store', () => ({
  getStore: () => ({
    updateTransferFromWebhook,
    getTransfer: async (id: string) => fixtures.transfersById[id] ?? null,
    getLastInboundAt: async () => windowMarker.value,
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
// Batch B1: the payout reference is saved through the transfer repo (write-once).
const setPayoutReference = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => true));
vi.mock('@/db/repos/transfer-repo', () => ({
  createTransferRepo: () => ({ setPayoutReference: (...a: unknown[]) => setPayoutReference(...a) }),
}));
// Pack 3: the rail-callback live gate reads the RAIL partner from the DB (createPartnerRepo);
// per test, a Partner fake (certified or not) by id. Unset ⇒ no row (not certified).
const partnersById = vi.hoisted(() => ({ map: {} as Record<string, unknown> }));
vi.mock('@/db/repos/partner-repo', () => ({
  createPartnerRepo: () => ({ getPartner: async (id: string) => partnersById.map[id] ?? null }),
}));
const logWarnSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/log', async (orig) => {
  const real = await orig<typeof import('@/lib/log')>();
  return { ...real, logWarn: (...a: unknown[]) => { logWarnSpy(...a); } };
});

import { POST } from '@/app/api/payment-webhook/[provider]/route';
import { WhatsAppSendError } from '@/lib/whatsapp-errors';
import { SANCTIONS_FUNDS_RULE } from '@/lib/sanctions/notices';
import { certifiedLiveControls } from './helpers-live';

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
// Fix pack 5 T3: a paid_out carries the instructed amount (wh_1: 16600 INR).
const body = JSON.stringify({ reference: 'wh_1', status: 'paid_out', amount: { destination: 16600, destination_currency: 'INR' } });
const baseWh1 = { ...deliveredTransfer, status: 'paid', amountInr: 16600, destinationCurrency: 'INR' };
/**
 * Fix pack 5 T2: since a legacy-only callback is refused, `sig()` returns the
 * v2 header VALUE (`t=..,v1=..`, straight from the documented recipe) and
 * `post()` puts it into x-smartremit-signature. Each call signs with its own
 * timestamp (one second earlier than the last, well inside the ±300 s window),
 * as a rail re-signs every retry, so two posts of the same body are two
 * messages (two nonces), not a replay. `legacySig()` is the old body-only HMAC
 * for the cases that need a real legacy x-signature header.
 */
const sigClock = { back: 0 };
const sig = (b: string, s = SECRET) => {
  const t = Math.floor(Date.now() / 1000) - (sigClock.back++ % 200);
  return `t=${t},v1=${createHmac('sha256', s).update(`${t}.${b}`).digest('hex')}`;
};
const legacySig = (b: string, s = SECRET) => createHmac('sha256', s).update(b).digest('hex');

function post(provider: string, raw: string, signature?: string, extra: Record<string, string> = {}) {
  const req = new NextRequest('https://x/api/payment-webhook/' + provider, {
    method: 'POST', body: raw,
    headers: { ...(signature ? { 'x-smartremit-signature': signature } : {}), ...extra },
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
  fixtures.transfersById = { wh_1: baseWh1 };
  fixtures.integrationsByPartner = {};
  fixtures.getPaymentProviderCalls.length = 0;
  afterPending.length = 0; // never leak an unflushed after() into the next test
  process.env.PAYMENT_WEBHOOK_SECRET_UNITELLER = SECRET;
  delete process.env.PAYMENT_WEBHOOK_SECRET_UNITELLER_PREVIOUS;
  replay.marked.clear(); replay.state = null; replay.markCalls = 0; sigClock.back = 0;
  outboxFake.keys.clear(); outboxFake.enqueued.length = 0;
  logWarnSpy.mockClear();
  setPayoutReference.mockReset(); setPayoutReference.mockResolvedValue(true);
  partnersById.map = {};
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
    fixtures.transfersById.wh_2 = { ...deliveredGbp, status: 'paid' };
    const gbpBody = JSON.stringify({ reference: 'wh_2', status: 'paid_out', amount: { destination: 745, destination_currency: 'GBP' } });
    handleWebhook.mockResolvedValue({ transferId: 'wh_2', status: 'delivered' });
    updateTransferFromWebhook.mockResolvedValue(deliveredGbp);
    const res = await post('uniteller', gbpBody, sig(gbpBody));
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
    const res = await post('simulator', body, undefined, {
      'x-signature': legacySig(body, 'owner_whk'),
      'x-smartremit-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`,
    });
    expect(res.status).toBe(401);
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  // Fix pack 5 T2 (P6, P30): a legacy-only callback is refused with the same
  // bare 401; a genuine legacy HMAC raises one deduped raillegacy alert.
  const hour = () => Math.floor(Date.now() / 3_600_000);
  const legacyAlerts = () => outboxFake.enqueued.filter((e) => e.kind === 'ops.alert' && e.dedupeKey?.startsWith('raillegacy:'));

  it('legacy-only header with a VALID HMAC → 401 { ok: false }, handleWebhook never called, one ops.alert raillegacy:owner:<hour> naming only the rail partner, no nonce mark', async () => {
    const res = await post('simulator', body, undefined, { 'x-signature': legacySig(body, 'owner_whk') });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false });
    expect(handleWebhook).not.toHaveBeenCalled();
    expect(updateTransferFromWebhook).not.toHaveBeenCalled();
    const alerts = legacyAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].dedupeKey).toBe(`raillegacy:owner:${hour()}`);
    const message = (alerts[0].payload as { message: string }).message;
    expect(message).toBe(
      '⚠️ SmartRemit ops: a rail callback for rail partner owner was refused (401): it was signed only with the legacy x-signature header. Ask the rail partner to sign with x-smartremit-signature (see the webhooks docs); the rail keeps retrying until it does. Further refusals for this rail this hour are coalesced into this alert.',
    );
    expect(Object.keys(alerts[0].payload as object)).toEqual(['message']);
    expect(message).not.toContain('owner_whk');
    expect(message).not.toContain('wh_1');
    expect(replay.markCalls).toBe(0);
  });

  it('a second legacy-only callback in the same hour → still 401, still ONE alert', async () => {
    expect((await post('simulator', body, undefined, { 'x-signature': legacySig(body, 'owner_whk') })).status).toBe(401);
    expect((await post('simulator', body, undefined, { 'x-signature': legacySig(body, 'owner_whk') })).status).toBe(401);
    expect(legacyAlerts()).toHaveLength(1);
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  it('legacy-only with an INVALID HMAC → 401 and no alert', async () => {
    const res = await post('simulator', body, undefined, { 'x-signature': legacySig(body, 'not-the-secret') });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false });
    expect(outboxFake.enqueued).toHaveLength(0);
  });

  it('legacy-only on an unresolved reference verified against the env secret → raillegacy:unresolved:<hour>', async () => {
    const ghost = JSON.stringify({ reference: 'tr_unknown', status: 'paid_out' });
    const res = await post('uniteller', ghost, undefined, { 'x-signature': legacySig(ghost, SECRET) });
    expect(res.status).toBe(401);
    const alerts = legacyAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].dedupeKey).toBe(`raillegacy:unresolved:${hour()}`);
    expect((alerts[0].payload as { message: string }).message).toContain('for rail partner unresolved was refused');
  });

  it('a failing alert write is best-effort: still the same 401, logged by error name only', async () => {
    const spy = vi.spyOn(outboxFake.keys, 'has').mockImplementation(() => {
      throw new TypeError('redis exploded with a secret');
    });
    try {
      const res = await post('simulator', body, undefined, { 'x-signature': legacySig(body, 'owner_whk') });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false });
    } finally {
      spy.mockRestore();
    }
    const call = logWarnSpy.mock.calls.find((c) => c[0] === 'payment-webhook.raillegacy');
    expect(call?.[1]).toBe('TypeError');
    expect(call?.[2]).toEqual({ partnerId: 'owner' });
  });

  it('every refusal logs rail-sig.refused with { reason, partnerId, route: payment-webhook } and never the body or a header value', async () => {
    const stale = Math.floor(Date.now() / 1000) - 3600;
    const staleHeader = v2(body, 'owner_whk', stale);
    const legacy = legacySig(body, 'owner_whk');
    expect((await post('simulator', body)).status).toBe(401);
    expect((await post('simulator', body, undefined, staleHeader)).status).toBe(401);
    expect((await post('simulator', body, undefined, { 'x-signature': legacy })).status).toBe(401);
    const refused = logWarnSpy.mock.calls.filter((c) => c[0] === 'rail-sig.refused');
    expect(refused.map((c) => c[2])).toEqual([
      { reason: 'missing', partnerId: 'owner', route: 'payment-webhook' },
      { reason: 'stale', partnerId: 'owner', route: 'payment-webhook' },
      { reason: 'legacy_rejected', partnerId: 'owner', route: 'payment-webhook' },
    ]);
    const logged = JSON.stringify(logWarnSpy.mock.calls);
    for (const secretish of [body, legacy, staleHeader['x-smartremit-signature'], 'owner_whk', 'paid_out']) {
      expect(logged).not.toContain(secretish);
    }
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
    // No rail partner on the row (fix pack 5 T3: the reference must still resolve) ⇒ env secrets.
    fixtures.transfersById['wh_1'] = baseWh1;
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

  // Fix pack 5 T3 (P6, P30): a paid_out must report the instructed amount and
  // name the transfer it is about; otherwise 422 and nothing applies.
  const noAmount = JSON.stringify({ reference: 'wh_1', status: 'paid_out' });
  const noAmountAlerts = () => outboxFake.enqueued.filter((e) => e.kind === 'ops.alert' && e.dedupeKey?.startsWith('railnoamount:'));

  it('paid_out with NO amount → 422 amount_required; not delivered, no payout reference saved, ONE ops.alert railnoamount:owner:<hour> (ids only), nonce NOT marked', async () => {
    const raw = JSON.stringify({ reference: 'wh_1', status: 'paid_out', payout_reference: 'UTR-NOAMT-1' });
    const res = await post('simulator', raw, undefined, v2(raw, 'owner_whk'));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: 'amount_required' });
    expect(updateTransferFromWebhook).not.toHaveBeenCalled();
    expect(setPayoutReference).not.toHaveBeenCalled();
    const alerts = noAmountAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].dedupeKey).toBe(`railnoamount:owner:${hour()}`);
    expect(Object.keys(alerts[0].payload as object)).toEqual(['message']);
    expect((alerts[0].payload as { message: string }).message).toBe(
      '⚠️ SmartRemit ops: a paid_out callback from rail partner owner for transfer wh_1 was refused (422 amount_required): it carried no amount block, so the transfer was not marked delivered. Ask the rail partner to report amount.destination and amount.destination_currency (see the webhooks docs); the rail keeps retrying until it does. Further refusals for this rail this hour are coalesced into this alert.',
    );
    expect(replay.markCalls).toBe(0);
    expect(logWarnSpy.mock.calls.some((c) => c[0] === 'payment-webhook.amount_missing')).toBe(true);
    const logged = JSON.stringify(logWarnSpy.mock.calls);
    for (const pii of ['15551230000', '919876543210', 'Mom', 'UTR-NOAMT-1']) expect(logged).not.toContain(pii);
    await flushAfter();
    expect(sendText).not.toHaveBeenCalled();
  });

  it('the same amount-less message retried after a 422 is handled again (not taken for a duplicate)', async () => {
    const h = v2(noAmount, 'owner_whk');
    expect((await post('simulator', noAmount, undefined, h)).status).toBe(422);
    expect((await post('simulator', noAmount, undefined, h)).status).toBe(422);
    expect(handleWebhook).toHaveBeenCalledTimes(2);
  });

  it('a second amount-less paid_out in the hour → 422 again, still one alert', async () => {
    expect((await post('simulator', noAmount, undefined, v2(noAmount, 'owner_whk'))).status).toBe(422);
    expect((await post('simulator', noAmount, sig(noAmount, 'owner_whk'))).status).toBe(422);
    expect(noAmountAlerts()).toHaveLength(1);
    expect(updateTransferFromWebhook).not.toHaveBeenCalled();
  });

  it('paid_out whose result.transferId differs from the referenced transfer → 422 reference_unresolved, ids-only log, no alert, nothing applied', async () => {
    handleWebhook.mockResolvedValue({ transferId: 'wh_9', status: 'delivered' });
    const a = withAmount(16600);
    const res = await post('simulator', a, undefined, v2(a, 'owner_whk'));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: 'reference_unresolved' });
    expect(updateTransferFromWebhook).not.toHaveBeenCalled();
    expect(setPayoutReference).not.toHaveBeenCalled();
    expect(outboxFake.enqueued).toEqual([]);
    expect(replay.markCalls).toBe(0);
    const call = logWarnSpy.mock.calls.find((c) => c[0] === 'payment-webhook.reference_unresolved');
    expect(call?.[2]).toEqual({ transferId: 'wh_9', refTransferId: 'wh_1', partnerId: 'owner', provider: 'simulator' });
  });

  it('paid_out with no resolvable transfer (env-secret path) → 422 reference_unresolved', async () => {
    const ghost = JSON.stringify({ reference: 'tr_unknown', status: 'paid_out', amount: { destination: 16600, destination_currency: 'INR' } });
    handleWebhook.mockResolvedValue({ transferId: 'tr_unknown', status: 'delivered' });
    const res = await post('uniteller', ghost, sig(ghost, SECRET));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: 'reference_unresolved' });
    expect(updateTransferFromWebhook).not.toHaveBeenCalled();
    expect(outboxFake.enqueued).toEqual([]);
    const call = logWarnSpy.mock.calls.find((c) => c[0] === 'payment-webhook.reference_unresolved');
    expect(call?.[2]).toEqual({ transferId: 'tr_unknown', refTransferId: null, partnerId: null, provider: 'uniteller' });
  });

  it('the railamount: hold still answers 200 held first (marker + no amount → 200 held, no railnoamount alert)', async () => {
    outboxFake.keys.add('railamount:wh_1');
    const res = await post('simulator', noAmount, undefined, v2(noAmount, 'owner_whk'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, held: true });
    expect(noAmountAlerts()).toHaveLength(0);
    expect(updateTransferFromWebhook).not.toHaveBeenCalled();
  });

  it('a failed callback without an amount is still acted on (handleRailFailure, 200)', async () => {
    const failedBody = JSON.stringify({ reference: 'wh_1', status: 'failed' });
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', failure: { code: 'failed', reason: 'unspecified' } });
    const res = await post('simulator', failedBody, undefined, v2(failedBody, 'owner_whk'));
    expect(res.status).toBe(200);
    expect(handleRailFailure).toHaveBeenCalledTimes(1);
    expect(noAmountAlerts()).toHaveLength(0);
  });

  it('a paid (funded) callback without an amount is unchanged', async () => {
    const funded = JSON.stringify({ reference: 'wh_1', status: 'funded' });
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', status: 'paid' });
    updateTransferFromWebhook.mockResolvedValue({ ...paidOwner });
    const res = await post('simulator', funded, undefined, v2(funded, 'owner_whk'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(updateTransferFromWebhook).toHaveBeenCalledWith('wh_1', 'paid');
    expect(noAmountAlerts()).toHaveLength(0);
    expect(replay.markCalls).toBe(1);
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

  // Review S5 (inventory): the railamount text by the row's compliance status.
  it('S5: MISMATCH on an unblocked row keeps "Investigate with the rail, then cancel/refund it."', async () => {
    const a = withAmount(99999);
    await post('simulator', a, undefined, v2(a, 'owner_whk'));
    expect((outboxFake.enqueued[0].payload as { message: string }).message).toBe(
      "⚠️ SmartRemit ops: transfer wh_1 — the rail's paid_out reported a different amount than the settlement instruction. " +
        'NOT delivered; held (stays paid, never re-instructed). Investigate with the rail, then cancel/refund it.',
    );
  });

  it('S5: MISMATCH on a sanctions-BLOCKED row: the railamount alert has the no-refund rule, never "cancel/refund it"', async () => {
    fixtures.transfersById['wh_1'] = { ...paidOwner, complianceStatus: 'blocked' };
    const a = withAmount(99999);
    await post('simulator', a, undefined, v2(a, 'owner_whk'));
    expect(outboxFake.enqueued).toHaveLength(1);
    expect(outboxFake.enqueued[0]).toMatchObject({ kind: 'ops.alert', dedupeKey: 'railamount:wh_1' });
    expect((outboxFake.enqueued[0].payload as { message: string }).message).toBe(
      "⚠️ SmartRemit ops: transfer wh_1 — the rail's paid_out reported a different amount than the settlement instruction. " +
        `NOT delivered; held (stays paid, never re-instructed). It is blocked by sanctions screening: investigate with the rail, and ${SANCTIONS_FUNDS_RULE}.`,
    );
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

  // Review r1: coalesce per code per hour so a real outage still alerts ONCE.
  // (Since 2026-10-03 a 131047 window-closed refusal no longer fails the notice:
  // it is retried as the approved template, pinned below. 131026 stands in for a
  // code that still fails it.)
  it('two transfers failing with the same code in one hour → ONE alert; another code → its own', async () => {
    const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(hour + 30 * 60_000); // mid-hour: never straddles a bucket boundary
    try {
      sendText.mockRejectedValueOnce(graphErr(131026));
      await post('uniteller', body, sig(body));
      await flushAfter();
      sendText.mockRejectedValueOnce(graphErr(131026));
      updateTransferFromWebhook.mockResolvedValueOnce({ ...deliveredTransfer, id: 'wh_9' });
      await post('uniteller', body, sig(body));
      await flushAfter();
      expect(notifyAlerts()).toHaveLength(1);
      expect((notifyAlerts()[0].payload as { message: string }).message).toContain('wh_1');
      sendText.mockRejectedValueOnce(new Error('network down')); // no Graph code
      await post('uniteller', body, sig(body));
      await flushAfter();
      expect(notifyAlerts().map((x) => x.dedupeKey!.replace(/:\d+$/, '')).sort()).toEqual([
        'notifyfail:131026',
        'notifyfail:none',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('2026-10-03: a sender outside the 24-hour window gets the transfer_delivered_sender template, no alert', async () => {
    windowMarker.value = null;
    try {
      await post('uniteller', body, sig(body));
      await flushAfter();
      const names = sendTemplate.mock.calls.map((c) => (c as unknown[])[1]);
      expect(names).toContain('transfer_delivered_sender');
      expect(notifyAlerts()).toEqual([]);
    } finally {
      windowMarker.value = '2026-10-03T00:00:00.000Z';
    }
  });

  it('2026-10-03: inside the window, a 131047 refusal + an unapproved template (132001) → the alert names the WINDOW code', async () => {
    sendText.mockRejectedValueOnce(graphErr(131047));
    sendTemplate.mockRejectedValueOnce(graphErr(132001));
    await post('uniteller', body, sig(body));
    await flushAfter();
    const a = notifyAlerts();
    expect(a).toHaveLength(1);
    expect(a[0].dedupeKey).toMatch(/^notifyfail:131047:\d+$/);
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

// Program-Fix 44 P2: a sandbox transfer never messages a real phone.
describe('POST /api/payment-webhook/[provider] — sandbox (Program-Fix 44 P2)', { retry: 0 }, () => {
  it('Program-Fix 44 P2: a delivered SANDBOX transfer is updated but messages NO ONE', async () => {
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', status: 'delivered' });
    updateTransferFromWebhook.mockResolvedValue({ ...deliveredTransfer, environment: 'test' });
    const res = await post('uniteller', body, sig(body));
    expect(res.status).toBe(200);
    await flushAfter();
    expect(updateTransferFromWebhook).toHaveBeenCalledWith('wh_1', 'delivered');
    expect(sendText).not.toHaveBeenCalled();
    expect(sendTemplate).not.toHaveBeenCalled();
  });
});

describe('POST /api/payment-webhook — payout reference (Batch B1)', { retry: 0 }, () => {
  // Fix pack 5 T3: a paid_out carries its amount (a missing one is refused before the save).
  const withRef = (ref: unknown, status = 'paid_out') =>
    JSON.stringify({ reference: 'wh_1', status, payout_reference: ref, amount: { destination: 16600, destination_currency: 'INR' } });

  it('a SIGNED paid_out with a payout_reference saves it once, before the status update', async () => {
    const order: string[] = [];
    setPayoutReference.mockImplementation(async () => { order.push('ref'); return true; });
    updateTransferFromWebhook.mockImplementation(async () => { order.push('status'); return deliveredTransfer; });
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', status: 'delivered' });
    const raw = withRef('HDFCR52026100812345678');
    expect((await post('uniteller', raw, sig(raw))).status).toBe(200);
    await flushAfter();
    expect(setPayoutReference).toHaveBeenCalledTimes(1);
    expect(setPayoutReference).toHaveBeenCalledWith('wh_1', 'HDFCR52026100812345678');
    expect(order).toEqual(['ref', 'status']);
  });

  it('only a paid_out that will be applied saves it: a funded callback and a signed failure save nothing', async () => {
    // the reference is write-once, so an early status must never take the slot of the real UTR
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', status: 'paid' });
    updateTransferFromWebhook.mockResolvedValue(null);
    const funded = withRef('UTR-1', 'funded');
    expect((await post('uniteller', funded, sig(funded))).status).toBe(200);
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', failure: { code: 'failed', reason: 'unspecified' } });
    const failed = withRef('UTR-2', 'failed');
    expect((await post('uniteller', failed, sig(failed))).status).toBe(200);
    expect(setPayoutReference).not.toHaveBeenCalled();
  });

  it('a callback WITHOUT a valid signature never saves a payout reference', async () => {
    const raw = withRef('UTR-EVIL');
    expect((await post('uniteller', raw, 'deadbeef')).status).toBe(401);
    expect((await post('uniteller', raw)).status).toBe(401);
    expect(setPayoutReference).not.toHaveBeenCalled();
  });

  it('a bad payout_reference is ignored and the status still applies', async () => {
    for (const bad of ['has space', 'x'.repeat(65), 42, { a: 1 }, '']) {
      handleWebhook.mockResolvedValue({ transferId: 'wh_1', status: 'delivered' });
      updateTransferFromWebhook.mockResolvedValue(deliveredTransfer);
      const raw = withRef(bad);
      expect((await post('uniteller', raw, sig(raw))).status, JSON.stringify(bad)).toBe(200);
      await flushAfter();
    }
    expect(setPayoutReference).not.toHaveBeenCalled();
    expect(updateTransferFromWebhook).toHaveBeenCalledTimes(5);
  });

  it('a failure while saving the reference is logged and the status still applies', async () => {
    setPayoutReference.mockRejectedValue(new Error('db down'));
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', status: 'delivered' });
    updateTransferFromWebhook.mockResolvedValue(deliveredTransfer);
    const raw = withRef('UTR-3');
    expect((await post('uniteller', raw, sig(raw))).status).toBe(200);
    await flushAfter();
    expect(updateTransferFromWebhook).toHaveBeenCalledWith('wh_1', 'delivered');
    expect(logWarnSpy.mock.calls.some((c) => c[0] === 'payment-webhook.payout_reference')).toBe(true);
  });

  it('an ignored callback (handleWebhook → null) saves nothing', async () => {
    handleWebhook.mockResolvedValue(null);
    const raw = withRef('UTR-4', 'weird');
    expect((await post('uniteller', raw, sig(raw))).status).toBe(200);
    expect(setPayoutReference).not.toHaveBeenCalled();
  });
});

// Pack 3 (contract 6, critic M1): a signed funded / paid_out on an awaiting_payment row whose rail
// is real money (http, not sandbox) and not certified — or whose owner is the default tenant — is
// NOT applied: 200 { ok: true, held: true } so the rail stops retrying, one deduped livegate:<id>
// ops alert naming only ids. A paid row's paid_out, and simulator / mock / sandbox callbacks,
// apply as before.
describe('rail callback on an uncertified real-money rail (pack 3)', { retry: 0 }, () => {
  const HTTP_INTEG = {
    kyc: {},
    payment: { providerType: 'http', webhookSecret: 'rail_whk', credentials: { settlementUrl: 'https://rail.acme-test.com/settle', signingSecret: 's' } },
    whatsapp: {},
  };
  const awaiting = (o: Record<string, unknown> = {}) => ({
    ...deliveredTransfer, status: 'awaiting_payment', partnerId: 'acme', environment: 'live', ...o,
  });
  const partnerFake = (id: string, certified: boolean) => ({
    id, name: id, status: 'active', countries: ['US'],
    liveControls: certified ? certifiedLiveControls() : { optIns: {}, complianceUsers: [] },
  });
  const funded = JSON.stringify({ reference: 'wh_1', status: 'funded' });
  const paidOut = JSON.stringify({ reference: 'wh_1', status: 'paid_out', payout_reference: 'UTR-LIVE-1', amount: { destination: 16600, destination_currency: 'INR' } });
  const liveAlerts = () => outboxFake.enqueued.filter((e) => e.dedupeKey === 'livegate:wh_1');

  it('signed funded on an uncertified http rail\'s awaiting_payment row -> 200 { ok: true, held: true }, updateTransferFromWebhook never called, one ops.alert livegate:<id> naming only ids', async () => {
    fixtures.transfersById['wh_1'] = awaiting();
    fixtures.integrationsByPartner['acme'] = HTTP_INTEG;
    partnersById.map.acme = partnerFake('acme', false);
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', status: 'paid' });
    const res = await post('http', funded, sig(funded, 'rail_whk'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, held: true });
    expect(updateTransferFromWebhook).not.toHaveBeenCalled();
    const alerts = liveAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe('ops.alert');
    const msg = (alerts[0].payload as { message: string }).message;
    expect(msg).toContain('wh_1');
    expect(msg).toContain('acme');
    expect(msg).not.toContain('15551230000');
    expect(msg).not.toContain('919876543210');
    expect(msg).not.toContain('Mom');
    // A replay of the same callback is deduped: still one alert.
    expect((await post('http', funded, sig(funded, 'rail_whk'))).status).toBe(200);
    expect(liveAlerts()).toHaveLength(1);
  });

  it('signed paid_out on the same row -> held, no savePayoutReference, no stage-2 notice', async () => {
    fixtures.transfersById['wh_1'] = awaiting();
    fixtures.integrationsByPartner['acme'] = HTTP_INTEG;
    partnersById.map.acme = partnerFake('acme', false);
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', status: 'delivered' });
    const res = await post('http', paidOut, sig(paidOut, 'rail_whk'));
    expect(await res.json()).toEqual({ ok: true, held: true });
    await flushAfter();
    expect(setPayoutReference).not.toHaveBeenCalled();
    expect(updateTransferFromWebhook).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(liveAlerts()).toHaveLength(1);
  });

  it('certified rail -> applied as before', async () => {
    fixtures.transfersById['wh_1'] = awaiting();
    fixtures.integrationsByPartner['acme'] = HTTP_INTEG;
    partnersById.map.acme = partnerFake('acme', true);
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', status: 'paid' });
    updateTransferFromWebhook.mockResolvedValue({ ...awaiting(), status: 'paid' });
    const res = await post('http', funded, sig(funded, 'rail_whk'));
    expect(await res.json()).toEqual({ ok: true });
    expect(updateTransferFromWebhook).toHaveBeenCalledWith('wh_1', 'paid');
    expect(liveAlerts()).toHaveLength(0);
  });

  it("a 'default' owner on an http rail -> held", async () => {
    fixtures.transfersById['wh_1'] = awaiting({ partnerId: 'default' });
    fixtures.integrationsByPartner['default'] = HTTP_INTEG;
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', status: 'paid' });
    const res = await post('http', funded, sig(funded, 'rail_whk'));
    expect(await res.json()).toEqual({ ok: true, held: true });
    expect(updateTransferFromWebhook).not.toHaveBeenCalled();
    expect(liveAlerts()).toHaveLength(1);
  });

  it("a paid row's paid_out on an uncertified rail -> applied (not gated)", async () => {
    fixtures.transfersById['wh_1'] = awaiting({ status: 'paid' });
    fixtures.integrationsByPartner['acme'] = HTTP_INTEG;
    partnersById.map.acme = partnerFake('acme', false);
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', status: 'delivered' });
    updateTransferFromWebhook.mockResolvedValue({ ...deliveredTransfer, partnerId: 'acme' });
    const res = await post('http', paidOut, sig(paidOut, 'rail_whk'));
    expect(res.status).toBe(200);
    await flushAfter();
    expect(updateTransferFromWebhook).toHaveBeenCalledWith('wh_1', 'delivered');
    expect(setPayoutReference).toHaveBeenCalledWith('wh_1', 'UTR-LIVE-1');
    expect(liveAlerts()).toHaveLength(0);
  });

  it('simulator / mock rail callback -> unchanged', async () => {
    for (const providerType of ['simulator', 'mock']) {
      updateTransferFromWebhook.mockReset();
      fixtures.transfersById['wh_1'] = awaiting();
      fixtures.integrationsByPartner['acme'] = { ...HTTP_INTEG, payment: { ...HTTP_INTEG.payment, providerType } };
      partnersById.map.acme = partnerFake('acme', false);
      handleWebhook.mockResolvedValue({ transferId: 'wh_1', status: 'paid' });
      updateTransferFromWebhook.mockResolvedValue({ ...awaiting(), status: 'paid' });
      const res = await post(providerType, funded, sig(funded, 'rail_whk'));
      expect(await res.json(), providerType).toEqual({ ok: true });
      expect(updateTransferFromWebhook, providerType).toHaveBeenCalledWith('wh_1', 'paid');
    }
    expect(liveAlerts()).toHaveLength(0);
  });

  it("a 'test' transfer -> unchanged", async () => {
    fixtures.transfersById['wh_1'] = awaiting({ environment: 'test' });
    fixtures.integrationsByPartner['acme'] = HTTP_INTEG;
    partnersById.map.acme = partnerFake('acme', false);
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', status: 'paid' });
    updateTransferFromWebhook.mockResolvedValue({ ...awaiting({ environment: 'test' }), status: 'paid' });
    const res = await post('http', funded, sig(funded, 'rail_whk'));
    expect(await res.json()).toEqual({ ok: true });
    expect(updateTransferFromWebhook).toHaveBeenCalledWith('wh_1', 'paid');
    expect(liveAlerts()).toHaveLength(0);
  });
});
