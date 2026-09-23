import { and, eq } from 'drizzle-orm';
import type { Db, DbOrTx } from '@/db/client';
import { fundingEvents } from '@/db/schema';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { settleOrHold } from '@/lib/settlement';
import { toMinorUnits } from '@/lib/funding-amount';
import { logError } from '@/lib/log';
import type { StripeFundingEvent } from '@/lib/providers/stripe-funding-provider';
import type { PartnerId, Transfer } from '@/lib/types';

// stripe-funding-webhook — Program-Fix 7: apply ONE signature-verified Stripe
// event (from the partner whose endpoint secret verified it) to the ledger.
//
// Money invariants (each has a test in tests/stripe-funding-webhook.test.ts):
//  • No paid flip without a verified capture. The only event that records a
//    charge is `payment_intent.succeeded`, and only after it is cross-checked
//    against THIS tenant's bound intent: intent id, metadata transfer/partner,
//    amount_received == the ledger amount in minor units, currency usd.
//    Settlement then goes through settleOrHold — the ONE paid-flip path — and
//    the ledger claims themselves carry the funding gate (transfer-repo).
//  • No double capture / double settlement. The event id is claimed in
//    funding_events inside the SAME transaction as the transition it causes
//    (a crash rolls both back and Stripe redelivers); the guarded transition
//    is the primary guard (a second event id for the same object is a no-op),
//    and settleOrHold's claims are idempotent.
//  • Durability. The funded transition commits first; settleOrHold runs right
//    after as the fast path. If it fails, the row is "charged but awaiting"
//    (funding_ref set, funding_state succeeded) and the reconcile crash-resume
//    sweep (listAwaitingWithFunding) settles it — the same recovery the
//    synchronous capture always had.
//  • Returns are never silent. A dispute (Stripe's shape for a late ACH
//    return after success — https://docs.stripe.com/payments/ach-direct-debit,
//    "Transaction failures") marks the debit `returned` (the gate then blocks
//    any later paid / hold / release claim) and raises ONE deduped ops alert.
//    It never auto-refunds: a refund while a dispute is open can credit the
//    sender twice (same page, "Refunds" / "Disputes").
//  • Mismatches, unknown intents and test-mode successes move nothing and
//    raise ONE deduped ops alert each. Alert text carries ids only (transfer,
//    partner, intent, charge, dispute) — never names, phones or accounts.

export type StripeEventOutcome =
  | 'duplicate'
  | 'processing'
  | 'funded'
  | 'funded_not_settled'
  | 'noop'
  | 'mismatch'
  | 'unknown_intent'
  | 'test_mode_ignored'
  | 'failed'
  | 'returned'
  | 'inquiry'
  | 'unmatched_dispute';

export interface StripeEventResult {
  outcome: StripeEventOutcome;
  transferId?: string;
}

export interface ProcessDeps {
  /** Accept livemode:false successes (STRIPE_FUNDING_ALLOW_TEST_MODE). Default false. */
  allowTestMode?: boolean;
  /** Injection seam for tests (crash-in-transaction). */
  transferRepo?: typeof createTransferRepo;
}

const PROVIDER = 'stripe';

async function claimEvent(tx: DbOrTx, partnerId: PartnerId, eventId: string, eventType: string): Promise<boolean> {
  const rows = await tx
    .insert(fundingEvents)
    .values({ partnerId, provider: PROVIDER, eventId, eventType, outcome: 'processing' })
    .onConflictDoNothing()
    .returning({ eventId: fundingEvents.eventId });
  return rows.length > 0;
}

async function recordOutcome(tx: DbOrTx, partnerId: PartnerId, eventId: string, outcome: StripeEventOutcome, transferId?: string) {
  await tx
    .update(fundingEvents)
    .set({ outcome, transferId: transferId ?? null })
    .where(and(
      eq(fundingEvents.partnerId, partnerId),
      eq(fundingEvents.provider, PROVIDER),
      eq(fundingEvents.eventId, eventId),
    ));
}

function alert(tx: DbOrTx, dedupeKey: string, message: string) {
  return createOutboxRepo(tx).enqueue('ops.alert', { message: `⚠️ SmartRemit ops: ${message}` }, { dedupeKey });
}

const EVENT_TYPE: Record<StripeFundingEvent['kind'], string> = {
  succeeded: 'payment_intent.succeeded',
  failed: 'payment_intent.payment_failed',
  canceled: 'payment_intent.canceled',
  processing: 'payment_intent.processing',
  dispute: 'charge.dispute.created',
};

/** Why a verified success does not match the bound transfer; null ⇒ it matches. */
function mismatch(
  e: Extract<StripeFundingEvent, { kind: 'succeeded' }>,
  t: Transfer,
  partnerId: PartnerId,
): string | null {
  if (e.partnerId !== partnerId || t.partnerId !== partnerId) return 'partner';
  if (e.transferId !== t.id) return 'transfer';
  if (t.sourceCurrency !== 'USD' || e.currency !== 'usd') return 'currency';
  let expected: number;
  try {
    expected = toMinorUnits(t.totalChargeSource);
  } catch {
    return 'amount';
  }
  if (e.amountReceived !== expected) return 'amount';
  return null;
}

export async function processStripeFundingEvent(
  db: Db,
  partnerId: PartnerId,
  event: StripeFundingEvent,
  deps: ProcessDeps = {},
): Promise<StripeEventResult> {
  const makeRepo = deps.transferRepo ?? createTransferRepo;

  const result = await db.transaction(async (tx): Promise<StripeEventResult & { settle?: Transfer }> => {
    if (!(await claimEvent(tx, partnerId, event.eventId, EVENT_TYPE[event.kind]))) {
      return { outcome: 'duplicate' };
    }
    const repo = makeRepo(tx);
    const done = async (r: StripeEventResult & { settle?: Transfer }) => {
      await recordOutcome(tx, partnerId, event.eventId, r.outcome, r.transferId);
      return r;
    };

    if (event.kind === 'dispute') {
      const row = event.intentId ? await repo.findByFundingIntent(partnerId, event.intentId) : null;
      if (!row) {
        await alert(
          tx,
          `stripedispute:${partnerId}:${event.disputeId}`,
          `partner ${partnerId} received a Stripe dispute ${event.disputeId} (charge ${event.chargeId}, reason ${event.reason || 'unknown'}) that matches no SmartRemit transfer — check the partner's Stripe dashboard.`,
        );
        return done({ outcome: 'unmatched_dispute' });
      }
      if (event.status.startsWith('warning_')) {
        // An authorization INQUIRY, not a return: evidence is due; funds stay.
        await alert(
          tx,
          `stripeinquiry:${partnerId}:${event.disputeId}`,
          `transfer ${row.id} (partner ${partnerId}): Stripe opened an ACH authorization inquiry ${event.disputeId} (${event.status}). Upload the mandate evidence in the partner's Stripe dashboard before the deadline.`,
        );
        return done({ outcome: 'inquiry', transferId: row.id });
      }
      const returned = await repo.markFundingReturned(partnerId, event.intentId!);
      if (!returned) return done({ outcome: 'noop', transferId: row.id });
      const afterPayout = returned.status === 'paid' || returned.status === 'delivered';
      await alert(
        tx,
        `stripereturn:${returned.id}`,
        `transfer ${returned.id} (partner ${partnerId}): the sender's debit was RETURNED / disputed (${event.reason || 'unknown'}, dispute ${event.disputeId}, intent ${event.intentId}). ` +
          (afterPayout
            ? `Status is '${returned.status}' — the payout may already be out. Recall it from the rail if still possible, and recover per the partner agreement. Do NOT issue a refund: the dispute already credits the sender.`
            : `Status is '${returned.status}' — the payout is now blocked (it can never be released). Cancel it; do NOT refund (the dispute already credits the sender).`),
      );
      return done({ outcome: 'returned', transferId: returned.id });
    }

    const row = await repo.findByFundingIntent(partnerId, event.intentId);
    if (!row) {
      await alert(
        tx,
        `stripeunknown:${partnerId}:${event.intentId}`,
        `partner ${partnerId} sent a verified Stripe ${EVENT_TYPE[event.kind]} for intent ${event.intentId} that matches no transfer of theirs. Nothing moved.`,
      );
      return done({ outcome: 'unknown_intent' });
    }

    if (event.kind === 'processing') return done({ outcome: 'processing', transferId: row.id });

    if (event.kind === 'failed' || event.kind === 'canceled') {
      const failed = await repo.markFundingFailed(row.id, partnerId, event.intentId);
      return done({ outcome: failed ? 'failed' : 'noop', transferId: row.id });
    }

    // payment_intent.succeeded (every other kind returned above)
    if (event.kind !== 'succeeded') return done({ outcome: 'noop', transferId: row.id });
    if (!event.livemode && !deps.allowTestMode) {
      await alert(
        tx,
        `stripetestmode:${partnerId}:${event.intentId}`,
        `transfer ${row.id} (partner ${partnerId}): a TEST-MODE Stripe success arrived (intent ${event.intentId}). Test-mode funds never settle a transfer; nothing moved.`,
      );
      return done({ outcome: 'test_mode_ignored', transferId: row.id });
    }
    const why = mismatch(event, row, partnerId);
    if (why) {
      await alert(
        tx,
        `stripemismatch:${row.id}`,
        `transfer ${row.id} (partner ${partnerId}): a verified Stripe success for intent ${event.intentId} does NOT match the ledger (${why}). Nothing settled — reconcile in the partner's Stripe dashboard.`,
      );
      return done({ outcome: 'mismatch', transferId: row.id });
    }
    const funded = await repo.markFundingSucceeded(row.id, partnerId, event.intentId);
    if (!funded) return done({ outcome: 'noop', transferId: row.id });
    if (funded.status !== 'awaiting_payment' || funded.complianceStatus === 'blocked') {
      await alert(
        tx,
        `stripechargedmoved:${funded.id}`,
        `transfer ${funded.id} (partner ${partnerId}) was CHARGED through Stripe (intent ${event.intentId}) but is '${funded.status}' / compliance '${funded.complianceStatus}' — it will NOT be settled. Refund it in the partner's Stripe dashboard and record the outcome.`,
      );
      return done({ outcome: 'funded_not_settled', transferId: funded.id });
    }
    return done({ outcome: 'funded', transferId: funded.id, settle: funded });
  });

  if (result.settle) {
    const t = result.settle;
    try {
      const rail = await createIntegrationsRepo(db).getIntegrations(t.settlementPartnerId ?? t.partnerId);
      const settled = await settleOrHold(db, t, rail);
      if (settled.kind === 'refused') {
        await alert(
          db,
          `fundblocked:${t.id}`,
          `transfer ${t.id} (partner ${t.partnerId}) was CHARGED through Stripe but is BLOCKED by compliance — NOT settled. Refund it in the partner's Stripe dashboard.`,
        );
      }
    } catch (err) {
      // Funds are durably recorded; the reconcile crash-resume sweep settles it.
      logError('stripe-funding.settle', err, { transferId: t.id });
    }
  }
  return { outcome: result.outcome, ...(result.transferId ? { transferId: result.transferId } : {}) };
}
