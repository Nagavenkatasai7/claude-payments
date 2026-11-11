import type { Db } from '@/db/client';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { settleOrHold } from '@/lib/settlement';
import { rescreenOnFile, type RescreenOutcome } from '@/lib/pay-rescreen';
import { railPartnerOf, realMoneyRail } from '@/lib/live-gate';
import { SANCTIONS_NO_PAYOUT_SENTENCE } from '@/lib/sanctions/notices';
import type { Transfer } from '@/lib/types';

// stripe-funded-settle — Program-Fix 7 (review M2): the ONE way a
// Stripe-FUNDED transfer (funding_state 'succeeded') settles. An ACH debit can
// confirm up to 4 business days after the pay-time re-screen
// (https://docs.stripe.com/payments/ach-direct-debit, "Timing"), so both
// parties are RE-SCREENED immediately before settlement — sanctions always
// runs — then settleOrHold (the one paid-flip path) decides:
//   cleared → settle · flagged → hold (in_review) · blocked → never settled +
//   ONE ops alert · moved → no-op. Review S5 (W1): both fundblocked texts are
//   sanctions blocks (a re-screen match, or settleOrHold refusing a row whose
//   compliance status is 'blocked', which only a sanctions match sets), so
//   they never say to refund: the funds can have to be blocked (frozen) and
//   the licensed partner's compliance officer decides first.
// A re-screen error throws BEFORE anything moves; the caller logs it and the
// reconcile crash-resume sweep retries on its next run.
// Callers: the Stripe webhook fast path (stripe-funding-webhook.ts) and the
// reconcile sweep for Stripe rows (reconcile.ts).

export type FundedSettleResult = 'started' | 'held' | 'already' | 'blocked' | 'moved' | 'refused';

export interface FundedSettleDeps {
  rescreen?: (t: Transfer, opts: { realMoney: boolean }) => Promise<RescreenOutcome>;
}

export async function settleFundedTransfer(db: Db, t: Transfer, deps: FundedSettleDeps = {}): Promise<FundedSettleResult> {
  // Fix pack 2 T3 (R02): the RAIL partner's config (routed, else owner) is read
  // FIRST — a read that throws propagates before anything is screened or
  // moved — and decides real money: an http rail re-screens on a live list
  // with full name coverage (pay-rescreen.ts).
  const rail = await createIntegrationsRepo(db).getIntegrations(railPartnerOf(t));
  const realMoney = realMoneyRail({ environment: t.environment, railProviderType: rail.payment.providerType ?? null });
  const rescreen = deps.rescreen ?? ((x: Transfer, opts: { realMoney: boolean }) => rescreenOnFile(db, x, { ...opts, stage: 'pay' }));
  const outcome = await rescreen(t, { realMoney });
  if (outcome.kind === 'moved') return 'moved';
  if (outcome.kind === 'blocked') {
    await createOutboxRepo(db).enqueue(
      'ops.alert',
      {
        message:
          `⚠️ SmartRemit ops: transfer ${t.id} (partner ${t.partnerId}) was CHARGED through Stripe (${t.fundingRef ?? t.fundingIntentRef}) ` +
          `but the pre-settlement sanctions re-screen BLOCKED it — NOT settled. ${SANCTIONS_NO_PAYOUT_SENTENCE}; evidence on the compliance page.`,
      },
      { dedupeKey: `fundblocked:${t.id}` },
    );
    return 'blocked';
  }
  const settled = await settleOrHold(db, outcome.transfer, rail);
  if (settled.kind === 'refused') {
    await createOutboxRepo(db).enqueue(
      'ops.alert',
      // settleOrHold refuses only a compliance-blocked row (a sanctions match).
      {
        message:
          `⚠️ SmartRemit ops: transfer ${t.id} (partner ${t.partnerId}) was CHARGED through Stripe but is BLOCKED by sanctions screening — NOT settled. ` +
          `${SANCTIONS_NO_PAYOUT_SENTENCE}; evidence on the compliance page.`,
      },
      { dedupeKey: `fundblocked:${t.id}` },
    );
    return 'refused';
  }
  return settled.kind;
}
