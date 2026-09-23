import type { Db } from '@/db/client';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { settleOrHold } from '@/lib/settlement';
import { rescreenBeforePay, type RescreenOutcome } from '@/lib/pay-rescreen';
import { resolveCorridorRules } from '@/lib/compliance-config';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { getPartnerStore } from '@/lib/partner-store';
import type { Transfer } from '@/lib/types';

// stripe-funded-settle — Program-Fix 7 (review M2): the ONE way a
// Stripe-FUNDED transfer (funding_state 'succeeded') settles. An ACH debit can
// confirm up to 4 business days after the pay-time re-screen
// (https://docs.stripe.com/payments/ach-direct-debit, "Timing"), so both
// parties are RE-SCREENED immediately before settlement — sanctions always
// runs — then settleOrHold (the one paid-flip path) decides:
//   cleared → settle · flagged → hold (in_review) · blocked → never settled +
//   ONE ops alert (refund in the partner's Stripe dashboard) · moved → no-op.
// A re-screen error throws BEFORE anything moves; the caller logs it and the
// reconcile crash-resume sweep retries on its next run.
// Callers: the Stripe webhook fast path (stripe-funding-webhook.ts) and the
// reconcile sweep for Stripe rows (reconcile.ts).

export type FundedSettleResult = 'started' | 'held' | 'already' | 'blocked' | 'moved' | 'refused';

export interface FundedSettleDeps {
  rescreen?: (t: Transfer) => Promise<RescreenOutcome>;
}

/** The pay route's re-screen inputs, resolved server-side (names never logged). */
async function defaultRescreen(db: Db, t: Transfer): Promise<RescreenOutcome> {
  const store = getStore();
  const owner = await getCustomerStore(store).getCustomer(t.partnerId, t.phone);
  const partner = (await getPartnerStore().getPartner(t.partnerId)) ?? (await getPartnerStore().ensureDefaultPartner());
  const decrypted = await store.getTransferDecrypted(t.id);
  return rescreenBeforePay(
    db,
    t,
    {
      senderName: (owner?.fullName ?? '').trim(),
      recipientName: (decrypted?.recipientLegalName ?? '').trim() || t.recipientName,
    },
    resolveCorridorRules(partner, t.sourceCountry ?? 'US'),
  );
}

export async function settleFundedTransfer(db: Db, t: Transfer, deps: FundedSettleDeps = {}): Promise<FundedSettleResult> {
  const outcome = await (deps.rescreen ?? ((x: Transfer) => defaultRescreen(db, x)))(t);
  if (outcome.kind === 'moved') return 'moved';
  if (outcome.kind === 'blocked') {
    await createOutboxRepo(db).enqueue(
      'ops.alert',
      {
        message:
          `⚠️ SmartRemit ops: transfer ${t.id} (partner ${t.partnerId}) was CHARGED through Stripe (${t.fundingRef ?? t.fundingIntentRef}) ` +
          `but the pre-settlement sanctions re-screen BLOCKED it — NOT settled. Refund it in the partner's Stripe dashboard and record the outcome.`,
      },
      { dedupeKey: `fundblocked:${t.id}` },
    );
    return 'blocked';
  }
  const rail = await createIntegrationsRepo(db).getIntegrations(t.settlementPartnerId ?? t.partnerId);
  const settled = await settleOrHold(db, outcome.transfer, rail);
  if (settled.kind === 'refused') {
    await createOutboxRepo(db).enqueue(
      'ops.alert',
      { message: `⚠️ SmartRemit ops: transfer ${t.id} (partner ${t.partnerId}) was CHARGED through Stripe but is BLOCKED by compliance — NOT settled. Refund it in the partner's Stripe dashboard.` },
      { dedupeKey: `fundblocked:${t.id}` },
    );
    return 'refused';
  }
  return settled.kind;
}
