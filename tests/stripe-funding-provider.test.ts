/**
 * Program-Fix 7 — the Stripe funding provider (raw fetch, no SDK) and the
 * verified-event parser. Network is NEVER hit: fetch is injected.
 *
 * API shapes (fetched 2026-09-23):
 *  - Create a PaymentIntent — POST /v1/payment_intents, form-encoded, `amount`
 *    (integer minor units), `currency` (lowercase), `allowed_payment_method_types[]`,
 *    `metadata[...]`; response has `id`, `client_secret`, `status`, `amount`,
 *    `currency`, `metadata` (https://docs.stripe.com/api/payment_intents/create.md,
 *    https://docs.stripe.com/api/payment_intents/object.md).
 *  - Idempotency-Key header on every POST; keys are pruned after 24h
 *    (https://docs.stripe.com/api/idempotent_requests.md) — so an existing
 *    intent is RETRIEVED, never re-created.
 *  - ACH success/failure is async, up to 4 business days; a failure after
 *    `succeeded` arrives as a dispute (`charge.dispute.created`, reasons
 *    insufficient_funds / incorrect_account_details / bank_cannot_process)
 *    (https://docs.stripe.com/payments/ach-direct-debit).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  StripeFundingProvider,
  parseStripeFundingEvent,
  STRIPE_API_BASE,
} from '@/lib/providers/stripe-funding-provider';
import type { Transfer } from '@/lib/types';

const KEY = ['sk', 'test', 'unitonly'].join('_');

function transfer(o: Partial<Transfer> = {}): Transfer {
  return {
    id: 'tx_1', phone: '15550000000', amountUsd: 195, feeUsd: 4.99, totalChargeUsd: 199.99, fxRate: 85,
    amountInr: 16575, recipientName: 'R', recipientPhone: '', payoutMethod: 'bank',
    payoutDestination: '****1234', fundingMethod: 'bank_transfer', complianceStatus: 'cleared',
    complianceReasons: [], status: 'awaiting_payment', createdAt: new Date().toISOString(),
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    partnerId: 'acme', amountSource: 195, feeSource: 4.99, totalChargeSource: 199.99, ...o,
  };
}

function okJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// Built at runtime so no secret-shaped literal lands in the repo (a dummy fixture).
const CLIENT_SECRET = ['pi_123', 'secret', 'fixture'].join('_');
const PI = {
  id: 'pi_123', object: 'payment_intent', amount: 19999, currency: 'usd', status: 'requires_payment_method',
  client_secret: CLIENT_SECRET, metadata: { transfer_id: 'tx_1', partner_id: 'acme' },
};

describe('StripeFundingProvider.capture', () => {
  it('creates ONE PaymentIntent (form-encoded, idempotency key, minor units, usd, ACH + card) and reports pending', async () => {
    const fetchImpl = vi.fn(async () => okJson(PI));
    const p = new StripeFundingProvider({ secretKey: KEY }, fetchImpl as unknown as typeof fetch);
    const r = await p.capture(transfer());
    expect(r).toEqual({ state: 'pending', intentRef: 'pi_123', clientSecret: CLIENT_SECRET });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${STRIPE_API_BASE}/v1/payment_intents`);
    expect(init.method).toBe('POST');
    const h = new Headers(init.headers);
    expect(h.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(h.get('idempotency-key')).toBe('srfund-tx_1-19999'); // review L3: amount-bound key
    expect(h.get('content-type')).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(String(init.body));
    expect(form.get('amount')).toBe('19999');
    expect(form.get('currency')).toBe('usd');
    expect(form.getAll('allowed_payment_method_types[]')).toEqual(['us_bank_account', 'card']);
    expect(form.get('metadata[transfer_id]')).toBe('tx_1');
    expect(form.get('metadata[partner_id]')).toBe('acme');
    // Nothing identifying about the sender goes to the processor from here.
    expect(String(init.body)).not.toContain('15550000000');
  });

  it('RETRIEVES the bound intent instead of creating a second one', async () => {
    const fetchImpl = vi.fn(async () => okJson(PI));
    const p = new StripeFundingProvider({ secretKey: KEY }, fetchImpl as unknown as typeof fetch);
    const r = await p.capture(transfer({ fundingIntentRef: 'pi_123' }));
    expect(r).toEqual({ state: 'pending', intentRef: 'pi_123', clientSecret: CLIENT_SECRET });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${STRIPE_API_BASE}/v1/payment_intents/pi_123`);
    expect(init.method).toBe('GET');
  });

  it('refuses a bound intent whose metadata/amount/currency does not match the transfer', async () => {
    for (const bad of [
      { ...PI, metadata: { transfer_id: 'other', partner_id: 'acme' } },
      { ...PI, metadata: { transfer_id: 'tx_1', partner_id: 'evil' } },
      { ...PI, amount: 100 },
      { ...PI, currency: 'eur' },
      { ...PI, id: 'pi_other' },
    ]) {
      const fetchImpl = vi.fn(async () => okJson(bad));
      const p = new StripeFundingProvider({ secretKey: KEY }, fetchImpl as unknown as typeof fetch);
      await expect(p.capture(transfer({ fundingIntentRef: 'pi_123' }))).rejects.toThrow();
    }
  });

  it('refuses to re-present a CANCELED intent (review M1: never hand out a dead secret)', async () => {
    const fetchImpl = vi.fn(async () => okJson({ ...PI, status: 'canceled' }));
    const p = new StripeFundingProvider({ secretKey: KEY }, fetchImpl as unknown as typeof fetch);
    await expect(p.capture(transfer({ fundingIntentRef: 'pi_123' }))).rejects.toThrow(/canceled/);
  });

  it('refuses a created intent that echoes a different amount (never trusts the processor blindly)', async () => {
    const fetchImpl = vi.fn(async () => okJson({ ...PI, amount: 1 }));
    const p = new StripeFundingProvider({ secretKey: KEY }, fetchImpl as unknown as typeof fetch);
    await expect(p.capture(transfer())).rejects.toThrow();
  });

  it('refuses a non-USD source currency before any network call', async () => {
    const fetchImpl = vi.fn(async () => okJson(PI));
    const p = new StripeFundingProvider({ secretKey: KEY }, fetchImpl as unknown as typeof fetch);
    await expect(p.capture(transfer({ sourceCurrency: 'GBP' as Transfer['sourceCurrency'] }))).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses an amount under the processor minimum before any network call', async () => {
    const fetchImpl = vi.fn(async () => okJson(PI));
    const p = new StripeFundingProvider({ secretKey: KEY }, fetchImpl as unknown as typeof fetch);
    await expect(p.capture(transfer({ totalChargeSource: 0.4 }))).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws on a non-2xx without echoing the key or the response body', async () => {
    const fetchImpl = vi.fn(async () => okJson({ error: { message: 'boom secret-ish' } }, 402));
    const p = new StripeFundingProvider({ secretKey: KEY }, fetchImpl as unknown as typeof fetch);
    const err = await p.capture(transfer()).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('402');
    expect((err as Error).message).not.toContain(KEY);
    expect((err as Error).message).not.toContain('boom');
  });

  it('refuses with no secret key configured', async () => {
    const fetchImpl = vi.fn();
    const p = new StripeFundingProvider({ secretKey: '' }, fetchImpl as unknown as typeof fetch);
    await expect(p.capture(transfer())).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('StripeFundingProvider.refund / handleWebhook', () => {
  it('refund is NOT faked: it throws so the durable refund row dead-letters and alerts (follow-up builds the async Stripe refund)', async () => {
    const fetchImpl = vi.fn();
    const p = new StripeFundingProvider({ secretKey: KEY }, fetchImpl as unknown as typeof fetch);
    await expect(p.refund(transfer({ fundingRef: 'pi_123' }))).rejects.toThrow(/not supported/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('handleWebhook ignores generic-route bodies (Stripe events use their own verified route)', async () => {
    const p = new StripeFundingProvider({ secretKey: KEY }, vi.fn() as unknown as typeof fetch);
    expect(await p.handleWebhook({ transfer_id: 'tx_1', event: 'captured' })).toBeNull();
  });
});

describe('parseStripeFundingEvent', () => {
  const ev = (type: string, object: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    id: 'evt_1', object: 'event', type, livemode: false, data: { object }, ...extra,
  });

  it('payment_intent.succeeded → succeeded with amount_received, currency, metadata', () => {
    const e = parseStripeFundingEvent(ev('payment_intent.succeeded', { ...PI, status: 'succeeded', amount_received: 19999 }));
    expect(e).toEqual({
      kind: 'succeeded', eventId: 'evt_1', livemode: false, intentId: 'pi_123',
      amountReceived: 19999, currency: 'usd', transferId: 'tx_1', partnerId: 'acme',
    });
  });

  it.each([
    ['payment_intent.payment_failed', 'failed'],
    ['payment_intent.canceled', 'canceled'],
    ['payment_intent.processing', 'processing'],
  ])('%s → %s', (type, kind) => {
    const e = parseStripeFundingEvent(ev(type, PI));
    expect(e).toMatchObject({ kind, eventId: 'evt_1', intentId: 'pi_123', transferId: 'tx_1', partnerId: 'acme' });
  });

  it('charge.dispute.created → dispute with the intent, reason and status (an ACH return after success)', () => {
    const e = parseStripeFundingEvent(ev('charge.dispute.created', {
      id: 'du_1', object: 'dispute', amount: 19999, currency: 'usd', charge: 'ch_1',
      payment_intent: 'pi_123', reason: 'insufficient_funds', status: 'needs_response',
    }));
    expect(e).toEqual({
      kind: 'dispute', eventId: 'evt_1', livemode: false, intentId: 'pi_123', chargeId: 'ch_1',
      disputeId: 'du_1', reason: 'insufficient_funds', status: 'needs_response', amount: 19999, currency: 'usd',
    });
  });

  it('a dispute with no payment_intent keeps the charge id (never dropped)', () => {
    const e = parseStripeFundingEvent(ev('charge.dispute.created', {
      id: 'du_2', object: 'dispute', amount: 5, currency: 'usd', charge: 'ch_2', payment_intent: null,
      reason: 'general', status: 'warning_needs_response',
    }));
    expect(e).toMatchObject({ kind: 'dispute', intentId: null, chargeId: 'ch_2' });
  });

  it.each([
    ['unknown type', ev('customer.created', { id: 'cus_1' })],
    ['not an event', { id: 'evt_1', object: 'charge' }],
    ['no id', { object: 'event', type: 'payment_intent.succeeded', data: { object: PI } }],
    ['no data.object', { id: 'evt_1', object: 'event', type: 'payment_intent.succeeded' }],
    ['intent without id', ev('payment_intent.succeeded', { ...PI, id: undefined })],
    ['null', null],
    ['string', 'x'],
  ])('ignores %s', (_label, body) => {
    expect(parseStripeFundingEvent(body)).toBeNull();
  });

  it('succeeded without a numeric amount_received is ignored (cannot be cross-checked)', () => {
    expect(parseStripeFundingEvent(ev('payment_intent.succeeded', { ...PI, amount_received: 'x' }))).toBeNull();
  });
});
