import type { Transfer } from '@/lib/types';

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

export interface CaptureResult {
  fundingRef: string;
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
  async capture(transfer: Transfer): Promise<CaptureResult> {
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
 * Provider selection. Mock-only today (mirrors paymentProviderMode); a real
 * PSP lands here as an 'http'-style implementation without touching call
 * sites — same swap pattern as getPaymentProvider.
 */
export function getFundingProvider(): FundingProvider {
  return new MockFundingProvider();
}
