import { after } from 'next/server';
import type { Store } from '../store';
import type { Transfer, TransferStatus } from '../types';
import {
  completePaymentStage1, completePaymentStage2, recipientTemplateParams,
} from '../payment';
import {
  sendText, sendTemplate, RECIPIENT_TEMPLATE_NAME, RECIPIENT_TEMPLATE_LANG,
} from '../whatsapp';

export const DELIVERY_DELAY_MS = 120000; // 2 minutes — moved from the pay route, SAME value

// Provider-side lifecycle, mapped to our TransferStatus in handleWebhook/update.
// created → 'awaiting_payment'; funded → 'paid'; paid_out → 'delivered'.
export type PaymentProviderStatus = 'created' | 'funded' | 'paid_out' | 'failed';

export interface InitiateResult {
  providerRef: string;          // partner's settlement id; persisted onto Transfer.paymentProviderRef
}

export interface WebhookResult {
  transferId: string;           // OUR transfer id (the partner echoes it back)
  status: TransferStatus;       // already mapped to our domain ('paid' | 'delivered')
}

/**
 * The pluggable settlement seam, mirroring KycProvider / SanctionsScreener.
 *
 * A REAL Uniteller-shaped partner (the AD-II / money-transmitter of record per
 * ROADMAP Lane C) implements this against the documented contract — SendHome
 * NEVER holds funds:
 *
 *   initiateTransfer POSTs a settlement instruction:
 *     { reference: transfer.id,
 *       corridor: { source: transfer.sourceCountry, destination: 'IN' },
 *       payout:   { rail: transfer.payoutMethod, destination: transfer.payoutDestination },
 *       recipient:{ name: transfer.recipientName, phone: transfer.recipientPhone },
 *       amount:   { source: transfer.amountSource, currency: transfer.sourceCurrency,
 *                   destination: transfer.amountInr, destinationCurrency: 'INR',
 *                   fxRate: transfer.fxRate } }     // FX LOCKED at quote time
 *     → 200 { providerRef } → becomes Transfer.paymentProviderRef
 *
 *   The partner then posts status callbacks to POST /api/payment-webhook/[provider]:
 *     created  → 'awaiting_payment'  (no-op)
 *     funded   → 'paid'              (stage-1 effect)
 *     paid_out → 'delivered'         (fires stage-2 notifications once)
 *     failed   → (not mapped in v1; logged/ignored — reversal is out of scope)
 *
 * No real client is built in this batch; the contract is documented here only.
 */
export interface PaymentProvider {
  // Begin settlement. Mock self-advances both stages; a real provider POSTs
  // the instruction and returns, settling asynchronously via the webhook.
  initiateTransfer(transfer: Transfer): Promise<InitiateResult>;
  // Poll provider-side status (real: API call; mock: derive from the store).
  getStatus(providerRef: string): Promise<PaymentProviderStatus>;
  // Parse + map an inbound callback to our domain, or null if irrelevant.
  handleWebhook(body: unknown): Promise<WebhookResult | null>;
}

export class MockPaymentProvider implements PaymentProvider {
  constructor(private readonly store: Store) {}

  async initiateTransfer(transfer: Transfer): Promise<InitiateResult> {
    // Stage 1 — identical to today's route body (payment.ts UNTOUCHED).
    const { transfer: t1, senderMessages } = await completePaymentStage1(this.store, transfer.id);
    for (const msg of senderMessages) await sendText(t1.phone, msg);

    // Stage 2 — the SAME after()/setTimeout(DELIVERY_DELAY_MS) self-advance.
    after(async () => {
      try {
        await new Promise((resolve) => setTimeout(resolve, DELIVERY_DELAY_MS));
        const stage2 = await completePaymentStage2(this.store, transfer.id);
        for (const msg of stage2.senderMessages) await sendText(stage2.transfer.phone, msg);
        if (stage2.transfer.recipientPhone) {
          await sendTemplate(
            stage2.transfer.recipientPhone, RECIPIENT_TEMPLATE_NAME, RECIPIENT_TEMPLATE_LANG,
            recipientTemplateParams(stage2.transfer),
          );
        }
      } catch (err) {
        console.error('Stage-2 delivery failed:', err);
      }
    });

    return { providerRef: `mock-${transfer.id}` };
  }

  async getStatus(providerRef: string): Promise<PaymentProviderStatus> {
    const id = providerRef.startsWith('mock-') ? providerRef.slice('mock-'.length) : null;
    const t = id ? await this.store.getTransfer(id) : null;
    if (!t) return 'created';
    if (t.status === 'delivered') return 'paid_out';
    if (t.status === 'paid') return 'funded';
    return 'created';
  }

  // The mock self-advances and never posts callbacks → no-op (mirrors MockKycProvider).
  async handleWebhook(_body: unknown): Promise<WebhookResult | null> {
    return null;
  }
}

/**
 * Single switch point (mirrors getSanctionsScreener). v1 has only the mock;
 * a real provider is added here, selected by env.paymentProviderMode — no
 * call-site change. Takes `store` because the mock runs the stages against it.
 */
export function getPaymentProvider(store: Store): PaymentProvider {
  return new MockPaymentProvider(store);
}
