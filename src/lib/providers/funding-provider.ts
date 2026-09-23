import type { Transfer } from '@/lib/types';
import type { PartnerFundingConfig } from '@/lib/partner-integrations';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import { StripeFundingProvider } from './stripe-funding-provider';

// funding-provider — the FUNDS-CAPTURE seam (the sender-side charge), distinct
// from payment-provider.ts (the recipient-side settlement rail). SmartRemit is
// NON-CUSTODIAL: a real implementation here is a PSP/sponsor-bank integration
// (Plaid + processor, Stripe, …) that charges the SENDER; we never hold funds.
//
// Contract:
//  • capture() is IDEMPOTENT BY TRANSFER ID — a retry after a crash must
//    return the same charge, never a second one. The mock guarantees this with
//    deterministic refs; a real PSP implementation must pass the transfer id
//    as its idempotency key.
//  • Order of operations (the pay route owns it): OTP → payout-details
//    validation → compliance screening → capture() → setFundingRef →
//    beginSettlement. Capture runs OUTSIDE any DB transaction; the write-once
//    fundingRef plus the reconcile sweep make the capture→settle gap
//    crash-safe.
//  • refund() returns the customer's money to the original payment method.
//    Also idempotent by transfer id.
//  • handleWebhook() parses a signed PSP callback (async captures/refunds for
//    real providers) — the /api/funding-webhook/[provider] route verifies the
//    HMAC fail-closed BEFORE calling this.

/**
 * A SYNCHRONOUS capture: the charge exists now. `state` is optional so the
 * pre-fix-7 shape `{ fundingRef }` (the mock) stays valid and byte-identical;
 * absent ⇒ 'captured'.
 */
export interface CapturedResult {
  fundingRef: string;
  state?: 'captured';
}

/**
 * Program-Fix 7 — an ASYNC capture: the PSP created (or re-presented) an
 * intent the SENDER must still confirm in the browser, and the money is only
 * real once a SIGNED webhook says so (ACH can take up to 4 business days —
 * https://docs.stripe.com/payments/ach-direct-debit). NOT a charge: the pay
 * route persists `intentRef` (never as fundingRef) and never settles on it.
 * `clientSecret` goes to the paying browser only — never logged, stored or
 * put in an outbox payload.
 */
export interface PendingCaptureResult {
  state: 'pending';
  intentRef: string;
  clientSecret: string;
}

export type CaptureResult = CapturedResult | PendingCaptureResult;

/** Narrowing helper: true only for the async (not-yet-funded) shape. */
export function isPendingCapture(r: CaptureResult): r is PendingCaptureResult {
  return r.state === 'pending';
}

export interface RefundResult {
  refundRef: string;
}

export type FundingWebhookEvent =
  | { transferId: string; event: 'captured'; ref: string }
  | { transferId: string; event: 'refunded'; ref: string }
  | { transferId: string; event: 'refund_failed'; ref?: string };

export interface FundingProvider {
  /** Charge the sender for transfer.totalChargeSource. Idempotent by transfer id. */
  capture(transfer: Transfer): Promise<CaptureResult>;
  /** Return the full charge to the original payment method. Idempotent by transfer id. */
  refund(transfer: Transfer): Promise<RefundResult>;
  /** Parse an (already signature-verified) provider callback; null ⇒ ignore. */
  handleWebhook(body: unknown): Promise<FundingWebhookEvent | null>;
}

/**
 * The demo/testing implementation: captures and refunds succeed instantly with
 * deterministic references, so the full charge→settle→refund orchestration is
 * exercisable end-to-end with zero external dependencies — the same role the
 * simulator rail plays for settlement.
 */
export class MockFundingProvider implements FundingProvider {
  async capture(transfer: Transfer): Promise<CapturedResult> {
    return { fundingRef: `mockfund-${transfer.id}` };
  }

  async refund(transfer: Transfer): Promise<RefundResult> {
    return { refundRef: `mockrefund-${transfer.id}` };
  }

  async handleWebhook(body: unknown): Promise<FundingWebhookEvent | null> {
    if (!body || typeof body !== 'object') return null;
    const b = body as Record<string, unknown>;
    const transferId = typeof b.transfer_id === 'string' ? b.transfer_id : '';
    const event = typeof b.event === 'string' ? b.event : '';
    if (!transferId) return null;
    if (event === 'captured' || event === 'refunded') {
      const ref = typeof b.ref === 'string' && b.ref ? b.ref : `mockfund-${transferId}`;
      return { transferId, event, ref };
    }
    if (event === 'refund_failed') {
      return { transferId, event, ref: typeof b.ref === 'string' ? b.ref : undefined };
    }
    return null;
  }
}

/**
 * The default provider: the mock. Unchanged for every caller that has no
 * transfer-level decision to make (the generic HMAC webhook route). Transfer
 * paths use selectFundingProvider / refundProviderFor below.
 */
export function getFundingProvider(): FundingProvider {
  return new MockFundingProvider();
}

// ── Program-Fix 7: per-transfer selection (flag OFF ⇒ always the mock) ────────

export type FundingSelection =
  | { kind: 'mock'; provider: FundingProvider }
  | { kind: 'stripe'; provider: StripeFundingProvider }
  | { kind: 'refused'; reason: 'default_tenant' | 'routed' | 'unconfigured' | 'disabled_with_intent' };

/**
 * Decide how THIS transfer's sender is charged. Pure (the caller reads the
 * flag and the partner's funding config). Rules, in order:
 *  1. Flag OFF ⇒ mock — unless the row is ALREADY bound to a Stripe intent,
 *     which is refused (a real debit may be in flight; never paper over it
 *     with a mock charge).
 *  2. Sandbox ('test') and B2B rows ⇒ mock (the fix-44 chokepoint; B2B keeps
 *     its partner-pulled / mock path).
 *  3. No Stripe config ⇒ mock (today's behaviour).
 *  4. NON-CUSTODIAL refusals: SmartRemit's own DEFAULT tenant (SmartRemit
 *     would be merchant of record) and ROUTED transfers (funds at one
 *     licensee, payout at another) never charge through Stripe.
 *  5. Stripe config without a secret key ⇒ refused (fail closed).
 */
export function selectFundingProvider(
  transfer: Transfer,
  opts: { enabled: boolean; config: PartnerFundingConfig | null; fetchImpl?: typeof fetch },
): FundingSelection {
  const bound = transfer.fundingProvider === 'stripe' || !!transfer.fundingIntentRef;
  if (!opts.enabled) {
    return bound ? { kind: 'refused', reason: 'disabled_with_intent' } : { kind: 'mock', provider: new MockFundingProvider() };
  }
  if (!bound && (transfer.environment === 'test' || transfer.transferType === 'b2b')) {
    return { kind: 'mock', provider: new MockFundingProvider() };
  }
  if (!bound && opts.config?.providerType !== 'stripe') {
    return { kind: 'mock', provider: new MockFundingProvider() };
  }
  if (transfer.partnerId === DEFAULT_PARTNER_ID) return { kind: 'refused', reason: 'default_tenant' };
  if (transfer.settlementPartnerId) return { kind: 'refused', reason: 'routed' };
  const secretKey = opts.config?.providerType === 'stripe' ? opts.config.secretKey ?? '' : '';
  if (!secretKey) return { kind: 'refused', reason: 'unconfigured' };
  return { kind: 'stripe', provider: new StripeFundingProvider({ secretKey }, opts.fetchImpl) };
}

/**
 * The refund provider for a CHARGED transfer, chosen by what the LEDGER says
 * charged it — never by the current flag. A Stripe-funded row gets the Stripe
 * provider, whose refund() throws until the async refund lands (follow-up):
 * the durable refund row dead-letters and alerts instead of recording a fake
 * 'mockrefund-' completion with no money returned.
 */
export function refundProviderFor(transfer: Transfer): FundingProvider {
  if (transfer.fundingProvider === 'stripe') return new StripeFundingProvider({ secretKey: '' });
  return getFundingProvider();
}
