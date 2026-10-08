import { NextResponse } from 'next/server';
import { getDb } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { getFundingProvider, isPendingCapture, selectFundingProvider } from './providers/funding-provider';
import { getPartnerIntegrationsStore } from './partner-integrations-store';
import { pokeWorker, pokeWorkerDelayed } from './outbox';
import { DELIVERY_DELAY_MS } from './providers/payment-provider';
import { logError } from './log';
import { env } from './env';
import { checkSettlementUrl } from './settlement-url';
import { settleOrHold } from './settlement';
import { isPartnerPulled } from './funding-method';
import type { Store } from './store';
import type { Transfer } from './types';

// pay-process — Batch B2: the shared payment steps of the two hosted pay pages,
// MOVED unchanged out of src/app/api/pay/[transferId]/route.ts so that route and
// the payment-link route (src/app/api/pay/l/[token]/route.ts) run the SAME
// refusal gates, the same capture and the same settle-or-hold. A move, not a
// change: the bodies below are byte-for-byte the route's (the pay-route-*
// tests stay green unchanged). Keep it that way: a behaviour change here is a
// change to both pages.

/**
 * Charge the sender via the funding provider, then persist the charge ref
 * write-once. THE ORDER IS THE INVARIANT (funding-provider.ts contract):
 * OTP → payout validation → status guard + compliance → capture →
 * setFundingRef → settleOrHold (settle or hold). Capture is idempotent by transfer id
 * (a replay re-presents the same charge, never a second one) and runs
 * OUTSIDE any DB transaction; the durable fundingRef is what makes the
 * capture→settle gap crash-safe (reconcile sweep resumes charged-but-
 * unsettled rows). A throw here means NO charge was recorded — the caller
 * returns a clean 402 and the customer retries the same link.
 */
export async function captureFunding(transfer: Transfer): Promise<void> {
  const result = await getFundingProvider().capture(transfer);
  // The legacy provider is synchronous; an async (pending) shape here would be
  // a wiring error — never record it as a charge.
  if (isPendingCapture(result)) throw new Error('unexpected async capture on the legacy funding path');
  await createTransferRepo(getDb()).setFundingRef(transfer.id, result.fundingRef);
}

/**
 * Program-Fix 7 — the funding decision for THIS transfer:
 *  - 'settle'  : money is (or is treated as) captured — continue to
 *                settleOrHold exactly as before (legacy mock / partner-settled
 *                capture, or an async debit that already SUCCEEDED and whose
 *                settlement a crash interrupted);
 *  - Response  : stop here. A Stripe capture is PENDING: the intent is bound
 *                (never as fundingRef), the browser gets the client secret to
 *                confirm, and settlement waits for the SIGNED webhook
 *                (/api/funding-webhook/stripe/<partnerId>). Refusals are 402s
 *                with nothing mutated.
 * Flag OFF (STRIPE_FUNDING_ENABLED unset) on a row never bound to a PSP intent
 * is the byte-identical legacy path: getFundingProvider().capture →
 * setFundingRef, with no config read.
 */
export async function fundTransfer(transfer: Transfer): Promise<'settle' | NextResponse> {
  const bound = transfer.fundingProvider === 'stripe' || !!transfer.fundingIntentRef;
  if (!env.stripeFundingEnabled && !bound) {
    await captureFunding(transfer);
    return 'settle';
  }
  if (transfer.fundingState === 'succeeded') return 'settle'; // charged; resume settlement
  if (transfer.fundingState === 'returned') {
    return NextResponse.json({ ok: false, error: 'payment_failed' }, { status: 402 });
  }
  const config = env.stripeFundingEnabled
    ? await getPartnerIntegrationsStore().getFundingConfig(transfer.partnerId)
    : null;
  const selection = selectFundingProvider(transfer, { enabled: env.stripeFundingEnabled, config });
  if (selection.kind === 'refused') {
    logError('pay.funding-refused', new Error(`funding refused: ${selection.reason}`), { transferId: transfer.id });
    return NextResponse.json({ ok: false, error: 'payment_failed' }, { status: 402 });
  }
  if (selection.kind === 'mock') {
    await captureFunding(transfer);
    return 'settle';
  }
  const pending = await selection.provider.capture(transfer);
  const repo = createTransferRepo(getDb());
  const boundRow = await repo.bindFundingIntent(transfer.id, transfer.partnerId, 'stripe', pending.intentRef);
  if (!boundRow) {
    // Moved, charged or bound to another intent since our read — never hand
    // out a secret for an intent the ledger does not hold.
    return NextResponse.json({ ok: false, error: 'payment_failed' }, { status: 409 });
  }
  // The client secret goes ONLY to this (OTP-verified) browser — never logged,
  // stored or queued (https://docs.stripe.com/api/payment_intents/object.md,
  // `client_secret`: "should not be stored, logged, or exposed to anyone
  // other than the customer").
  return NextResponse.json({ ok: true, status: 'awaiting_funds', clientSecret: pending.clientSecret });
}

/**
 * F53 refusal gate — the FIRST thing both the existing-transfer branch and
 * processTransferPayment run, BEFORE any saveTransfer, any capture and any
 * effect. A sender holding a valid per-transaction OTP must not be able to
 * (a) re-charge or re-hold a transfer that already moved (paid / delivered /
 * in_review), or (b) resurrect one staff cancelled / admin rejected. Anything
 * that is not a live awaiting_payment row reports CURRENT TRUTH in the same
 * shape the settlement replay branch uses (200 + status) — never a second
 * capture, a second stage-1 message or a second review entry. Blocked keeps
 * its 400 (a blocked transfer is never charged). Null ⇒ proceed.
 */
export function refuseUnlessAwaiting(transfer: Transfer): NextResponse | null {
  if (transfer.complianceStatus === 'blocked' || transfer.status === 'blocked') {
    return NextResponse.json({ ok: false, error: "We can't process this transfer." }, { status: 400 });
  }
  if (transfer.status !== 'awaiting_payment') {
    return NextResponse.json({ ok: true, status: transfer.status });
  }
  return null;
}

/**
 * Process payment for a resolved, LIVE (awaiting_payment) transfer.
 *
 * REFUSAL GATES — every one returns BEFORE captureFunding. THE ORDER IS THE
 * CONTRACT (ruling 7, route.ts half); every gate refuses before any charge:
 *   1. status guard + blocked (refuseUnlessAwaiting — F53)
 *   2. rail fail-closed (a routed rail must be webhook-driven, and — fix 22 —
 *      a webhook-driven rail, routed OR owner, must carry a settlement URL
 *      that passes checkSettlementUrl)
 * The masked-destination (fix 6), FX-unavailable (fix 9) and send-cap (fix 10)
 * guards do NOT live here: they are pay-finalize.ts's pre-claim contract
 * (kyc → masked destination → FX → cap → idem.claim) and run before a draft is
 * ever minted into the transfer this function receives. Never add a second
 * copy of any of them to this list. An EXISTING transfer's destination is
 * checked by POST's existing-transfer branch (hasDestination, decrypted read;
 * payout writes through writePayoutIfEditable) before it is handed to this
 * function.
 * Then: capture (skipped for partner-pulled B2B) → settleOrHold, which is the
 * ONE compliance decision (settlement.ts):
 *  - cleared  → beginSettlement: ONE transaction flips paid + enqueues the
 *               stage-1 message and the rail effect (Stage 2c — atomic).
 *  - flagged  → beginHold: ONE transaction flips in_review (paidAt set) +
 *               enqueues the held "under review" message; NO rail effect.
 *               Staff release (admin dashboard) is the only way forward.
 * Both charging branches capture funds FIRST — nothing messages "payment
 * received" or flips status before the charge succeeds.
 *
 * NON-CUSTODIAL B2B ACH-pull (`transferType === 'b2b'` + `fundingMethod === 'ach_pull'`): SmartRemit
 * captures NO funds — the licensed partner ACH-debits the payer's business bank
 * via the signed settlement instruction (which already carries the opaque
 * `achTokenRef` mandate). The capture step is SKIPPED entirely; the compliance
 * branching is otherwise identical. The skip is derived from the TRANSFER
 * (transferType === 'b2b' AND a partner-pulled fundingMethod — fix 6), NOT a
 * caller flag — so the non-custodial invariant holds no matter which call site
 * reaches here.
 */
export async function processTransferPayment(
  store: Store,
  transfer: Transfer,
): Promise<NextResponse> {
  const refused = refuseUnlessAwaiting(transfer);
  if (refused) return refused;

  // WL3 + best-rate routing: RAIL-side config (settlement URL/secret/
  // providerType) resolves via the ROUTED settlement partner when set. The
  // customer-facing WhatsApp message is BRAND-side: settleOrHold persists the
  // OWNING partnerId on the stage-1 row and the worker resolves that partner's
  // creds at drain time (fix 11) — so no brand-side read happens here.
  const railPartnerId = transfer.settlementPartnerId ?? transfer.partnerId;
  const railIntegrations = await getPartnerIntegrationsStore().getIntegrations(railPartnerId);

  // Fail-closed: a ROUTED transfer must settle on the settlement partner's
  // webhook-driven rail. Routing eligibility was checked at quote time — if
  // their config was removed or downgraded since (providerType OR the
  // settlement endpoint: the same pair quote-time eligibility requires),
  // refuse BEFORE any charge rather than silently falling into the mock
  // branch (a fake delivery the owning partner never opted into) or charging
  // into an instruct that can only dead-letter. (The status guard above
  // already returned current truth for a replay, so this only ever sees
  // money that can still be charged.)
  const railProviderType = railIntegrations.payment.providerType;
  const railWebhookDriven = railProviderType === 'http' || railProviderType === 'simulator';
  if (transfer.settlementPartnerId) {
    if (!railWebhookDriven || !railIntegrations.payment.credentials?.settlementUrl) {
      logError(
        'pay.routed-rail-unavailable',
        new Error('routed settlement partner has no usable webhook-driven rail'),
        { transferId: transfer.id },
      );
      return NextResponse.json({ ok: false, error: 'Payment failed' }, { status: 400 });
    }
  }
  // Fix 22 (gate #2, owner AND routed rail): a webhook-driven rail whose
  // settlement URL fails the sync rule (https only, default port, no userinfo,
  // no IP literal / internal / single-label host; empty counts as failing) is
  // refused BEFORE any charge. The worker would refuse the instruct anyway
  // (settlement_url_refused), so charging here could only dead-letter. The
  // log carries the reason code, never the URL.
  if (railWebhookDriven) {
    const railUrl = railIntegrations.payment.credentials?.settlementUrl ?? '';
    const check = checkSettlementUrl(railUrl, { appOrigin: env.appBaseUrl, production: env.isProduction });
    if (!check.ok) {
      logError('pay.rail-url-refused', new Error(`settlement url refused: ${check.reason}`), {
        transferId: transfer.id,
        railPartnerId,
      });
      return NextResponse.json({ ok: false, error: 'Payment failed' }, { status: 400 });
    }
  }

  // ── FUNDS CAPTURE — after every refusal gate, before any effect ──────────
  // Every gate above returns BEFORE this point (those transfers are never
  // charged). A capture failure mutates nothing: no status change, no charge
  // recorded, no message — a clean 402 and the link stays retryable.
  // Idempotent capture + write-once setFundingRef make a crash-retry harmless
  // (and the reconcile sweep resumes a charged-but-unsettled row).
  //
  // NON-CUSTODIAL B2B pull (ach_pull / bank_pull): SmartRemit captures NOTHING —
  // the partner pulls via the signed instruction. Skip the funding provider
  // entirely (derived from the transfer, so this holds for EVERY call site).
  if (!(transfer.transferType === 'b2b' && isPartnerPulled(transfer.fundingMethod))) {
    try {
      const funded = await fundTransfer(transfer);
      if (funded !== 'settle') return funded; // async capture pending, or refused
    } catch (err) {
      logError('pay.capture', err, { transferId: transfer.id });
      return NextResponse.json({ ok: false, error: 'payment_failed' }, { status: 402 });
    }
  }

  // The ONE compliance decision: settle (cleared) or hold (flagged) — each an
  // atomic transaction whose effects are dedupe-keyed outbox rows. settleOrHold
  // decides the rail purely from the PASSED integrations — hand it the RAIL
  // partner's config; the stage-1 row names the OWNER (transfer.partnerId).
  const result = await settleOrHold(getDb(), transfer, railIntegrations);
  pokeWorker(); // fast-path drain (the stage-1 / held message is READY now)
  switch (result.kind) {
    case 'held':
      return NextResponse.json({ ok: true, status: 'in_review' });
    case 'already': {
      // Double submit / replay — the first settlement won; report current truth.
      const current = await store.getTransfer(transfer.id);
      // A charged row that is NOT awaiting_payment and NOT paid/in_review is the
      // capture↔cancel race (captureFunding = provider.capture THEN
      // setFundingRef, so a staff cancel landing after the status guard above
      // leaves a cancelled row that WAS charged — fix 5's staff cancel claim,
      // transfer-repo.cancelIfCancellable (`funding_ref IS NULL`), cannot see
      // that window either). Say
      // so loudly — the reconcile sweep's cancelcharged:<id> alert is the
      // durable signal; this log is the fast one.
      if (current?.fundingRef && current.status === 'cancelled' && (current.refundStatus ?? 'none') === 'none') {
        logError('pay.charged-but-cancelled', new Error('customer charged on a cancelled transfer'), { transferId: transfer.id });
      }
      return NextResponse.json({ ok: true, status: current?.status ?? 'paid' });
    }
    case 'refused':
      // Unreachable after refuseUnlessAwaiting (kept exhaustive on purpose: a
      // refusal must never read as success). The charge, if any, is visible
      // on the ledger via fundingRef; the reconcile sweep raises the
      // fundblocked:<id> alert, whose remedy is a change-ticket ledger edit
      // (no dashboard action applies to a charged blocked row).
      logError('pay.settle-refused', new Error('settlement refused by compliance after capture'), {
        transferId: transfer.id,
      });
      return NextResponse.json({ ok: false, error: "We can't process this transfer." }, { status: 400 });
    case 'started':
      if (!result.webhookDriven) {
        // Mock rail: the delivered confirmation is a DELAYED outbox row
        // (DELIVERY_DELAY_MS) that the immediate poke above can't see — schedule
        // a best-effort second poke for just after the delay elapses so the
        // customer isn't waiting on the next cron tick. Real rails are
        // webhook-driven (the callback pokes).
        pokeWorkerDelayed(DELIVERY_DELAY_MS + 10_000);
      }
      return NextResponse.json({ ok: true, status: result.webhookDriven ? 'processing' : 'paid' });
  }
}
