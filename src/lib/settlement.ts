import type { Db } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { DELIVERY_DELAY_MS } from '@/lib/providers/payment-provider';
import { buildStage1Message } from '@/lib/payment';
import type { PartnerIntegrations } from '@/lib/partner-integrations';
import type { WaCreds } from '@/lib/whatsapp';
import type { Transfer } from '@/lib/types';

// settlement — THE transactional "money was paid" entry point (Stage 2c).
//
// One Postgres transaction commits, together:
//   • the awaiting_payment → paid status flip (atomic claim — a double submit
//     or crash-replay flips nothing and is a clean no-op),
//   • the customer's stage-1 "payment received" message (outbox, deduped),
//   • the settlement effect for the partner's rail:
//       http/simulator → a SIGNED settlement.instruct row (the worker POSTs it
//                        with retries; delivery arrives via the partner's
//                        signed callback — fully webhook-driven),
//       mock          → a DELAYED mock.settle row (the sandbox 2-min lag).
//
// This closes the worst crash window the audit found: previously the customer
// could be told "payment received" while the rail was never instructed (or
// vice-versa). Now the state flip and every effect are one atomic unit, and
// each effect is dedupe-keyed so retries can never double-send.
//
// NON-CUSTODIAL: SmartRemit never holds funds — `paid` mirrors the charge the
// PARTNER captured on their rail; the instruction tells their rail to pay out.

export type SettlementResult =
  | { kind: 'started'; webhookDriven: boolean }
  | { kind: 'already' }; // not awaiting_payment anymore — idempotent no-op

export async function beginSettlement(
  db: Db,
  transfer: Transfer,
  integrations: PartnerIntegrations,
  waCreds?: WaCreds,
): Promise<SettlementResult> {
  const providerType = integrations.payment.providerType;
  const webhookDriven = providerType === 'http' || providerType === 'simulator';

  const flipped = await db.transaction(async (tx) => {
    const paid = await createTransferRepo(tx).markPaidIfAwaiting(transfer.id);
    if (!paid) return null;

    const outbox = createOutboxRepo(tx);
    await outbox.enqueue(
      'whatsapp.text',
      { to: paid.phone, body: buildStage1Message(paid), creds: waCreds },
      { dedupeKey: `stage1:${paid.id}` },
    );
    if (webhookDriven) {
      await outbox.enqueue(
        'settlement.instruct',
        { transferId: paid.id },
        { dedupeKey: `instruct:${paid.id}` },
      );
    } else {
      await outbox.enqueue(
        'mock.settle',
        { transferId: paid.id, partnerId: paid.partnerId },
        { delayMs: DELIVERY_DELAY_MS, dedupeKey: `mocksettle:${paid.id}` },
      );
      // Parity with the old mock provider's deterministic ref.
      await createTransferRepo(tx).setProviderRef(paid.id, `mock-${paid.id}`);
    }
    return paid;
  });

  return flipped ? { kind: 'started', webhookDriven } : { kind: 'already' };
}
