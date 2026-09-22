import { createHmac } from 'node:crypto';
import type { Store } from '../store';
import { isMaskedDestination, usdcAddressFromDestination } from '../payout-format';
import { isPartnerPulled } from '../funding-method';
import type { Transfer, TransferStatus } from '../types';
import type { PartnerPaymentConfig } from '../partner-integrations';
import type {
  InitiateResult,
  PaymentProvider,
  PaymentProviderStatus,
  RailFailure,
  WebhookResult,
} from './payment-provider';
import { completePaymentStage1 } from '../payment';
import { sendText, type WaCreds } from '../whatsapp';
import { logWarn } from '../log';

// http-payment-provider — the REAL settlement rail adapter (WL3).
//
// NON-CUSTODIAL BOUNDARY: SmartRemit never holds, custodies, or routes funds.
// This adapter only (a) POSTs a SIGNED settlement INSTRUCTION to the partner's
// configured endpoint (the partner is the licensed money-transmitter executing
// the payout on their own rails) and (b) mirrors the status the partner reports
// back via POST /api/payment-webhook/[provider]. There is NO timer here —
// delivery is entirely webhook-driven by the partner's callbacks.
//
// Outbound signature: HMAC-SHA256 hex of the exact JSON body, sent in
// `x-signature` — the same scheme the partner uses on their callbacks, so one
// verification recipe covers both directions of the integration.

/**
 * Rail ack budget (rail-09). The partner contract (src/app/docs/page.tsx §3)
 * promises we wait at most this long for a 2xx; a slower rail is a RETRYABLE
 * failure. Single source for the worker's three rail POSTs too.
 */
export const RAIL_TIMEOUT_MS = 15_000;

/**
 * Normalize a partner-rail FORWARD lifecycle status to our TransferStatus.
 * created → awaiting_payment (no-op transition), funded → paid,
 * paid_out → delivered. Anything else → null: `failed` / `returned` are a
 * RailFailure (parseRailFailure, fix 8), the rest is unknown and ignored.
 */
export function normalizeRailStatus(status: unknown): TransferStatus | null {
  switch (typeof status === 'string' ? status.toLowerCase() : '') {
    case 'created': return 'awaiting_payment';
    case 'funded': return 'paid';
    case 'paid_out': return 'delivered';
    default: return null;
  }
}

/** The rail's free-text reason is bounded here, once, at the edge. */
export const RAIL_FAILURE_REASON_MAX = 200;

/**
 * fix 8 (money-02 / rail-02): parse a rail's `failed` / `returned` callback
 * (case-insensitive) into a bounded RailFailure. The optional `reason` is
 * UNTRUSTED text: control characters (incl. newlines) AND Unicode format
 * characters (\p{Cf}: bidi overrides/isolates U+202A–202E / U+2066–2069, zero-
 * width joiners, BOM) plus the line/paragraph separators U+2028/2029 are
 * stripped, so a reason can never re-order or hide text in an ops alert or a
 * staff note; it is then trimmed and capped at RAIL_FAILURE_REASON_MAX;
 * missing / non-string / empty ⇒ 'unspecified'. Forward statuses and anything
 * unknown ⇒ null.
 */
const RAIL_REASON_STRIP = /[\u0000-\u001f\u007f\u2028\u2029]|\p{Cf}/gu;

export function parseRailFailure(body: unknown): RailFailure | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const status = typeof b.status === 'string' ? b.status.toLowerCase() : '';
  if (status !== 'failed' && status !== 'returned') return null;
  const raw = typeof b.reason === 'string' ? b.reason : '';
  const cleaned = raw.replace(RAIL_REASON_STRIP, '').trim().slice(0, RAIL_FAILURE_REASON_MAX);
  return { code: status, reason: cleaned === '' ? 'unspecified' : cleaned };
}

/** Tolerant transfer-id extraction from a rail callback ({reference} preferred). */
export function railCallbackTransferId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const candidate = b.reference ?? b.transferId ?? b.transfer_id;
  return typeof candidate === 'string' && candidate !== '' ? candidate : null;
}

/**
 * The signed instruction body POSTed to the partner's settlement endpoint.
 *
 * fix 6 (ctx-01) LAST-LINE BACKSTOPS — a row written before fix 6 fails loudly
 * in its settlement.instruct outbox row (2^n backoff → dead at 8 → deduped ops
 * alert, plus reconcile's stuck-paid alert) instead of instructing:
 *   • a display placeholder ("****9012", "account on file") as the payout; and
 *   • a partner-pulled funding leg (ach_pull / bank_pull) on a CONSUMER row —
 *     the pay route never charged it, and only a B2B bill may be pulled.
 *   • an EMPTY payout on anything but a B2B partner-pulled row (fix 10 review
 *     S2) — only there does the partner pay the payee on its own records.
 * Messages carry the transfer id only.
 */
export function buildSettlementInstruction(transfer: Transfer) {
  const b2bPulled = transfer.transferType === 'b2b' && isPartnerPulled(transfer.fundingMethod);
  if (isMaskedDestination(transfer.payoutDestination)) {
    throw new Error(`settlement_destination_invalid:${transfer.id}`);
  }
  // fix 10 (review S2): an EMPTY payout is legal only where the licensed partner
  // pays the payee on its own records — a B2B partner-pulled bill. Any other row
  // with no account (a consumer row, or a card/bank-funded B2B row) is refused
  // rather than instructing the rail to pay nobody.
  if ((transfer.payoutDestination ?? '').trim() === '' && !b2bPulled) {
    throw new Error(`settlement_destination_invalid:${transfer.id}`);
  }
  if (isPartnerPulled(transfer.fundingMethod) && transfer.transferType !== 'b2b') {
    throw new Error(`settlement_funding_invalid:${transfer.id}`);
  }
  return {
    reference: transfer.id,
    partner_id: transfer.partnerId,
    corridor: {
      source: transfer.sourceCountry ?? 'US',
      destination: transfer.destinationCountry ?? 'IN',
    },
    // USDC seller payout (non-custodial): the rail is 'usdc' and the wire
    // destination is the BARE 0x wallet address — the canonical `USDC|` storage
    // prefix is OURS, stripped here so the partner gets exactly the address it
    // must pay. The seller still nets the EXACT invoiced `amount.destination`;
    // which chain the USDC moves on is the partner rail's configuration.
    // Bank/UPI payout legs are byte-unchanged.
    payout: {
      rail: transfer.payoutMethod,
      destination:
        transfer.payoutMethod === 'usdc'
          ? usdcAddressFromDestination(transfer.payoutDestination)
          : transfer.payoutDestination,
    },
    recipient: {
      name: transfer.recipientName,
      phone: transfer.recipientPhone,
    },
    amount: {
      source: transfer.amountSource ?? transfer.amountUsd,
      currency: transfer.sourceCurrency ?? 'USD',
      destination: transfer.amountInr,
      destination_currency: transfer.destinationCurrency ?? 'INR',
      fx_rate: transfer.fxRate, // FX locked at quote time
    },
    // B2B ACH-pull (non-custodial): SmartRemit performs NO funding capture — the
    // LICENSED PARTNER's rail ACH-debits the payer using the opaque mandate token
    // it already holds. SmartRemit only instructs; funds never touch us.
    ...(transfer.fundingMethod === 'ach_pull'
      ? { funding: { method: 'ach_debit', token: transfer.achTokenRef ?? null } }
      : {}),
    // Cross-border B2B bank-pull (non-custodial): ONE signed instruction carries
    // BOTH legs. The FUNDING leg here tells the LICENSED PARTNER's rail to debit
    // the BUYER's LOCAL bank for the FULL buyer charge (`amount` = principal + fee,
    // the buyer-borne total) in `currency` (any of the 10 corridors); the PAYOUT
    // leg is the `payout` block + `amount.destination`/`destination_currency` above
    // — pay the seller the LOCKED destination amount in the seller currency (a
    // seller-denominated bill: their exact invoiced amount; a buyer-denominated
    // bill: the locked conversion — same instruction shape either way;
    // amount.source = the principal, so amount.source * fx_rate ≈ amount.destination).
    // The partner does the debit, the FX, and the payout, keeping the fee margin.
    // SmartRemit performs NO funding capture: `token` is the OPAQUE buyer-bank
    // reference (raw bank digits never persisted), exactly as ach_pull keeps only
    // an opaque mandate.
    ...(transfer.fundingMethod === 'bank_pull'
      ? {
          funding: {
            method: 'bank_debit',
            token: transfer.achTokenRef ?? null,
            amount: transfer.totalChargeSource ?? transfer.amountSource ?? transfer.amountUsd,
            currency: transfer.sourceCurrency ?? 'USD',
            country: transfer.sourceCountry ?? null,
          },
        }
      : {}),
    ...(transfer.transferType === 'b2b'
      ? {
          parties: {
            sender_entity_type: transfer.senderEntityType ?? 'individual',
            recipient_entity_type: transfer.recipientEntityType ?? 'individual',
            sender_business_name: transfer.senderBusinessName,
            recipient_business_name: transfer.recipientBusinessName,
          },
        }
      : {}),
  };
}

/**
 * The SIGNED reverse instruction for a B2B ach_pull cancel. NON-CUSTODIAL: when a
 * paid B2B transfer is cancelled, SmartRemit never captured the funds — only the
 * licensed partner's rail did the ACH-debit. So we don't refund; we INSTRUCT the
 * partner to REVERSE/return the pull it owns, keyed on the SAME reference the
 * original settlement instruction carried (transfer.id). Mirrors
 * buildSettlementInstruction's shape with an `action: 'reverse'` discriminator so
 * the rail routes it to its return-ACH path, not a fresh payout.
 */
export function buildReverseInstruction(transfer: Transfer) {
  return {
    action: 'reverse' as const,
    // DISTINCT reference from the original settlement instruction (which used
    // transfer.id): a rail that dedupes/idempotency-keys on `reference` MUST be
    // able to tell a reverse from the settle it's reversing, or it would swallow
    // the reverse as a replay and the debit would never be returned.
    reference: `reverse-${transfer.id}`,
    partner_id: transfer.partnerId,
    // Cross-border bank_pull reverses a local-bank debit ('bank_debit'); the
    // US-domestic ach_pull reverse stays byte-identical ('ach_debit'). Either way
    // the partner returns the buyer's debit in the source currency it pulled.
    funding: {
      method: transfer.fundingMethod === 'bank_pull' ? ('bank_debit' as const) : ('ach_debit' as const),
      token: transfer.achTokenRef ?? null,
    },
    amount: {
      source: transfer.amountSource ?? transfer.amountUsd,
      currency: transfer.sourceCurrency ?? 'USD',
    },
    parties: {
      sender_entity_type: transfer.senderEntityType ?? 'individual',
      recipient_entity_type: transfer.recipientEntityType ?? 'individual',
      sender_business_name: transfer.senderBusinessName,
      recipient_business_name: transfer.recipientBusinessName,
    },
  };
}

export function signBody(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export class HttpPaymentProvider implements PaymentProvider {
  constructor(
    private readonly store: Store,
    private readonly payment: PartnerPaymentConfig,
    private readonly brand?: string,
    private readonly waCreds?: WaCreds,
  ) {}

  async initiateTransfer(transfer: Transfer): Promise<InitiateResult> {
    const settlementUrl = this.payment.credentials?.settlementUrl ?? '';
    const signingSecret = this.payment.credentials?.signingSecret ?? '';
    // Fail-closed: an http/simulator partner without a configured endpoint must
    // never silently fall back to a timer-based fake delivery.
    if (!settlementUrl) {
      throw new Error('Settlement endpoint not configured for this partner.');
    }

    // Stage 1 — the customer-facing "payment received" moment (identical to the
    // mock's stage 1). Funds are charged on the partner's side; we mirror it.
    const { transfer: t1, senderMessages } = await completePaymentStage1(this.store, transfer.id);
    for (const msg of senderMessages) await sendText(t1.phone, msg, this.waCreds);

    // POST the SIGNED settlement instruction to the partner's rail. Stage 2
    // (delivered) arrives via their signed callback to /api/payment-webhook —
    // NO self-advance timer on this path.
    const rawBody = JSON.stringify(buildSettlementInstruction(transfer));
    const res = await fetch(settlementUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(signingSecret ? { 'x-signature': signBody(rawBody, signingSecret) } : {}),
      },
      body: rawBody,
      signal: AbortSignal.timeout(RAIL_TIMEOUT_MS),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Settlement instruction rejected (${res.status}): ${errBody.slice(0, 300)}`);
    }
    let providerRef = `rail-${transfer.id}`;
    try {
      const parsed = (await res.json()) as { providerRef?: unknown };
      if (typeof parsed.providerRef === 'string' && parsed.providerRef !== '') {
        providerRef = parsed.providerRef;
      }
    } catch {
      // Non-JSON 2xx ack is acceptable — keep the deterministic fallback ref.
    }
    return { providerRef };
  }

  async getStatus(providerRef: string): Promise<PaymentProviderStatus> {
    const id = providerRef.startsWith('rail-') ? providerRef.slice('rail-'.length) : null;
    const t = id ? await this.store.getTransfer(id) : null;
    if (!t) return 'created';
    if (t.status === 'delivered') return 'paid_out';
    if (t.status === 'paid') return 'funded';
    return 'created';
  }

  async handleWebhook(body: unknown): Promise<WebhookResult | null> {
    const transferId = railCallbackTransferId(body);
    if (!transferId) return null;
    const status = normalizeRailStatus((body as Record<string, unknown>).status);
    if (status) return { transferId, status };
    // fix 8: a failure is a RESULT the route acts on (cancel + refund + notify +
    // alert), never a dropped event. Only a truly unknown status is ignored.
    const failure = parseRailFailure(body);
    if (failure) return { transferId, failure };
    logWarn('payment-webhook.unmapped', 'partner rail callback with unmapped status — ignored', { transferId });
    return null;
  }
}
