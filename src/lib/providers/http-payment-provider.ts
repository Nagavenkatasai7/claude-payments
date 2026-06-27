import { createHmac } from 'node:crypto';
import type { Store } from '../store';
import type { Transfer, TransferStatus } from '../types';
import type { PartnerPaymentConfig } from '../partner-integrations';
import type {
  InitiateResult,
  PaymentProvider,
  PaymentProviderStatus,
  WebhookResult,
} from './payment-provider';
import { completePaymentStage1 } from '../payment';
import { sendText, type WaCreds } from '../whatsapp';

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
 * Normalize a partner-rail lifecycle status to our TransferStatus.
 * created → awaiting_payment (no-op transition), funded → paid,
 * paid_out → delivered. failed/unknown → null (logged by the caller; reversal
 * flows are out of scope in v1 — the forward-only state machine ignores them).
 */
export function normalizeRailStatus(status: unknown): TransferStatus | null {
  switch (typeof status === 'string' ? status.toLowerCase() : '') {
    case 'created': return 'awaiting_payment';
    case 'funded': return 'paid';
    case 'paid_out': return 'delivered';
    default: return null;
  }
}

/** Tolerant transfer-id extraction from a rail callback ({reference} preferred). */
export function railCallbackTransferId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const candidate = b.reference ?? b.transferId ?? b.transfer_id;
  return typeof candidate === 'string' && candidate !== '' ? candidate : null;
}

/** The signed instruction body POSTed to the partner's settlement endpoint. */
export function buildSettlementInstruction(transfer: Transfer) {
  return {
    reference: transfer.id,
    partner_id: transfer.partnerId,
    corridor: {
      source: transfer.sourceCountry ?? 'US',
      destination: transfer.destinationCountry ?? 'IN',
    },
    payout: {
      rail: transfer.payoutMethod,
      destination: transfer.payoutDestination,
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
    funding: { method: 'ach_debit' as const, token: transfer.achTokenRef ?? null },
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
    if (!status) {
      console.warn(`Partner rail callback with unmapped status for ${transferId} — ignored (forward-only).`);
      return null;
    }
    return { transferId, status };
  }
}
