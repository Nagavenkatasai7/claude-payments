import { toMinorUnits, STRIPE_MIN_USD_CENTS } from '@/lib/funding-amount';
import type { Transfer } from '@/lib/types';
import type { FundingProvider, FundingWebhookEvent, PendingCaptureResult, RefundResult } from './funding-provider';

// stripe-funding-provider — Program-Fix 7: the SENDER-side charge through the
// LICENSED PARTNER's own Stripe account (partner-scoped secret key, stored in
// partner_integrations.funding_credentials_enc). SmartRemit never holds funds:
// the PaymentIntent is created with the partner's key, so the partner is the
// merchant of record and the money lands in the partner's Stripe balance,
// never in a SmartRemit account. No `stripe` SDK: raw fetch, form-encoded, as
// documented at https://docs.stripe.com/api (Create a PaymentIntent —
// https://docs.stripe.com/api/payment_intents/create.md).
//
// Money rules this file enforces:
//  • ONE intent per transfer. A bound intent is RETRIEVED (GET), never
//    re-created: Stripe prunes idempotency keys after 24h
//    (https://docs.stripe.com/api/idempotent_requests.md), so the key alone
//    cannot prevent a second intent on a late retry. The create call still
//    sends Idempotency-Key `srfund-<transferId>-<cents>` for the in-flight retry.
//  • Every intent is cross-checked against the transfer (id, metadata
//    transfer/partner, amount in minor units, currency) — a mismatch throws,
//    so the pay route answers 402 and nothing is persisted as charged.
//  • capture() NEVER reports a charge: it returns `pending`. Only a verified
//    webhook (`payment_intent.succeeded`) marks funds, in the ledger.
//  • refund() is NOT faked (a fake ref would record a completed refund with
//    no money returned). It throws, so the durable funding.refund row retries,
//    dead-letters and raises the ops alert. The async Stripe refund
//    (POST /v1/refunds + refund.updated) is a listed follow-up.

export const STRIPE_API_BASE = 'https://api.stripe.com';

export interface StripeFundingCredentials {
  secretKey: string;
}

interface StripeIntent {
  id: string;
  amount: number;
  currency: string;
  status: string;
  client_secret: string | null;
  metadata: Record<string, string>;
}

function asIntent(body: unknown): StripeIntent {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.object !== 'payment_intent' || typeof b.id !== 'string' || typeof b.amount !== 'number' || typeof b.currency !== 'string') {
    throw new Error('stripe: unexpected payment_intent shape');
  }
  return {
    id: b.id,
    amount: b.amount,
    currency: b.currency,
    status: typeof b.status === 'string' ? b.status : '',
    client_secret: typeof b.client_secret === 'string' ? b.client_secret : null,
    metadata: (b.metadata && typeof b.metadata === 'object' ? b.metadata : {}) as Record<string, string>,
  };
}

/** The processor currency for a transfer — ACH Direct Debit presents USD only. */
function processorCurrency(t: Transfer): 'usd' {
  if (t.sourceCurrency !== 'USD') throw new Error('stripe funding: only USD source currency is supported');
  return 'usd';
}

export class StripeFundingProvider implements FundingProvider {
  constructor(
    private readonly creds: StripeFundingCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(method: 'GET' | 'POST', path: string, form?: URLSearchParams, idempotencyKey?: string): Promise<unknown> {
    if (!this.creds.secretKey) throw new Error('stripe funding: no secret key configured');
    const headers: Record<string, string> = { authorization: `Bearer ${this.creds.secretKey}` };
    if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    const res = await this.fetchImpl(`${STRIPE_API_BASE}${path}`, {
      method,
      headers,
      body: form ? form.toString() : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // Status only — the body may carry request details; never echo it.
      throw new Error(`stripe: ${method} ${path.split('/').slice(0, 3).join('/')} failed with HTTP ${res.status}`);
    }
    return res.json();
  }

  /** Throws unless `pi` is exactly this transfer's intent for this amount. */
  private assertMatches(pi: StripeIntent, t: Transfer, expectedId?: string): void {
    const cents = toMinorUnits(t.totalChargeSource);
    if (expectedId !== undefined && pi.id !== expectedId) throw new Error('stripe: intent id mismatch');
    if (pi.metadata.transfer_id !== t.id || pi.metadata.partner_id !== t.partnerId) {
      throw new Error('stripe: intent metadata does not match the transfer');
    }
    if (pi.amount !== cents || pi.currency !== processorCurrency(t)) {
      throw new Error('stripe: intent amount/currency does not match the transfer');
    }
  }

  async capture(t: Transfer): Promise<PendingCaptureResult> {
    const currency = processorCurrency(t);
    const cents = toMinorUnits(t.totalChargeSource);
    if (cents < STRIPE_MIN_USD_CENTS) throw new Error('stripe funding: amount below the processor minimum');
    if (!this.creds.secretKey) throw new Error('stripe funding: no secret key configured');

    let pi: StripeIntent;
    if (t.fundingIntentRef) {
      pi = asIntent(await this.call('GET', `/v1/payment_intents/${encodeURIComponent(t.fundingIntentRef)}`));
      this.assertMatches(pi, t, t.fundingIntentRef);
      // Review M1: a canceled intent can never be confirmed — never hand out
      // its secret (the pay route answers 402; ops cancels/voids the row).
      if (pi.status === 'canceled') throw new Error('stripe: the bound intent is canceled');
    } else {
      const form = new URLSearchParams();
      form.set('amount', String(cents));
      form.set('currency', currency);
      // ACH Direct Debit (bank verified through Financial Connections — the
      // default verification for us_bank_account, per
      // https://docs.stripe.com/payments/ach-direct-debit/accept-a-payment) + card.
      form.append('allowed_payment_method_types[]', 'us_bank_account');
      form.append('allowed_payment_method_types[]', 'card');
      form.set('metadata[transfer_id]', t.id);
      form.set('metadata[partner_id]', t.partnerId);
      // Review L3: the key binds the amount too, so an edited amount can never
      // collide with a stale key (Stripe rejects same-key/different-params).
      pi = asIntent(await this.call('POST', '/v1/payment_intents', form, `srfund-${t.id}-${cents}`));
      this.assertMatches(pi, t);
    }
    if (!pi.client_secret) throw new Error('stripe: intent has no client secret');
    return { state: 'pending', intentRef: pi.id, clientSecret: pi.client_secret };
  }

  async refund(_t: Transfer): Promise<RefundResult> {
    throw new Error('stripe funding: automatic refund not supported yet — refund in the partner Stripe dashboard (Program-Fix 7 follow-up)');
  }

  async handleWebhook(_body: unknown): Promise<FundingWebhookEvent | null> {
    // Stripe events arrive on /api/funding-webhook/stripe/<partnerId>, verified
    // with the partner's endpoint secret; the generic HMAC route never acts on them.
    return null;
  }
}

// ── Verified-event parsing ────────────────────────────────────────────────────

export type StripeFundingEvent =
  | {
      kind: 'succeeded';
      eventId: string;
      livemode: boolean;
      intentId: string;
      amountReceived: number;
      currency: string;
      transferId: string;
      partnerId: string;
    }
  | {
      kind: 'failed' | 'canceled' | 'processing';
      eventId: string;
      livemode: boolean;
      intentId: string;
      transferId: string;
      partnerId: string;
    }
  | {
      kind: 'dispute';
      eventId: string;
      livemode: boolean;
      intentId: string | null;
      chargeId: string;
      disputeId: string;
      reason: string;
      status: string;
      amount: number;
      currency: string;
    };

const INTENT_KINDS: Record<string, 'succeeded' | 'failed' | 'canceled' | 'processing'> = {
  'payment_intent.succeeded': 'succeeded',
  'payment_intent.payment_failed': 'failed',
  'payment_intent.canceled': 'canceled',
  'payment_intent.processing': 'processing',
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Parse an ALREADY SIGNATURE-VERIFIED Stripe snapshot event
 * (https://docs.stripe.com/api/events/object.md). Returns null for anything
 * this integration does not act on. Never trusts an id it cannot find.
 */
export function parseStripeFundingEvent(body: unknown): StripeFundingEvent | null {
  if (!body || typeof body !== 'object') return null;
  const e = body as Record<string, unknown>;
  if (e.object !== 'event' || !str(e.id) || !str(e.type)) return null;
  const data = e.data as Record<string, unknown> | undefined;
  const obj = data && typeof data.object === 'object' && data.object ? (data.object as Record<string, unknown>) : null;
  if (!obj) return null;
  const eventId = str(e.id);
  const livemode = e.livemode === true;
  const type = str(e.type);

  const intentKind = INTENT_KINDS[type];
  if (intentKind) {
    const intentId = str(obj.id);
    if (!intentId) return null;
    const md = (obj.metadata && typeof obj.metadata === 'object' ? obj.metadata : {}) as Record<string, unknown>;
    const base = { eventId, livemode, intentId, transferId: str(md.transfer_id), partnerId: str(md.partner_id) };
    if (intentKind === 'succeeded') {
      if (typeof obj.amount_received !== 'number' || !Number.isInteger(obj.amount_received)) return null;
      return { kind: 'succeeded', ...base, amountReceived: obj.amount_received, currency: str(obj.currency) };
    }
    return { kind: intentKind, ...base };
  }

  if (type === 'charge.dispute.created') {
    // After a PaymentIntent succeeded, a late ACH failure (R-code return) is
    // delivered as a dispute: https://docs.stripe.com/payments/ach-direct-debit
    // ("Transaction failures"). Dispute fields:
    // https://docs.stripe.com/api/disputes/object.md
    const disputeId = str(obj.id);
    const chargeId = str(obj.charge);
    if (!disputeId || !chargeId) return null;
    return {
      kind: 'dispute',
      eventId,
      livemode,
      intentId: str(obj.payment_intent) || null,
      chargeId,
      disputeId,
      reason: str(obj.reason),
      status: str(obj.status),
      amount: typeof obj.amount === 'number' ? obj.amount : 0,
      currency: str(obj.currency),
    };
  }
  return null;
}
