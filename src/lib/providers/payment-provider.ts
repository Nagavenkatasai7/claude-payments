import type { Store } from '../store';
import type { Transfer, TransferStatus } from '../types';
import { completePaymentStage1 } from '../payment';
import { sendText, type WaCreds } from '../whatsapp';
import type { PartnerPaymentConfig } from '../partner-integrations';
import { HttpPaymentProvider } from './http-payment-provider';
import type { OutboxRepo } from '@/db/repos/outbox-repo';

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
 * ROADMAP Lane C) implements this against the documented contract — SmartRemit
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
  // WL1: `brand` flavors only the stage-2 "Thanks for using …" line; absent ⇒
  // 'SmartRemit' (default partner unchanged). WL2: `waCreds` sends the stage
  // messages from the partner's own number (absent ⇒ shared env number).
  // Stage 2b: stage-2 is a DURABLE outbox row (delayed mock.settle), not a
  // best-effort after() sleep — a killed function can no longer strand a
  // transfer in 'paid'.
  constructor(
    private readonly store: Store,
    private readonly outbox: OutboxRepo,
    private readonly brand?: string,
    private readonly waCreds?: WaCreds,
  ) {}

  async initiateTransfer(transfer: Transfer): Promise<InitiateResult> {
    // Stage 1 — identical to today's route body (payment.ts UNTOUCHED).
    const { transfer: t1, senderMessages } = await completePaymentStage1(this.store, transfer.id);
    for (const msg of senderMessages) await sendText(t1.phone, msg, this.waCreds);

    // Stage 2 — a delayed, deduped outbox row drained by /api/worker. The
    // same 2-minute sandbox lag, now guaranteed-eventually instead of
    // lost-if-the-function-dies.
    await this.outbox.enqueue(
      'mock.settle',
      { transferId: transfer.id, partnerId: transfer.partnerId },
      { delayMs: DELIVERY_DELAY_MS, dedupeKey: `mocksettle:${transfer.id}` },
    );

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
 * Single switch point (mirrors getSanctionsScreener / getKycProvider). Now
 * PER-PARTNER (WL1): the optional `payment` config selects this partner's
 * settlement rail. absent / 'mock' / unknown ⇒ MockPaymentProvider — so the
 * default partner (no integrations row) and every sandbox partner are
 * byte-for-byte unchanged. A REAL rail (Phase C only) is added as a new case,
 * gated on a signed licensed partner + creds; NON-CUSTODIAL boundary applies
 * (see the PaymentProvider contract above — SmartRemit never holds funds).
 * Takes `store` because the mock runs the stages against it.
 */
export function getPaymentProvider(
  store: Store,
  outbox: OutboxRepo, // Stage 2b: durable stage-2 / settlement effects
  payment?: PartnerPaymentConfig,
  brand?: string, // WL1: end-customer brand for the stage messages
  waCreds?: WaCreds, // WL2: partner's outbound WhatsApp creds for the stage messages
): PaymentProvider {
  switch (payment?.providerType) {
    // WL3: the REAL rail adapter — the partner's settlement endpoint executes the
    // payout (non-custodial; we relay the signed instruction + mirror callbacks).
    // 'simulator' is the SAME adapter pointed at our hosted reference rail
    // (/api/partner-rail), so even the demo exercises the genuine webhook loop.
    case 'http':
    case 'simulator':
      return new HttpPaymentProvider(store, payment!, brand, waCreds);
    case undefined:
    case 'mock':
    default:
      return new MockPaymentProvider(store, outbox, brand, waCreds);
  }
}
