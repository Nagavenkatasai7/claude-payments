import { randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { getDraftStore } from '@/lib/draft-store';
import { getPartnerStore } from '@/lib/partner-store';
import { getMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { getDailyVolumeStore } from '@/lib/daily-volume-store';
import { finalizeDraftPayment, type BankDetails } from '@/lib/pay-finalize';
import { isB2bSendVerified, isSendVerified, sendGateActive } from '@/lib/kyc-gate';
import { getPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { getDb } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { DEFAULT_DESTINATION_COUNTRY } from '@/lib/defaults';
import { getFundingProvider } from '@/lib/providers/funding-provider';
import { pokeWorker, pokeWorkerDelayed } from '@/lib/outbox';
import { DELIVERY_DELAY_MS } from '@/lib/providers/payment-provider';
import { enforceIpRateLimit } from '@/lib/ip-rate-limit';
import { logError } from '@/lib/log';
import { env } from '@/lib/env';
import { checkSettlementUrl } from '@/lib/settlement-url';
import { settleOrHold } from '@/lib/settlement';
import { waCredsFrom } from '@/lib/whatsapp-creds';
import { getTransactionOtpStore } from '@/lib/transaction-otp';
import { sendTransactionOtp, type WaCreds } from '@/lib/whatsapp';
import { validatePayoutFields, BANK_FIELDS_BY_COUNTRY, isMaskedDestination, accountLast4 } from '@/lib/payout-format';
import { isPartnerPulled } from '@/lib/funding-method';
import type { CountryCode, Transfer } from '@/lib/types';
import { SUPPORTED_DESTINATIONS } from '@/lib/destination-country';
import { draftTenant } from '@/lib/legacy-tenant';
import { FX_QUOTE_EXPIRED_MESSAGE, FX_UNAVAILABLE_MESSAGE } from '@/lib/rate';

// (Stage 2b: the mock's 120s sleep is an outbox row now — no long-running function.)

// The delayed best-effort poke below sleeps DELIVERY_DELAY_MS + 10s after the
// response is sent — declare a budget that explicitly fits it (Fluid Compute
// keeps the instance alive for after() work up to maxDuration).
export const maxDuration = 300;

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
async function captureFunding(transfer: Transfer): Promise<void> {
  const { fundingRef } = await getFundingProvider().capture(transfer);
  await createTransferRepo(getDb()).setFundingRef(transfer.id, fundingRef);
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
function refuseUnlessAwaiting(transfer: Transfer): NextResponse | null {
  if (transfer.complianceStatus === 'blocked' || transfer.status === 'blocked') {
    return NextResponse.json({ ok: false, error: "We can't process this transfer." }, { status: 400 });
  }
  if (transfer.status !== 'awaiting_payment') {
    return NextResponse.json({ ok: true, status: transfer.status });
  }
  return null;
}

/**
 * fix 6 (ctx-01): the pay page's ONLY payout write on an existing transfer — one
 * transaction: the guarded, column-targeted UPDATE (transfer-repo
 * setPayoutIfEditable: awaiting_payment, uncharged, consumer, this tenant, not
 * partner-API-minted) + a `transfer.payout_edit` audit row carrying the id and
 * last-4 only. Returns the updated (masked) row, or null when a guard failed.
 */
async function writePayoutIfEditable(transfer: Transfer, bankDetails: BankDetails): Promise<Transfer | null> {
  const destination = bankDetails.payoutDestination ?? '';
  return getDb().transaction(async (tx) => {
    const updated = await createTransferRepo(tx).setPayoutIfEditable(transfer.id, transfer.partnerId, {
      payoutMethod: bankDetails.payoutMethod ?? 'bank',
      payoutDestination: destination,
    });
    if (updated) {
      await createAuditRepo(tx).record({
        partnerId: transfer.partnerId,
        actor: 'pay-page',
        actorType: 'system',
        action: 'transfer.payout_edit',
        subjectId: transfer.id,
        meta: { last4: accountLast4(destination) },
      });
    }
    return updated;
  });
}

/**
 * fix 6 (ctx-01): bind the payer's opaque ACH mandate to a B2B ach_pull transfer
 * through ONE guarded, column-targeted UPDATE (transfer-repo setAchTokenIfAbsent:
 * this tenant, awaiting_payment, b2b, no token yet) — never a whole-row re-save
 * of a stale read, which rewrote status and ach_token_ref from that read (a
 * concurrent POST's paid flip could be reverted and settled twice) and, when the
 * read carried no mask, wrote recipient_legal_name_enc = NULL (the default read
 * omits it). A token already bound — ours from a crash-then-retry, or a
 * concurrent POST's — is kept: the FIRST mandate wins. Returns the row to
 * settle, or the response to send (current truth).
 */
async function bindAchToken(
  store: ReturnType<typeof getStore>,
  transfer: Transfer,
  token: string,
): Promise<Transfer | NextResponse> {
  if ((transfer.achTokenRef ?? '').trim() !== '') return transfer;
  const bound = await createTransferRepo(getDb()).setAchTokenIfAbsent(transfer.id, transfer.partnerId, token);
  if (bound) return bound;
  const current = await store.getTransfer(transfer.id);
  if (!current) return NextResponse.json({ ok: false, error: 'Payment failed' }, { status: 400 });
  const refused = refuseUnlessAwaiting(current);
  if (refused) return refused;
  if ((current.achTokenRef ?? '').trim() !== '') return current;
  // Awaiting, token-less, yet the guarded write matched nothing: not a B2B row
  // (callers only reach here with transferType 'b2b'). Never write around it.
  return NextResponse.json({ ok: false, error: 'Payment failed' }, { status: 409 });
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
async function processTransferPayment(
  store: ReturnType<typeof getStore>,
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
      await captureFunding(transfer);
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

// Program-Fix 33: derived from the ONE country authority, never hand-typed.
const VALID_COUNTRY_CODES: ReadonlySet<string> = new Set<CountryCode>(SUPPORTED_DESTINATIONS);

/**
 * Validate the payer's ACH bank-debit fields (the US business bank we instruct
 * the partner to debit) and derive an OPAQUE mandate token. NON-CUSTODIAL:
 * SmartRemit never captures funds and the partner holds the real mandate, so we
 * keep ONLY this opaque `ach_<random>` token on the ledger — the raw routing /
 * account number are never persisted. (If a future flow ever needs to store the
 * raw fields, encrypt them like payout destinations via field-crypto.)
 */
function validateAndTokenizeAch(
  raw: { routingNumber?: unknown; accountNumber?: unknown; accountType?: unknown } | undefined,
): { ok: true; token: string } | { ok: false; fieldErrors: Record<string, string> } {
  const fieldErrors: Record<string, string> = {};
  const routing = String(raw?.routingNumber ?? '').replace(/\D/g, '');
  const account = String(raw?.accountNumber ?? '').replace(/\D/g, '');
  const accountType = String(raw?.accountType ?? '');
  if (routing.length !== 9) fieldErrors.routingNumber = 'Enter the 9-digit routing number.';
  if (account.length < 4) fieldErrors.accountNumber = 'Enter a valid account number.';
  if (accountType !== 'checking' && accountType !== 'savings') {
    fieldErrors.accountType = 'Select an account type.';
  }
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  // Opaque, non-reversible mandate reference — carries no bank digits.
  return { ok: true, token: `ach_${randomBytes(24).toString('hex')}` };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ transferId: string }> },
) {
  // The route param is authoritative for which draft/transfer we're paying —
  // never trust an id in the body. The body only carries the bank-detail fields
  // the sender entered on the secure pay page (Item 2).
  const { transferId } = await params;

  // Stage 3: per-IP ceiling over the whole route (request_otp + pay attempts).
  // The OTP gate + per-transaction caps are the inner rings; this stops one
  // address from hammering the money endpoint at all. Fail-open by design.
  const limited = await enforceIpRateLimit(req, 'pay', 30);
  if (limited) return limited;

  try {
    const store = getStore();

    // ── Parse + validate the bank-detail body ONCE (shared by both branches) ──
    // Body shape: { country: CountryCode, fields: Record<string,string> }. We
    // server-validate via the SAME validator the form uses (single source of
    // truth); any 400 here happens BEFORE any charge. A bodyless POST (old
    // in-flight draft, or a re-opened link that already has a destination) skips
    // validation and falls back to the stored destination.
    let body: {
      country?: unknown;
      fields?: unknown;
      action?: unknown;
      otp?: unknown;
      ach?: { routingNumber?: unknown; accountNumber?: unknown; accountType?: unknown };
    } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      body = {};
    }

    // ── Phase 3 Part B: per-transaction OTP step-up ──────────────────────────
    // Resolve the sender phone from the id (draft PEEK — never consumes — else
    // an existing transfer) so the code is bound to this exact transaction.
    const otpDraft = await getDraftStore().getDraft(transferId);
    const otpPhone = otpDraft?.senderPhone ?? (await store.getTransfer(transferId))?.phone ?? null;

    // (1) "request_otp": issue + deliver a code in-session (free-form). No charge.
    if (typeof body.action === 'string' && body.action === 'request_otp') {
      if (!otpPhone) return NextResponse.json({ ok: false, error: 'expired_or_used' }, { status: 404 });
      const issued = await getTransactionOtpStore().issue(transferId, otpPhone);
      if (issued.ok) {
        // WL2: the code arrives from the number the customer is mid-payment with.
        let otpCreds: WaCreds | undefined;
        try {
          // The draft carries its tenant (fix 1); a pre-deploy draft resolves by the oldest-row rule.
          const otpPartnerId = otpDraft
            ? await draftTenant(otpDraft, store.legacyTenantOf)
            : (await store.getTransfer(transferId))?.partnerId;
          if (otpPartnerId) {
            otpCreds = waCredsFrom(await getPartnerIntegrationsStore().getIntegrations(otpPartnerId));
          }
        } catch { /* fall back to the shared env number */ }
        try { await sendTransactionOtp(otpPhone, issued.code, otpCreds); } catch { /* generic surface; never log the code */ }
      }
      return NextResponse.json({ ok: true, sent: true });
    }

    // (2) Require a valid code before ANY money movement (covers BOTH branches).
    if (!otpPhone) return NextResponse.json({ ok: false, error: 'expired_or_used' }, { status: 404 });
    const otpCode = String(body.otp ?? '').replace(/\D/g, '');
    const otpCheck = await getTransactionOtpStore().verify(transferId, otpPhone, otpCode);
    if (!otpCheck.ok) {
      return NextResponse.json(
        { ok: false, error: 'Enter the confirmation code we sent to your WhatsApp.', reason: 'otp' },
        { status: 403 },
      );
    }

    const country =
      typeof body.country === 'string' && VALID_COUNTRY_CODES.has(body.country.toUpperCase())
        ? (body.country.toUpperCase() as CountryCode)
        : undefined;
    const rawFields =
      body.fields && typeof body.fields === 'object' ? (body.fields as Record<string, unknown>) : undefined;
    const hasSubmittedFields =
      country !== undefined &&
      rawFields !== undefined &&
      BANK_FIELDS_BY_COUNTRY[country].some((f) => {
        const v = rawFields[f.key];
        return typeof v === 'string' && v.trim() !== '';
      });

    let bankDetails: BankDetails | undefined;
    if (hasSubmittedFields) {
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawFields!)) {
        if (typeof v === 'string') fields[k] = v;
      }
      // fix 6: the per-country form is bound to THIS payment's destination
      // country (the transfer's, else the draft's) — a caller never picks
      // another country's field set for it.
      const target = (await store.getTransfer(transferId)) ?? otpDraft;
      if (country !== (target?.destinationCountry ?? DEFAULT_DESTINATION_COUNTRY)) {
        return NextResponse.json(
          { ok: false, error: 'Please check the bank details.', fieldErrors: { country: 'These bank details are for a different country.' } },
          { status: 400 },
        );
      }
      const validation = validatePayoutFields(country!, fields);
      if (!validation.ok) {
        // 400 BEFORE any charge — nothing is mutated, the sender can retry.
        return NextResponse.json(
          { ok: false, error: 'Please check the bank details.', fieldErrors: validation.errors },
          { status: 400 },
        );
      }
      // fix 10 (review S1), defense in depth: validatePayoutFields already refuses a
      // mask in any field and composes digit fields from their digits, so a
      // composed display mask means the validator regressed — refuse it here too,
      // BEFORE any write or charge (the rail would only dead-letter it later).
      if (isMaskedDestination(validation.payoutDestination)) {
        return NextResponse.json(
          { ok: false, error: 'Please check the bank details.', fieldErrors: { payoutDestination: 'Enter the full account details, not a masked value.' } },
          { status: 400 },
        );
      }
      bankDetails = { payoutMethod: 'bank', payoutDestination: validation.payoutDestination };
    }

    const transfer = await store.getTransfer(transferId);

    if (transfer) {
      // F53: refuse BEFORE the KYC gate and before any saveTransfer below can
      // write bank details / an ACH mandate token onto a row that already
      // moved or was cancelled. Same gate runs again inside
      // processTransferPayment (chokepoint for the draft branch too).
      const refused = refuseUnlessAwaiting(transfer);
      if (refused) return refused;
      // fix 6: a CONSUMER row carrying a partner-pulled funding method (only a
      // pre-fix model argument could mint one) is neither captured by us nor
      // legitimately pulled by the partner. Fail closed: never charge, never instruct.
      if (isPartnerPulled(transfer.fundingMethod) && transfer.transferType !== 'b2b') {
        logError('pay.consumer-partner-pulled', new Error('consumer transfer with a partner-pulled funding method'), { transferId: transfer.id });
        return NextResponse.json({ ok: false, error: "We can't process this transfer." }, { status: 400 });
      }
      // ── Existing transfer branch ──────────────────────────────────────
      // Phase 3 verify-before-send gate — covers scheduled/cron transfers paid
      // on this page. Refuse BEFORE any charge if the owner isn't verified.
      const owner = await getCustomerStore(store).getCustomer(transfer.partnerId, transfer.phone);
      // WL1: skipped for a 'delegated' partner (they run KYC on their side).
      const owningPartner =
        (await getPartnerStore().getPartner(transfer.partnerId)) ??
        (await getPartnerStore().ensureDefaultPartner());

      // ── B2B ACH-pull (NON-CUSTODIAL) ─────────────────────────────────────
      // The licensed partner ACH-debits the payer's business bank via the signed
      // settlement instruction; SmartRemit captures NO funds. The B2B KYB gate
      // (isB2bSendVerified) replaces the b2c send gate; the payer's ACH bank
      // fields are validated + tokenized into an opaque achTokenRef (raw routing/
      // account never stored), then settlement proceeds WITHOUT a funds capture.
      if (transfer.transferType === 'b2b' && transfer.fundingMethod === 'ach_pull') {
        if (sendGateActive(owningPartner) && !isB2bSendVerified(owner)) {
          return NextResponse.json(
            { ok: false, error: 'Please verify your business before sending.', kyc_required: true },
            { status: 403 },
          );
        }
        const ach = validateAndTokenizeAch(body.ach);
        if (!ach.ok) {
          // 400 BEFORE settlement — nothing mutated, the payer can retry.
          return NextResponse.json(
            { ok: false, error: 'Please check your bank details.', fieldErrors: ach.fieldErrors },
            { status: 400 },
          );
        }
        // Bind the opaque mandate token. Idempotent: a replay POST whose transfer
        // already carries an achTokenRef keeps the FIRST token (we only mint when
        // absent), so a crash-then-retry re-settles with the same mandate. The
        // transfer stays awaiting_payment until settleOrHold commits, so a
        // crash in that narrow window is self-healed by the payer re-submitting
        // (achTokenRef already bound ⇒ settleOrHold resumes cleanly).
        const withToken = await bindAchToken(store, transfer, ach.token);
        if (withToken instanceof NextResponse) return withToken;
        // Capture is skipped structurally inside processTransferPayment (keyed on
        // transferType 'b2b' + a partner-pulled fundingMethod — fix 6); no caller flag needed.
        return await processTransferPayment(store, withToken);
      }

      if (sendGateActive(owningPartner) && !isSendVerified(owner)) {
        return NextResponse.json(
          { ok: false, error: 'Please verify your identity before sending.', kyc_required: true },
          { status: 403 },
        );
      }
      // fix 6 (ctx-01): `transfer` is the DEFAULT (masked) read — it renders every
      // stored value, real or poisoned, as "****<last4>". Decide on the explicit
      // decrypted read; the value only feeds this boolean.
      const storedDestination =
        ((await store.getTransferDecrypted(transferId))?.payoutDestination ?? '').trim();
      const hasDestination = storedDestination !== '' && !isMaskedDestination(storedDestination);
      // Sender-entered, server-validated, country-bound bank details (the page's
      // Step 1, or its "Edit bank details") fill or replace the payout of a
      // CONSUMER transfer through ONE guarded write. A B2B payee is never payer
      // input: its body is ignored.
      if (bankDetails && transfer.transferType !== 'b2b') {
        const edited = await writePayoutIfEditable(transfer, bankDetails);
        if (!edited) {
          // A guard failed after our read (a concurrent POST charged / settled /
          // held it — the OTP verify is not atomic), or the row is not editable
          // here (charged, partner-API-minted). Never write around the guard:
          // report current truth.
          const current = await store.getTransfer(transferId);
          const nowRefused = current ? refuseUnlessAwaiting(current) : null;
          if (nowRefused) return nowRefused;
          return NextResponse.json(
            { ok: false, error: "This transfer's bank details can't be changed here.", reason: 'payout_locked' },
            { status: 409 },
          );
        }
        return await processTransferPayment(store, edited);
      }
      if (!hasDestination) {
        // A SCHEDULED/cron transfer can be created with an empty destination (Item 2:
        // never collected in chat). It MUST be collected + validated here before
        // charging — a no-account transfer must never be delivered.
        return NextResponse.json(
          { ok: false, error: 'Bank details are required to complete this transfer.' },
          { status: 400 },
        );
      }
      // Destination already set (re-opened link) → process exactly as before.
      return await processTransferPayment(store, transfer);
    }

    // ── Draft branch: treat id as a draftId and finalize at pay time ──────
    const stores = {
      store,
      customerStore: getCustomerStore(store),
      draftStore: getDraftStore(),
      partnerStore: getPartnerStore(),
      monthlyVolumeStore: getMonthlyVolumeStore(),
      dailyVolumeStore: getDailyVolumeStore(),
      db: getDb(),
    };
    const result = await finalizeDraftPayment(stores, transferId, bankDetails);
    if (!result.ok) {
      if (result.error === 'kyc_required') {
        return NextResponse.json(
          { ok: false, error: 'Please verify your identity before sending.', kyc_required: true },
          { status: 403 },
        );
      }
      if (result.error === 'fx_unavailable') {
        // Task 9: the FX provider is down (retryable) or the stored quote's rate
        // aged past the ceiling (quoteExpired — only a FRESH quote helps, so say
        // that instead of "try again"). Nothing was minted or charged; the draft
        // (and its link) is untouched.
        return NextResponse.json(
          {
            ok: false,
            error: result.quoteExpired ? FX_QUOTE_EXPIRED_MESSAGE : FX_UNAVAILABLE_MESSAGE,
            reason: 'fx_unavailable',
          },
          { status: 503 },
        );
      }
      if (result.error === 'bank_details_required') {
        // fix 6 (ctx-01): the draft holds no usable destination. 400 — never 500 —
        // nothing was claimed or consumed; the SAME link re-submits.
        return NextResponse.json(
          { ok: false, error: 'Bank details are required to complete this transfer.', reason: 'bank_details_required' },
          { status: 400 },
        );
      }
      if (result.error === 'busy') {
        // Program fix 16: the per-sender mint lock timed out (another send for
        // this customer is in flight). Nothing was minted or consumed; the SAME
        // link re-submits and replays the bound id.
        return NextResponse.json(
          { ok: false, error: 'Please try again.', reason: 'busy' },
          { status: 503 },
        );
      }
      const msg =
        result.error === 'cap'
          ? 'That amount exceeds your current limit.'
          : result.error === 'blocked'
            ? "We can't process this transfer."
            : 'This payment link is no longer active.';
      return NextResponse.json({ ok: false, error: msg }, { status: 400 });
    }

    // Finalized → now a real transfer; run the same payment path as the transfer branch.
    const created = await store.getTransfer(result.transferId);
    if (!created) {
      return NextResponse.json({ ok: false, error: 'Payment failed' }, { status: 400 });
    }
    // NON-CUSTODIAL B2B ACH-pull finalized from a draft: the ACH bank fields must
    // be validated + tokenized into achTokenRef BEFORE settlement (the partner's
    // instruction carries the mandate token). Capture is already skipped
    // structurally inside processTransferPayment for ach_pull.
    if (created.transferType === 'b2b' && created.fundingMethod === 'ach_pull') {
      const ach = validateAndTokenizeAch(body.ach);
      if (!ach.ok) {
        return NextResponse.json(
          { ok: false, error: 'Please check your bank details.', fieldErrors: ach.fieldErrors },
          { status: 400 },
        );
      }
      const withToken = await bindAchToken(store, created, ach.token);
      if (withToken instanceof NextResponse) return withToken;
      return await processTransferPayment(store, withToken);
    }
    return await processTransferPayment(store, created);
  } catch (err) {
    logError('pay.route', err, { transferId });
    return NextResponse.json({ ok: false, error: 'Payment failed' }, { status: 400 });
  }
}
