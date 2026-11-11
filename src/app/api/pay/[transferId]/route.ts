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
import { getDb } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { getPortalSettings, portalAuthTemplate } from '@/db/repos/portal-settings-repo';
import { DEFAULT_DESTINATION_COUNTRY } from '@/lib/defaults';
import { enforceIpRateLimit } from '@/lib/ip-rate-limit';
import { logError, logWarn } from '@/lib/log';
import { isInfraError } from '@/lib/infra-error';
import { isOtpConsumeFailure } from '@/lib/otp-consume-failure';
import { retryOnceOnInfra } from '@/lib/infra-retry';
import { isDisclosureAckVersion } from '@/lib/remittance-disclosure';
import { resolvePartnerBranding } from '@/lib/partner-config';
import { env } from '@/lib/env';
import { resolveDirectOtpChannel } from '@/lib/direct-otp-channel';
import { recordChannelHealth } from '@/lib/channel-health';
import { isInServiceWindow } from '@/lib/whatsapp-errors';
import { getTransactionOtpStore } from '@/lib/transaction-otp';
import { sendTransactionOtp } from '@/lib/whatsapp';
import { validatePayoutFields, BANK_FIELDS_BY_COUNTRY, isMaskedDestination, isStoredAccount, accountLast4 } from '@/lib/payout-format';
import { isPartnerPulled } from '@/lib/funding-method';
import type { CountryCode, PartnerId, PayoutMethod, Transfer } from '@/lib/types';
import { SUPPORTED_DESTINATIONS } from '@/lib/destination-country';
import { draftTenant } from '@/lib/legacy-tenant';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import { FX_QUOTE_EXPIRED_MESSAGE, FX_UNAVAILABLE_MESSAGE, RateUnavailableError } from '@/lib/rate';
import { hasSenderName, SENDER_NAME_REQUIRED_MESSAGE } from '@/lib/sender-identity';
import { rescreenBeforePay } from '@/lib/pay-rescreen';
import { railPartnerOf, realMoneyFor } from '@/lib/live-gate';
import { resolveCorridorRules } from '@/lib/compliance-config';
import { SENDS_PAUSED_MESSAGE } from '@/lib/flags';
import { payAccountHolderInvalid, payApprovalNotRecorded, payNotAvailable, payOriginatorInvalid, payReloadRequired, transferFunded } from '@/lib/pay-not-available';
import { originatorViewFor, writeOriginatorInfo } from '@/lib/originator-info';
import { validateSenderAddress, validateSenderDob } from '@/lib/travel-rule';
import { parsePayBody, validateAccountHolder } from '@/lib/pay-body';
import { fillRecipientBookLegalName, payLegalNameOnFile, writeRecipientLegalName } from '@/lib/recipient-legal-name';
import { readPayGateContext, SAFE_PAY_GATE_CONTEXT, type PayGateContext } from '@/lib/pay-gate-context';
import { disclosureGateAtRequest, disclosureGateRefusal } from '@/lib/pay-disclosure-gate';
import { payMoneyGateRefusal } from '@/lib/pay-money-gate';
import { buildPaymentAuthEvidence } from '@/lib/payment-auth-evidence';
import { providerLineFor } from '@/lib/legal/provider-line';
import { alertPayEvidenceUnavailable, type PaymentEvidence } from '@/lib/payment-evidence';
import { REWARD_ENDED_MESSAGE } from '@/lib/rewards/copy';
import { checkMintedRate, type MintedRateRefusal } from '@/lib/minted-rate';
import { QuoteError } from '@/lib/fx';
import { transferMintedFromDraft } from '@/lib/pay-link';
import { pokeWorker } from '@/lib/outbox';
import { processTransferPayment, refuseUnlessAwaiting } from '@/lib/pay-process';
import { BANK_DETAILS_LOCKED_ERROR, bankDetailsLocked, payOtpBudgetKind } from '@/lib/pay-prepared-by';

// (Stage 2b: the mock's 120s sleep is an outbox row now — no long-running function.)

// The delayed best-effort poke (processTransferPayment, src/lib/pay-process.ts) sleeps DELIVERY_DELAY_MS + 10s after the
// response is sent — declare a budget that explicitly fits it (Fluid Compute
// keeps the instance alive for after() work up to maxDuration).
export const maxDuration = 300;

/**
 * fix 6 (ctx-01): the pay page's ONLY payout write on an existing transfer — one
 * transaction: the guarded, column-targeted UPDATE (transfer-repo
 * setPayoutIfEditable: awaiting_payment, uncharged, consumer, this tenant, not
 * partner-API-minted) + a `transfer.payout_edit` audit row carrying the id and
 * last-4 only. Returns the updated (masked) row, or null when a guard failed
 * (nothing written).
 *
 * Review R3-X1 N1/N2 (decision D3): the account-holder name typed for these bank
 * details is written in the SAME guarded UPDATE, after the re-screen, with its
 * `transfer.legal_name_set` row (meta `replaced: true` only when a name was on
 * the row). With no typed name, the old name is cleared when the row stored a
 * real account (isStoredAccount: a masked value is no account; a first
 * collection keeps the name). Both decisions are made under the row lock
 * (lockEditablePayout), never from the route's earlier read.
 */
async function writePayoutIfEditable(
  transfer: Transfer,
  bankDetails: BankDetails,
  legalName: string | null,
): Promise<Transfer | null> {
  const destination = bankDetails.payoutDestination ?? '';
  return getDb().transaction(async (tx) => {
    const repo = createTransferRepo(tx);
    const locked = await repo.lockEditablePayout(transfer.id, transfer.partnerId);
    if (!locked) return null;
    const updated = await repo.setPayoutIfEditable(
      transfer.id,
      transfer.partnerId,
      { payoutMethod: bankDetails.payoutMethod ?? 'bank', payoutDestination: destination },
      legalName ? { legalName } : { clearLegalName: isStoredAccount(locked.storedDestination) },
    );
    if (updated) {
      const audit = createAuditRepo(tx);
      await audit.record({
        partnerId: transfer.partnerId,
        actor: 'pay-page',
        actorType: 'system',
        action: 'transfer.payout_edit',
        subjectId: transfer.id,
        meta: { last4: accountLast4(destination) },
      });
      if (legalName) {
        await audit.record({
          partnerId: transfer.partnerId,
          actor: 'pay-page',
          actorType: 'system',
          action: 'transfer.legal_name_set',
          subjectId: transfer.id,
          meta: locked.hasLegalName ? { source: 'pay_page', replaced: true } : { source: 'pay_page' },
        });
      }
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
  raw: unknown,
): { ok: true; token: string } | { ok: false; fieldErrors: Record<string, string> } {
  const fieldErrors: Record<string, string> = {};
  const o: { routingNumber?: unknown; accountNumber?: unknown; accountType?: unknown } | undefined =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
  const routing = String(o?.routingNumber ?? '').replace(/\D/g, '');
  const account = String(o?.accountNumber ?? '').replace(/\D/g, '');
  const accountType = String(o?.accountType ?? '');
  if (routing.length !== 9) fieldErrors.routingNumber = 'Enter the 9-digit routing number.';
  if (account.length < 4) fieldErrors.accountNumber = 'Enter a valid account number.';
  if (accountType !== 'checking' && accountType !== 'savings') {
    fieldErrors.accountType = 'Select an account type.';
  }
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  // Opaque, non-reversible mandate reference — carries no bank digits.
  return { ok: true, token: `ach_${randomBytes(24).toString('hex')}` };
}

/**
 * Step 0 FX-2 (P1): the pay-time rate check for an EXISTING transfer, behind
 * FX_PAY_RATE_CHECK_ENABLED (default OFF). Runs on EVERY POST to the row —
 * before a code is issued (request_otp), before the OTP is verified (the
 * customer keeps their code budget) and before the evidence commit — so
 * a stale rate never costs a code or a charge. Null ⇒ proceed exactly as today.
 *
 * Only rows we would CHARGE at the minted rate reach checkMintedRate: a live
 * consumer awaiting_payment row that is not captured (a captured row only
 * resumes settlement — fundTransfer) and not partner-API-minted (the partner
 * confirms those; Step 0 Q3). Anything else answers as today (the status gate
 * further down reports current truth).
 *
 *   FX unavailable / frozen feed → 503 fx_unavailable, nothing written (a
 *                                   QuoteError from the cross-rate, e.g. a
 *                                   malformed destination leg, answers the same
 *                                   — never a 400, never a cancel);
 *   refused, no funding intent   → ONE transaction: the guarded cancel
 *                                   (cancelIfCancellable: awaiting, no funding
 *                                   ref or intent, this tenant; no outbox row) +
 *                                   a transfer.rate_expired audit row → 409
 *                                   rate_expired + status cancelled;
 *   refused, intent bound        → 409 rate_expired_payment_pending, NEVER
 *                                   cancelled (a bank debit may be in flight:
 *                                   its webhook can still settle it at the
 *                                   minted rate; otherwise the fundstale alert
 *                                   catches it after 7 days — Step 0 Q14).
 */
async function payTimeRateRefusal(
  store: ReturnType<typeof getStore>,
  transfer: Transfer,
): Promise<NextResponse | null> {
  if (transfer.status !== 'awaiting_payment' || transfer.transferType === 'b2b') return null;
  if (transfer.fundingRef || transfer.fundingState === 'succeeded') return null;
  if (await createTransferRepo(getDb()).isPartnerApiMinted(transfer.id)) return null;
  let verdict: Awaited<ReturnType<typeof checkMintedRate>>;
  try {
    verdict = await checkMintedRate(transfer);
  } catch (err) {
    if (!(err instanceof RateUnavailableError) && !(err instanceof QuoteError)) throw err;
    const why = err instanceof RateUnavailableError ? err.reason : 'quote_error';
    logWarn('pay.rate-check-unavailable', `pay-time rate check could not run: ${why}`, { transferId: transfer.id });
    return fxUnavailable();
  }
  if (verdict.ok) return null;
  return refuseStaleRate(store, transfer, verdict);
}

function fxUnavailable(): NextResponse {
  return NextResponse.json({ ok: false, reason: 'fx_unavailable', error: FX_UNAVAILABLE_MESSAGE }, { status: 503 });
}

const ratePaymentPending = () =>
  NextResponse.json({ ok: false, reason: 'rate_expired_payment_pending' }, { status: 409 });

async function refuseStaleRate(
  store: ReturnType<typeof getStore>,
  transfer: Transfer,
  verdict: MintedRateRefusal,
): Promise<NextResponse | null> {
  if (transfer.fundingIntentRef) return ratePaymentPending();
  const meta = verdict.reason === 'drift' ? { reason: verdict.reason, driftBps: verdict.driftBps } : { reason: verdict.reason };
  const cancelled = await getDb().transaction(async (tx) => {
    const row = await createTransferRepo(tx).cancelIfCancellable(transfer.id, transfer.partnerId);
    if (row) {
      await createAuditRepo(tx).record({
        partnerId: transfer.partnerId,
        actor: 'pay-page',
        actorType: 'system',
        action: 'transfer.rate_expired',
        subjectId: transfer.id,
        meta,
      });
    }
    return row;
  });
  if (cancelled) {
    logWarn('pay.rate-expired', 'stale rate on an existing transfer: cancelled', { transferId: transfer.id, ...meta });
    return NextResponse.json({ ok: false, reason: 'rate_expired', status: 'cancelled' }, { status: 409 });
  }
  // Lost a race (verify3 L3): decide again on the row as it is NOW.
  const current = await store.getTransfer(transfer.id);
  if (!current) return NextResponse.json({ ok: false, error: 'expired_or_used' }, { status: 404 });
  const truth = refuseUnlessAwaiting(current);
  if (truth) return truth;
  if (current.fundingRef || current.fundingState === 'succeeded') return null; // captured meanwhile: resumes
  if (current.fundingIntentRef) return ratePaymentPending();
  return NextResponse.json({ ok: false, reason: 'rate_expired' }, { status: 409 });
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

    // ── Parse the body ONCE, through the one pay-body parser (fix pack 4, C13) ──
    // Bank details: { country: CountryCode, fields: Record<string,string> }. We
    // server-validate via the SAME validator the form uses (single source of
    // truth); any 400 here happens BEFORE any charge. A bodyless POST (old
    // in-flight draft, or a re-opened link that already has a destination) skips
    // validation and falls back to the stored destination. A JSON error reads as {}.
    // disclosureVersion / disclosureHash: OPTIONAL for one release (old pages never send them).
    let raw: unknown = {};
    try {
      raw = await req.json();
    } catch {
      raw = {};
    }
    const body = parsePayBody(raw, 'transfer');

    // ── Phase 3 Part B: per-transaction OTP step-up ──────────────────────────
    // Resolve the sender phone from the id (draft PEEK — never consumes — else
    // an existing transfer) so the code is bound to this exact transaction.
    // Fix D: the PEEK is idempotent, so a Redis blip gets one retry.
    const otpDraft = await retryOnceOnInfra(() => getDraftStore().getDraft(transferId));
    let otpTransfer = otpDraft ? null : await store.getTransfer(transferId);
    // Step 0 Q16 (build-changes B.2): a draft link whose draft was minted and
    // consumed (e.g. the capture failed after the mint) continues on the
    // transfer it BECAME, never "expired_or_used". From here on `payId` names
    // that transfer for every step (the code, its check, every read), so the
    // link answers exactly as the transfer's own link would — every guard below
    // still runs on it.
    if (!otpDraft && !otpTransfer) otpTransfer = await transferMintedFromDraft(getDb(), store, transferId);
    const payId = otpTransfer?.id ?? transferId;
    // Program-Fix 44 P2: a SANDBOX (test-key) transfer is never payable here —
    // no OTP to the partner-supplied phone, no capture. Same answer as a dead link.
    if (otpTransfer && otpTransfer.environment === 'test') {
      return NextResponse.json({ ok: false, error: 'expired_or_used' }, { status: 404 });
    }
    // Batch B2: a payment-link transfer is paid ONLY through /api/pay/l/[token],
    // which re-runs the link checks (switch, payee approved, link open/unexpired).
    // Here it gets the same answer as a dead link, before any code or charge.
    if (otpTransfer && (await createTransferRepo(getDb()).isPaymentLinkTransfer(otpTransfer.id))) {
      return NextResponse.json({ ok: false, error: 'expired_or_used' }, { status: 404 });
    }
    // Step 0 FX-2 (P1): the minted rate is re-checked BEFORE any code is issued
    // or verified (payTimeRateRefusal). Flag OFF ⇒ nothing runs.
    if (otpTransfer && env.fxPayRateCheckEnabled) {
      const rateRefusal = await payTimeRateRefusal(store, otpTransfer);
      if (rateRefusal) return rateRefusal;
    }
    const otpPhone = otpDraft?.senderPhone ?? otpTransfer?.phone ?? null;

    // Fix pack 4 (C12): the pre-verify R18 gate context for the payment's OWNER
    // (the draft's tenant, else the transfer's). The rail is the routed partner,
    // else the owner; a draft has no environment yet (it mints live).
    const railPartnerFor = (ownerId: PartnerId): PartnerId =>
      otpDraft ? (otpDraft.settlementPartnerId ?? ownerId) : railPartnerOf(otpTransfer!);
    const gateContextFor = (ownerId: PartnerId): Promise<PayGateContext> =>
      readPayGateContext(getDb(), {
        ownerId,
        railPartnerId: railPartnerFor(ownerId),
        environment: otpDraft ? undefined : otpTransfer!.environment,
        transferType: (otpDraft ? otpDraft.transferType : otpTransfer!.transferType) ?? 'b2c',
      });
    // Fix pack 5 T13b (P13 route pre-verify, M5): pay-process steps 5 (no
    // unsigned rail) and 7 (no mock funding on real money) answered BEFORE a
    // code is issued or checked, so their 409 never spends the code and nothing
    // (evidence, legal name, originator data, a mint) is written first. Only a
    // known real-money rail makes a read; pay-process stays the backstop. A
    // draft is judged on its own fields (no row, no funding provider yet).
    const moneyGateRefused = async (ctx: PayGateContext, ownerId: PartnerId): Promise<boolean> => {
      const subject = otpDraft
        ? {
            transferType: otpDraft.transferType ?? 'b2c',
            fundingMethod: otpDraft.fundingMethod,
            partnerId: ownerId,
            settlementPartnerId: otpDraft.settlementPartnerId,
            environment: undefined,
            fundingProvider: undefined,
            fundingIntentRef: undefined,
          }
        : otpTransfer!;
      const code = await payMoneyGateRefusal(getDb(), { ctx, railPartnerId: railPartnerFor(ownerId), subject });
      if (!code) return false;
      logWarn('pay.preverify-refused', 'money gate', otpDraft ? { draftId: transferId, code } : { transferId: payId, code });
      return true;
    };

    // (1) "request_otp": issue + deliver a code (free-form, or an auth template). No charge.
    if (body.action === 'request_otp') {
      if (!otpPhone) return NextResponse.json({ ok: false, error: 'expired_or_used' }, { status: 404 });
      // The owning partner scopes the per-phone code budget (Program-Fix 45) and
      // picks the sending number (WL2). The draft carries its tenant (fix 1); a
      // pre-deploy draft resolves by the oldest-row rule.
      // M2-14 (PR 393 ENABLEMENT BLOCKER): the tenant and its channel are resolved
      // BEFORE a code is minted, and FAIL CLOSED: a tenant that can't be resolved,
      // a non-default partner whose creds read throws, or a half-configured
      // channel never falls back to the shared number (the customer is paying the
      // partner's brand). Nothing is minted, so no issue budget is burned.
      const otpSendFailed = () => NextResponse.json({ ok: false, reason: 'otp_send_failed' }, { status: 502 });
      let otpPartnerId: string;
      try {
        otpPartnerId =
          (otpDraft ? await draftTenant(otpDraft, store.legacyTenantOf) : otpTransfer?.partnerId) ?? DEFAULT_PARTNER_ID;
      } catch {
        logWarn('pay.otp-channel', 'tenant unresolved; confirmation code not sent (fail closed)', {});
        return otpSendFailed();
      }
      // WL2: the code arrives from the number the customer is mid-payment with. Pack 3
      // (contract 17): the ONE channel rule (direct-otp-channel.ts) — own number → its creds;
      // shared → the env number, except a partner certified for live money (refused); a
      // half-configured channel (incomplete_config recorded + poke) or a non-default partner's
      // failed read → refused; the default tenant keeps the shared number on a read failure.
      const channel = await resolveDirectOtpChannel(otpPartnerId, 'pay.otp-channel');
      if (!channel.ok) return otpSendFailed();
      const otpCreds = channel.creds;
      // Fix pack 4 (C10 c, C12): a mandatory payment (certified owner, or a
      // real-money rail) whose provider block is not approved gets no code at
      // all: nothing is issued or sent. The tenant above is reused (no second
      // resolve), so its fail-closed 502 is unchanged.
      const requestCtx = await gateContextFor(otpPartnerId);
      if (disclosureGateAtRequest({ mandatory: requestCtx.mandatory, disclosure: requestCtx.disclosure })) {
        return payNotAvailable();
      }
      if (await moneyGateRefused(requestCtx, otpPartnerId)) return payNotAvailable();
      // Program-Fix 49A: the partner's name on the free-form text, on the partner's
      // OWN number only (the shared number keeps its wording). Best-effort: a read
      // error keeps the neutral default wording.
      let otpBrand: string | undefined;
      if (otpCreds) {
        try {
          otpBrand = resolvePartnerBranding(await getPartnerStore().getPartner(otpPartnerId)).brand;
        } catch { /* the default brand */ }
      }
      // M2-6: on the partner's OWN number, the partner's approved AUTHENTICATION
      // template (read by THIS transfer's partner only) carries the code, so a
      // customer outside the 24-h window still receives it. M2-14: without a template
      // (none recorded, or the read failed) the free-form text on the SAME partner
      // number is sent only inside the window (outside it Meta accepts, then drops,
      // the text): otherwise 502, nothing minted.
      let otpTemplate: { name: string; lang: string } | undefined;
      if (otpCreds) {
        try {
          otpTemplate = portalAuthTemplate(await getPortalSettings(getDb(), otpPartnerId));
        } catch (err) {
          logWarn(
            'pay.otp-template-lookup',
            `partner auth template lookup failed; free-form on the partner number inside the window only: ${err instanceof Error ? err.name : 'unknown error'}`,
            { partnerId: otpPartnerId },
          );
        }
        // M2-14: no template (none recorded, or the read failed) means a free-form text on the
        // partner's number, which only arrives inside the 24-h window: outside it, 502, nothing minted.
        if (!otpTemplate && !(await isInServiceWindow(store, otpPartnerId, otpPhone))) return otpSendFailed();
      }
      const otpStore = getTransactionOtpStore();
      const issued = await otpStore.issue(payId, otpPhone, { kind: payOtpBudgetKind(otpDraft), partnerId: otpPartnerId });
      // Program-Fix 25 PR B: locked (an issue cap) is the ONE refusal that answers
      // 429; a cooldown stays 200 sent:true because an earlier code WAS sent.
      if (!issued.ok && issued.reason === 'locked') {
        return NextResponse.json({ ok: false, reason: 'locked' }, { status: 429 });
      }
      if (issued.ok) {
        const tenant = otpPartnerId;
        // Fix pack 4 (C22 c, R16): the OWNER's approved provider line, from the
        // gate context above (no extra partner read). Added only when there is
        // one, so without it the hooks and the code text are unchanged.
        const providerLine = providerLineFor(requestCtx.disclosure) ?? undefined;
        let sentOn: 'wa' | 'tg' | undefined;
        try {
          sentOn = await sendTransactionOtp(otpPhone, issued.code, otpCreds, otpBrand, otpTemplate, {
            // Fix pack 4 (C5): a payment code (a Telegram chat gets the transaction text).
            purpose: 'payment',
            ...(providerLine ? { providerLine } : {}),
            // PR 393: outside the window a free-form fallback is accepted, then dropped.
            inWindow: () => isInServiceWindow(store, tenant, otpPhone),
            // PR 393: the partner sees (and is emailed about) a REJECTED template: a Graph 4xx
            // only. A 5xx, a timeout or a non-Graph error is transient, not the partner's to fix.
            onTemplateFailure: async ({ status, code }) => {
              if (status === undefined || status < 400 || status >= 500) return;
              if (await recordChannelHealth(tenant, 'auth_template_failed', code !== undefined ? { code } : {})) pokeWorker();
            },
          });
        } catch {
          // Program-Fix 25 PR B: honest — the code never arrived. Shorten the
          // cooldown to a ~10-s floor so Resend works soon but cannot be hammered. Never log the code.
          try { await otpStore.shortenCooldown(payId); } catch { /* the 30-s cooldown simply runs out */ }
          return otpSendFailed();
        }
        // Fix pack 4 (C5): which channel carried THIS code (for the otp.verified
        // row). Best-effort: a missing channel (a test mock) writes nothing, and a
        // failure here never blocks the code that was sent.
        try {
          await otpStore.noteDelivery(payId, issued.issuedAt, sentOn ?? null);
        } catch { /* never blocks the code */ }
      }
      return NextResponse.json({ ok: true, sent: true });
    }

    // (2) Require a valid code before ANY money movement (covers BOTH branches).
    if (!otpPhone) return NextResponse.json({ ok: false, error: 'expired_or_used' }, { status: 404 });

    // Fix pack 4 (C10 b, C12 step 3): the R18 refusals come BEFORE the code is
    // checked, so an old tab or an unapproved block never spends the code. The
    // owner is resolved in its OWN try (critic M8): a draft whose tenant cannot
    // be resolved gets the SAFE context (not mandatory) and goes on exactly as
    // today; pay-process's R18 gate on the minted row is the authoritative one.
    let payOwnerId: PartnerId | undefined;
    try {
      payOwnerId = otpDraft ? await draftTenant(otpDraft, store.legacyTenantOf) : otpTransfer!.partnerId;
    } catch (err) {
      logWarn('pay.gate-tenant', err instanceof Error ? err.name : 'error', { transferId });
    }
    const payCtx = payOwnerId ? await gateContextFor(payOwnerId) : SAFE_PAY_GATE_CONTEXT;
    const gateRefusal = disclosureGateRefusal({
      mandatory: payCtx.mandatory,
      disclosure: payCtx.disclosure,
      ackVersion: body.disclosureVersion,
      postedHash: body.disclosureHash,
    });
    // Review R1-P1 A1: an existing row already funded never hears "nothing was charged".
    const payFunded = otpTransfer ? transferFunded(otpTransfer) : false;
    if (gateRefusal === 'reload_required') return payReloadRequired(payFunded);
    if (gateRefusal === 'not_available') return payNotAvailable();
    // Fix pack 5 T13b (P13): the money gate, after R18 and before the
    // account-holder rule (and T21a's originator rule) and the code check. An
    // unresolved owner has the SAFE context: no read, pay-process decides.
    if (payOwnerId && (await moneyGateRefused(payCtx, payOwnerId))) return payNotAvailable();

    // Does this request post bank details (the page's Step 1 or "Edit bank details")?
    // Pure body parsing; the fields are validated further down, before any write.
    const country =
      typeof body.country === 'string' && VALID_COUNTRY_CODES.has(body.country.toUpperCase())
        ? (body.country.toUpperCase() as CountryCode)
        : undefined;
    const rawFields = body.fields ?? undefined;
    const hasSubmittedFields =
      country !== undefined &&
      rawFields !== undefined &&
      BANK_FIELDS_BY_COUNTRY[country].some((f) => {
        const v = rawFields[f.key];
        return typeof v === 'string' && v.trim() !== '';
      });

    // Fix pack 4 (C18 step 1, R03): the recipient's account-holder name, b2c only,
    // still BEFORE the code is checked (none of these answers consumes it). The
    // default tenant and the simulator make no read at all for an old tab (no key):
    // `realMoneyForField` is never true for the default owner (critic M3). An
    // unresolved owner (SAFE context) skips the rule: the identity hold at settle
    // is the backstop. Without posted bank details, a name already on file (or an
    // exempt row: Partner-API, payment link, b2b) skips it too, so a typed name is
    // then ignored (fill-only). Review R1-P2 D1: WITH posted bank details the name
    // posted next to them is the name for that account, so a name on the row or the
    // draft does not count (an exempt row still does: never asked).
    let typedLegalName: string | null = null;
    if ((otpTransfer?.transferType ?? otpDraft?.transferType ?? 'b2c') !== 'b2b') {
      const skip = !payCtx.realMoneyForField && !body.present.accountHolder;
      const onFile =
        skip || !payOwnerId
          ? true
          : await payLegalNameOnFile(
              getDb(),
              otpTransfer
                ? { transfer: otpTransfer, newBankFields: hasSubmittedFields }
                : { draft: otpDraft!, ownerId: payOwnerId, newBankFields: hasSubmittedFields },
            );
      if (!onFile) {
        if (payCtx.realMoneyForField && !body.present.accountHolder) return payReloadRequired(payFunded);
        if (body.present.accountHolder && body.accountHolder === null) return payAccountHolderInvalid(); // non-string
        const typed = body.accountHolder ?? '';
        if (typed !== '') {
          const valid = validateAccountHolder(typed);
          if (!valid.ok) return payAccountHolderInvalid();
          typedLegalName = valid.name;
        } else if (body.present.accountHolder && payCtx.realMoneyForField) {
          return payAccountHolderInvalid();
        }
      }
    }

    // Fix pack 5 T21a (P21, R38): the sender's home address and date of birth,
    // b2c on real money only, after the account-holder rule and still BEFORE the
    // code is checked. No read at all unless realMoneyForField (never true for
    // the default owner) and the owner is resolved. A routed or exempt row, or a
    // field already on file, is not asked: a typed value is then ignored (never
    // validated or written). A field asked with its key absent (an old tab) ->
    // 409 reload, checked for both fields before any 400; a posted value that is
    // not a string or fails the travel-rule check -> 400 on that field. The
    // values are written after the code passed (existing branch) or by the
    // finalizer before its claim (draft branch).
    const originator: { address?: string; dateOfBirth?: string } = {};
    if ((otpTransfer?.transferType ?? otpDraft?.transferType ?? 'b2c') !== 'b2b' && payCtx.realMoneyForField && payOwnerId) {
      const view = await originatorViewFor(
        getDb(),
        true,
        otpTransfer
          ? {
              partnerId: otpTransfer.partnerId,
              phone: otpTransfer.phone,
              amountUsd: otpTransfer.amountUsd,
              destinationCountry: otpTransfer.destinationCountry,
              transferType: otpTransfer.transferType ?? 'b2c',
              transferId: otpTransfer.id,
              routed: !!otpTransfer.settlementPartnerId,
            }
          : {
              partnerId: payOwnerId,
              phone: otpDraft!.senderPhone,
              amountUsd: otpDraft!.amountUsd,
              destinationCountry: otpDraft!.destinationCountry ?? DEFAULT_DESTINATION_COUNTRY,
              transferType: otpDraft!.transferType ?? 'b2c',
              routed: !!otpDraft!.settlementPartnerId,
            },
      );
      const askAddress = view.addressRequired && !view.addressOnFile;
      const askDob = view.dobRequired && !view.dobOnFile;
      if ((askAddress && !body.present.senderAddress) || (askDob && !body.present.senderDob)) {
        return payReloadRequired(payFunded);
      }
      if (askAddress) {
        const valid = body.senderAddress === null ? null : validateSenderAddress(body.senderAddress);
        if (!valid?.ok) return payOriginatorInvalid('senderAddress');
        originator.address = valid.value;
      }
      if (askDob) {
        const valid = body.senderDob === null ? null : validateSenderDob(body.senderDob, new Date());
        if (!valid?.ok) return payOriginatorInvalid('senderDob');
        originator.dateOfBirth = valid.value;
      }
    }
    const hasOriginator = originator.address !== undefined || originator.dateOfBirth !== undefined;

    // Fix pack 4 (C18 step 6): after a 2xx b2c payment with a typed name, fill the
    // saved recipient's EMPTY book entry (best-effort; never changes the answer).
    // Review R1-P2 D2/E1/F1: only while the book holds the account actually PAID
    // (`paid`: raw method and destination, never a masked value).
    const withBookFill = async (
      res: NextResponse,
      t: Transfer,
      paid: { payoutMethod: PayoutMethod; payoutDestination: string },
    ): Promise<NextResponse> => {
      if (typedLegalName && res.status < 300) await fillRecipientBookLegalName(getDb(), t, typedLegalName, paid);
      return res;
    };

    const otpCheck = await getTransactionOtpStore().verify(payId, otpPhone, body.otp);
    if (!otpCheck.ok) {
      return NextResponse.json(
        { ok: false, error: 'Enter the confirmation code we sent to your WhatsApp.', reason: 'otp' },
        { status: 403 },
      );
    }

    // Fix pack 4 (C7, R41): the customer's evidence, built ONCE right after the
    // code passed and handed to every processTransferPayment call below, which
    // commits it on the locked awaiting row BEFORE any charge ("authorise, then
    // capture"). The ack and the snapshot only when the page posted a known
    // version AND the row is not b2b (the ROW's type, never the surface: a b2b
    // payment never gets an ack or snapshot, even from a crafted body). The
    // route id (draft or transfer) rides in meta.routeId; the rows name the
    // transfer that is paid.
    const evidenceAt = Date.now();
    const acked =
      (otpTransfer?.transferType ?? otpDraft?.transferType ?? 'b2c') !== 'b2b' && isDisclosureAckVersion(body.disclosureVersion)
        ? body.disclosureVersion
        : null;
    const evidence: PaymentEvidence = {
      auth: buildPaymentAuthEvidence({ otp: otpCheck, headers: req.headers, surface: 'transfer', routeId: transferId, now: evidenceAt }),
      disclosureAck: acked ? { version: acked, shownHash: body.disclosureHash, routeId: transferId } : null,
      disclosureSnapshot: acked
        ? { surface: 'transfer', version: acked, shownHash: body.disclosureHash, acknowledgedAt: evidenceAt }
        : null,
    };

    // Stage C2: a draft an AI app prepared pays only its stored account (400 before any charge).
    if (hasSubmittedFields && bankDetailsLocked(otpDraft)) {
      return NextResponse.json({ ok: false, error: BANK_DETAILS_LOCKED_ERROR }, { status: 400 });
    }

    let bankDetails: BankDetails | undefined;
    if (hasSubmittedFields) {
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawFields!)) {
        if (typeof v === 'string') fields[k] = v;
      }
      // fix 6: the per-country form is bound to THIS payment's destination
      // country (the transfer's, else the draft's) — a caller never picks
      // another country's field set for it.
      const target = (await store.getTransfer(payId)) ?? otpDraft;
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

    const transfer = await store.getTransfer(payId);

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
        return await processTransferPayment(store, withToken, evidence);
      }

      if (sendGateActive(owningPartner) && !isSendVerified(owner)) {
        return NextResponse.json(
          { ok: false, error: 'Please verify your identity before sending.', kyc_required: true },
          { status: 403 },
        );
      }
      // fix 6 (ctx-01): `transfer` is the DEFAULT (masked) read — it renders every
      // stored value, real or poisoned, as "****<last4>". Decide on the explicit
      // decrypted read; the value only feeds this boolean (and, below, the
      // recipient legal name only feeds the re-screen).
      const decrypted = await store.getTransferDecrypted(payId);
      const storedDestination = (decrypted?.payoutDestination ?? '').trim();

      // Program-Fix 14 follow-up: re-screen BOTH parties before any payout
      // write or charge — the mint's verdict may be stale (a scheduled mint had
      // no sender name to screen; lists change). Consumer rows only (the same
      // predicate pay-finalize uses): a B2B payer is screened by business name.
      let payable: Transfer = transfer;
      // Review R3-X1 M1: a failed name write on a funded row never says "nothing was charged".
      const nameWriteFailed = async (err: unknown): Promise<NextResponse> => {
        logWarn('pay.legal_name_write', err instanceof Error ? err.name : 'error', { transferId: transfer.id });
        // Review R1-P1 A2: the code is already spent, so a lasting fault
        // raises the same deduped payevidence alert as the evidence arms.
        await alertPayEvidenceUnavailable(getDb(), 'transfer'); // never throws
        pokeWorker(); // the ops.alert row is ready now
        return payApprovalNotRecorded(transferFunded(transfer));
      };
      if (transfer.transferType !== 'b2b') {
        if (!hasSenderName(owner)) {
          // Nothing screened or written; the SAME link works once the customer
          // answers the name question in chat.
          return NextResponse.json(
            { ok: false, error: SENDER_NAME_REQUIRED_MESSAGE, reason: 'sender_name_required' },
            { status: 400 },
          );
        }
        // Fix pack 2 T3 (R02): real money is decided by the transfer's RAIL
        // partner (routed, else owner) and its environment — never by the
        // owning partner — and then needs a live list and full name coverage.
        // The corridor rules stay the owner's.
        // Fix pack 4 (C18 step 3): WITHOUT posted bank details the typed
        // account-holder name is written fill-only, with its audit row, BEFORE
        // the re-screen, so the screened set equals the row (chat + legal). A
        // guard miss writes nothing and goes on (the identity hold at settle
        // catches a real-money row). A THROW answers 503 here, never through the
        // outer catch, which would log the raw error object.
        // Review R3-X1 N1 (decision D3): WITH posted bank details nothing is
        // written here: the typed name and its account are one guarded write
        // after the re-screen (writePayoutIfEditable), and the re-screen screens
        // the typed name directly. New details with no typed name over a real
        // stored account (isStoredAccount) drop the old name with the payout, so
        // the re-screen screens what the row will hold: the chat name.
        let legalRow = decrypted;
        if (typedLegalName && bankDetails === undefined) {
          let wrote: boolean;
          try {
            wrote = await writeRecipientLegalName(getDb(), transfer, typedLegalName);
          } catch (err) {
            return await nameWriteFailed(err);
          }
          if (wrote) legalRow = await store.getTransferDecrypted(payId);
          else logWarn('pay.legal_name_not_written', 'guard refused', { transferId: transfer.id });
        }
        // Fix pack 5 T21a (P21): the sender's travel-rule data validated before
        // the code, written set-if-unset on the OWNER's customer row with its
        // customer.travel_rule_set audit row, BEFORE the re-screen and any charge.
        // A guard miss (fewer fields written) goes on: the settle hold (P22)
        // catches a real-money row. A THROW answers 503 here (never the outer
        // catch, which would log the raw error object).
        if (hasOriginator) {
          try {
            await writeOriginatorInfo(
              getDb(),
              { partnerId: transfer.partnerId, phone: transfer.phone },
              originator,
              { source: 'pay_page', transferId: transfer.id },
            );
          } catch (err) {
            logWarn('pay.originator_write', err instanceof Error ? err.name : 'error', { transferId: transfer.id });
            await alertPayEvidenceUnavailable(getDb(), 'transfer'); // never throws
            pokeWorker(); // the ops.alert row is ready now
            return payApprovalNotRecorded(payFunded);
          }
        }
        const rowName = (legalRow?.recipientLegalName ?? '').trim();
        const screenedLegalName =
          bankDetails === undefined
            ? rowName
            : typedLegalName ?? (isStoredAccount(storedDestination) ? '' : rowName);
        const realMoney = await realMoneyFor(getDb(), transfer);
        const rescreen = await rescreenBeforePay(
          getDb(),
          transfer,
          {
            senderName: (owner?.fullName ?? '').trim(),
            recipientName: screenedLegalName || transfer.recipientName,
          },
          resolveCorridorRules(owningPartner, transfer.sourceCountry ?? 'US'),
          { realMoney, stage: 'pay' },
        );
        switch (rescreen.kind) {
          case 'blocked':
            logWarn('pay.rescreen_blocked', 'existing transfer blocked by the pay-time re-screen', { transferId: transfer.id });
            return NextResponse.json({ ok: false, error: "We can't process this transfer." }, { status: 400 });
          case 'moved': {
            const current = await store.getTransfer(payId);
            const nowRefused = current ? refuseUnlessAwaiting(current) : null;
            return nowRefused ?? NextResponse.json({ ok: false, error: 'Payment failed' }, { status: 409 });
          }
          case 'flagged':
          case 'cleared':
            payable = rescreen.transfer;
            break;
        }
      }
      const hasDestination = isStoredAccount(storedDestination);
      // Sender-entered, server-validated, country-bound bank details (the page's
      // Step 1, or its "Edit bank details") fill or replace the payout of a
      // CONSUMER transfer through ONE guarded write. A B2B payee is never payer
      // input: its body is ignored.
      if (bankDetails && transfer.transferType !== 'b2b') {
        // Review R3-X1 N1 (decision D3): the payout, the typed name (or the clear
        // of the old account's name) and both audit rows in ONE transaction.
        let edited: Transfer | null;
        try {
          edited = await writePayoutIfEditable(transfer, bankDetails, typedLegalName);
        } catch (err) {
          if (!typedLegalName) throw err; // the payout write alone answers as before (outer catch)
          return await nameWriteFailed(err);
        }
        if (!edited) {
          // A guard failed after our read (a concurrent POST charged / settled /
          // held it — the OTP verify is not atomic), or the row is not editable
          // here (charged, partner-API-minted). Never write around the guard:
          // report current truth. Nothing was written: the old account keeps its name.
          const current = await store.getTransfer(payId);
          const nowRefused = current ? refuseUnlessAwaiting(current) : null;
          if (nowRefused) return nowRefused;
          return NextResponse.json(
            { ok: false, error: "This transfer's bank details can't be changed here.", reason: 'payout_locked' },
            { status: 409 },
          );
        }
        return await withBookFill(await processTransferPayment(store, edited, evidence), transfer, {
          payoutMethod: bankDetails.payoutMethod ?? 'bank',
          payoutDestination: bankDetails.payoutDestination ?? '',
        });
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
      // Destination already set (re-opened link) → process exactly as before
      // (with the re-screened row: a flagged verdict takes the normal hold).
      return await withBookFill(await processTransferPayment(store, payable, evidence), transfer, {
        payoutMethod: transfer.payoutMethod,
        payoutDestination: storedDestination,
      });
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
    const result = await finalizeDraftPayment(
      stores,
      transferId,
      bankDetails,
      typedLegalName || hasOriginator
        ? {
            ...(typedLegalName ? { recipientLegalName: typedLegalName } : {}),
            ...(hasOriginator ? { originator } : {}),
          }
        : undefined,
    );
    if (!result.ok) {
      if (result.error === 'originator_not_recorded') {
        // Fix pack 5 T21a (P21): the finalizer could not write the sender's
        // travel-rule data (it logged the error name). Nothing was claimed,
        // minted or charged; the code is spent, so the same deduped alert as
        // the evidence arms. A draft is never funded.
        await alertPayEvidenceUnavailable(getDb(), 'transfer'); // never throws
        pokeWorker();
        return payApprovalNotRecorded();
      }
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
            // Step 0 (N9): the client shows "This quote has expired" (nothing was
            // minted or cancelled), not the retry line. `reason` is unchanged.
            ...(result.quoteExpired ? { quoteExpired: true } : {}),
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
      if (result.error === 'sender_name_required') {
        // Program-Fix 14: the sender's legal name is not on file, so this send
        // cannot be screened yet. Nothing was minted, claimed or consumed; the
        // SAME link works once the customer answers the name question in chat.
        return NextResponse.json(
          { ok: false, error: SENDER_NAME_REQUIRED_MESSAGE, reason: 'sender_name_required' },
          { status: 400 },
        );
      }
      if (result.error === 'sends_paused') {
        // Release safety part A: the sends.paused kill switch. Nothing was
        // minted, charged or consumed; the SAME link works once it is off.
        return NextResponse.json(
          { ok: false, error: SENDS_PAUSED_MESSAGE, reason: 'sends_paused' },
          { status: 503 },
        );
      }
      if (result.error === 'reward_ended') {
        // B3 rewards v1: the reward on this approved quote ended before the
        // mint. Nothing was minted or charged; the draft is kept. The customer
        // asks for a new quote (the approved price is never changed silently).
        return NextResponse.json(
          { ok: false, error: REWARD_ENDED_MESSAGE, reason: 'reward_ended' },
          { status: 409 },
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
      if (result.error === 'not_available') {
        // Pack 3 (contract 5): a live control refused the mint. Nothing was
        // minted, charged or consumed; the neutral 409 never names the reason.
        return payNotAvailable();
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
      return await processTransferPayment(store, withToken, evidence);
    }
    // Review R1-P2 D2/E1/F1: the account the mint paid, from plaintext already in
    // scope (the posted details, else the draft's stored account; never the masked
    // row). A crash-replay that minted another body's account just fills nothing.
    return await withBookFill(await processTransferPayment(store, created, evidence), created, {
      payoutMethod: created.payoutMethod,
      payoutDestination: (bankDetails?.payoutDestination ?? '').trim() || (otpDraft?.recipient?.payoutDestination ?? '').trim(),
    });
  } catch (err) {
    logError('pay.route', err, { transferId });
    // Fix D: an infrastructure error (Redis / Neon) is retryable, not a refusal.
    // The copy never says nothing was charged: this catch also wraps post-capture
    // code, and a re-POST converges (claim-first replay / refuseUnlessAwaiting).
    // Review R2-Q1 B4: a failed single-use code consume is retryable whatever its shape.
    if (isInfraError(err) || isOtpConsumeFailure(err)) {
      return NextResponse.json(
        { ok: false, error: 'Temporary problem. Please try again in a moment.', reason: 'temporarily_unavailable' },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: false, error: 'Payment failed' }, { status: 400 });
  }
}
