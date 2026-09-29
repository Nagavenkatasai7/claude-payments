'use server';

import { redirect } from 'next/navigation';
import { getDb } from '@/db/client';
import { requirePortalSite } from '@/lib/portal-site';
import { requireFreshPortalAuth, requirePortalCustomer, type PortalCustomerContext } from '@/lib/portal-auth';
import { getRedis } from '@/lib/redis';
import { getPartnerStore } from '@/lib/partner-store';
import { checkIpRateLimit } from '@/lib/ip-rate-limit';
import { auditSubjectId } from '@/lib/customer-ref';
import { newRequestKey, runOnce, RequestInFlightError, BadRequestKeyError } from '@/lib/portal-request-key';
import { findByRid } from '@/lib/portal-recipients';
import { getPortalTransfer } from '@/lib/portal-transfers';
import { executeTool } from '@/lib/tools';
import { prepareSendDraft, portalPayUrl, type PrepareSendResult } from '@/lib/send-seam';
import { allowedSendCurrencies } from '@/lib/partner-currency';
import { normalizeSenderName } from '@/lib/sender-identity';
import { logWarn } from '@/lib/log';
import { SEND_GATE_REASON } from '@/lib/kyc-gate';
import {
  capCopy,
  claimReviewDraft,
  isDraftId,
  releaseReviewDraft,
  limitsCopy,
  loadSendReview,
  markReviewDrafted,
  portalKycGate,
  portalToolContext,
  prepareResultCopy,
  canVerifyInProfile,
  routeKycCopy,
  PORTAL_SEND_LIMIT,
  recordSendAudit,
  saveSendReview,
  sendLimitsForPortal,
  toPrepareSendInput,
  validateSendForm,
  type PortalOwner,
  type SendCopy,
  type SendFormErrors,
} from '@/lib/portal-send';
import type { MessageKey } from '@/lib/i18n';

/**
 * Customer-portal Send (UI redesign M2-9, Tasks 9.2-9.4). Public POST endpoints. Each one runs the host
 * gate FIRST (requirePortalSite), then the session (and the 15-minute step-up where money is at
 * stake), then its checks. The partner is the HOST's and the phone the SESSION's; a rid resolves only
 * inside (partner, phone), a transfer id only inside the customer's own ledger. Next's Origin/Host
 * check covers these actions (node_modules/next/dist/docs/01-app/02-guides/data-security.md:550).
 *
 * The portal NEVER mints. "Continue to pay" makes ONE draft through the bot's own prepareSendDraft
 * (re-quoted on the server; nothing posted is trusted) and redirects to the existing pay page, where
 * the claim-first mint happens.
 */

export interface SendFormState {
  error?: MessageKey;
  errors?: SendFormErrors;
  /** Echo of what the customer typed, so the form keeps it after an error. */
  values?: Record<string, string>;
}

export interface ContinueState {
  /** A fresh key after every refusal, so the corrected resubmit runs. */
  requestKey: string;
  error?: MessageKey;
  vars?: Record<string, string>;
  kyc?: 'verify' | 'contact';
}

export interface NameFormState {
  error?: MessageKey;
}

const text = (fd: FormData, k: string, max = 200) => {
  const v = fd.get(k);
  return typeof v === 'string' ? v.slice(0, max) : '';
};

const ECHO = ['amount', 'currency', 'destination', 'funding', 'recipient', 'name', 'phone'] as const;
const echo = (fd: FormData) => Object.fromEntries(ECHO.map((k) => [k, text(fd, k, 80)]));

const ownerOf = (ctx: PortalCustomerContext): PortalOwner => ({ partnerId: ctx.site.partnerId, phone: ctx.session.phone });

/** Per customer: Continue + Send again, 20 an hour. Fails OPEN on a limiter error (the step-up gates it). */
async function withinSendLimit(owner: PortalOwner): Promise<boolean> {
  try {
    const r = await checkIpRateLimit(getRedis(), PORTAL_SEND_LIMIT.scope, auditSubjectId(owner.partnerId, owner.phone), {
      limit: PORTAL_SEND_LIMIT.limit,
      windowSec: PORTAL_SEND_LIMIT.windowSec,
    });
    return r.allowed;
  } catch {
    logWarn('portal.send.limit', 'limiter unavailable');
    return true;
  }
}

const refuse = (c: SendCopy | { error: MessageKey }): ContinueState => ({ requestKey: newRequestKey(), ...c });

/** The customer row and partner, read fresh for this request (pure reads; no provider call). */
async function customerAndPartner(owner: PortalOwner) {
  const ctx = portalToolContext(owner);
  const [customer, partner] = await Promise.all([
    ctx.customerStore.getCustomer(owner.partnerId, owner.phone),
    getPartnerStore().getPartner(owner.partnerId),
  ]);
  return { customer, partner };
}

// ── Step 1: the Send form → the review slot ───────────────────────────────────

/**
 * Validate the Send form and keep it in the customer's review slot (no PII in any URL), then go to
 * the review. A saved recipient must be a LIVE one in the customer's own book (another tenant's rid
 * and a deleted recipient read as "not found"). No quote, no draft, no provider call here.
 */
export async function startSendReviewAction(_prev: SendFormState, formData: FormData): Promise<SendFormState> {
  const site = await requirePortalSite();
  const ctx = await requirePortalCustomer();
  const owner = ownerOf(ctx);
  const partner = await getPartnerStore().getPartner(site.partnerId);
  const v = validateSendForm(formData, { allowedCurrencies: partner ? allowedSendCurrencies(partner) : ['USD'] });
  if (!v.ok) return { errors: v.errors, values: echo(formData) };
  if (v.value.recipient.kind === 'saved' && !(await findByRid(getDb(), owner.partnerId, owner.phone, v.value.recipient.rid))) {
    return { error: 'portal.send.recipient_not_found', values: echo(formData) };
  }
  try {
    await saveSendReview(getRedis(), owner, v.value);
  } catch {
    logWarn('portal.send.review', 'review store failed');
    return { error: 'portal.send.failed', values: echo(formData) };
  }
  redirect('/portal/send/review');
}

// ── Step 2: the sender's legal name (set-once) ────────────────────────────────

/**
 * The review's "Your legal name" step: the bot's own set_sender_name (own tenant + phone, set-once,
 * sealed). The tool writes no audit, so this action adds `customer.sender_name.set` (no value in meta).
 */
export async function setSenderNameAction(_prev: NameFormState, formData: FormData): Promise<NameFormState> {
  await requirePortalSite();
  await requirePortalCustomer();
  const ctx = await requireFreshPortalAuth('/portal/send/review');
  const owner = ownerOf(ctx);
  const fullName = normalizeSenderName(text(formData, 'fullName'));
  if (fullName === null) return { error: 'portal.send.legal_name_invalid' };
  let saved = false;
  try {
    const r = await executeTool('set_sender_name', { full_name: fullName }, portalToolContext(owner));
    if (r.saved === true) saved = true;
    else if (r.already_on_file !== true) return { error: 'portal.send.failed' };
  } catch {
    logWarn('portal.send.name', 'save failed');
    return { error: 'portal.send.failed' };
  }
  if (saved) {
    try {
      await recordSendAudit(getDb(), owner, { action: 'customer.sender_name.set', meta: {} });
    } catch {
      logWarn('portal.send.name_audit', 'audit failed');
    }
  }
  redirect('/portal/send/review');
}

// ── Step 3: Continue to pay ───────────────────────────────────────────────────

/**
 * Continue to pay. In order: host gate → session → step-up → per-customer limit → the review slot
 * (bound to this customer; the posted review id must match, so a swap in another tab never sends a
 * different transfer) → the recipient re-resolved (a delete since the review wins) → the pure KYC gate
 * → the bot's cap + EDD pre-check (check_send_limit) → ONE prepareSendDraft per request key (the web
 * pointer) → audit → the pay page. Everything is re-derived on the server: no posted amount, rate or
 * fee is read, and unknown fields are never forwarded.
 */
export async function continueToPayAction(_prev: ContinueState, formData: FormData): Promise<ContinueState> {
  const site = await requirePortalSite();
  await requirePortalCustomer();
  const ctx = await requireFreshPortalAuth('/portal/send/review');
  const owner = ownerOf(ctx);
  if (!(await withinSendLimit(owner))) return refuse({ error: 'portal.send.too_many' });

  let review: Awaited<ReturnType<typeof loadSendReview>>;
  let recipient: { phone: string; name: string } | null = null;
  let loaded: Awaited<ReturnType<typeof customerAndPartner>>;
  try {
    review = await loadSendReview(getRedis(), owner);
    if (review && review.recipient.kind === 'saved') {
      const r = await findByRid(getDb(), owner.partnerId, owner.phone, review.recipient.rid);
      recipient = r ? { phone: r.recipientPhone, name: r.name } : null;
    } else if (review && review.recipient.kind === 'new') {
      recipient = { phone: review.recipient.phone, name: review.recipient.name };
    }
    loaded = await customerAndPartner(owner);
  } catch {
    logWarn('portal.send.continue', 'read failed');
    return refuse({ error: 'portal.send.failed' });
  }
  if (!review) redirect('/portal/send');
  if (text(formData, 'rv', 64) !== review.id) return refuse({ error: 'portal.send.changed' });
  if (!recipient) return refuse({ error: 'portal.send.recipient_not_found' });
  const recipientPhone = recipient.phone;
  const recipientName = recipient.name;

  const { customer, partner } = loaded;
  const gated = portalKycGate(partner, customer, site.brand);
  if (gated) return refuse(gated);

  // Review round 1, M5: the bot reaches a web draft only through repeat_transfer, which runs this
  // same cap + EDD check first. This action is a public POST, so it runs it itself, BEFORE runOnce.
  const limits = await sendLimitsForPortal(owner, { amountSource: review.amountSource, sourceCurrency: review.sourceCurrency });
  // M2-14 (PR 413 L1): any later 'verify' card that Profile could not act on becomes the contact card.
  const kycRoute = (c: SendCopy) => routeKycCopy(c, canVerifyInProfile(partner, customer), site.brand);
  const limitRefusal = limitsCopy(limits, site.brand);
  if (limitRefusal) return refuse(kycRoute(limitRefusal));

  const input = toPrepareSendInput({
    recipientPhone,
    recipientName,
    amountSource: review.amountSource,
    sourceCurrency: review.sourceCurrency,
    destinationCountry: review.destinationCountry,
    fundingMethod: review.fundingMethod,
  });
  if (!input) return refuse({ error: 'portal.send.recipient_not_found' });

  let fresh: Exclude<PrepareSendResult, { kind: 'draft' }> | undefined;
  const redis = getRedis();
  let outcome: { kind: string; draftId?: string };
  try {
    ({ value: outcome } = await runOnce(redis, 'portal-send', owner.partnerId, owner.phone, text(formData, 'requestKey', 64), async () => {
      // M1: this review already made a draft (paid, pending or expired): never a second one from it.
      // Inside the claim, so a double submit of the FIRST Continue still replays its redirect; the NX
      // marker makes it atomic across two tabs with different request keys.
      if (review.draftId || !(await claimReviewDraft(redis, review.id))) return { kind: 'already_sent' };
      let r: PrepareSendResult;
      try {
        r = await prepareSendDraft(portalToolContext(owner), input, { pointer: 'web' });
        if (r.kind !== 'draft') {
          fresh = r;
          await releaseReviewDraft(redis, review.id);
          return { kind: r.kind };
        }
        // Inside the claim: audited exactly once per request key; then the slot records the draft, so
        // the page never offers Continue again. A failure throws, the claims are released and the
        // customer retries (an abandoned web draft is unpaid and expires in 30 minutes).
        await recordSendAudit(getDb(), owner, { action: 'customer.send.draft', meta: { draftId: r.draftId, via: 'send' } });
        await markReviewDrafted(redis, owner, review.id, r.draftId);
      } catch (err) {
        await releaseReviewDraft(redis, review.id).catch(() => undefined);
        throw err;
      }
      return { kind: 'draft', draftId: r.draftId };
    }));
  } catch (err) {
    if (err instanceof RequestInFlightError) return refuse({ error: 'portal.send.busy' });
    if (!(err instanceof BadRequestKeyError)) logWarn('portal.send.draft', 'draft failed');
    return refuse({ error: 'portal.send.failed' });
  }

  if (outcome.kind === 'already_sent') return refuse({ error: 'portal.send.already_sent' });
  if (outcome.kind === 'draft' && isDraftId(outcome.draftId)) redirect(portalPayUrl(outcome.draftId));
  // A replay of a refusal has no evaluation in hand: the neutral line.
  return refuse(fresh ? kycRoute(prepareResultCopy(fresh, site.brand)) : { error: 'portal.send.cannot_complete' });
}

// ── Send again (Task 9.4) ─────────────────────────────────────────────────────

const TRANSFER_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

/** The bot's repeat_transfer record, narrowed. Model-facing text is never read. */
function narrowRepeat(r: Record<string, unknown>, brand: string): { kind: 'draft'; draftId: string } | { kind: 'copy'; copy: SendCopy } {
  if (isDraftId(r.draft_id) && typeof r.pay_url === 'string') return { kind: 'draft', draftId: r.draft_id };
  if (r.needs_edd === true) return { kind: 'copy', copy: { error: 'portal.send.edd_whatsapp' } };
  if (r.needs_sender_name === true) return { kind: 'copy', copy: { error: 'portal.send.name_needed' } };
  if (r.kyc_required === true) return { kind: 'copy', copy: { error: 'portal.send.kycBody', kyc: 'verify' } };
  if (r.cap_eval && typeof r.cap_eval === 'object') {
    const ev = r.cap_eval as Record<string, unknown>;
    if (ev.reason === SEND_GATE_REASON) return { kind: 'copy', copy: { error: 'portal.send.kycBody', kyc: 'verify' } };
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    return {
      kind: 'copy',
      copy: capCopy(typeof ev.reason === 'string' ? ev.reason : undefined, { todayRemainingUsd: n(ev.today_remaining_usd), perTransferCapUsd: n(ev.per_transfer_cap_usd) }, brand),
    };
  }
  return { kind: 'copy', copy: { error: 'portal.send.cannot_complete' } };
}

/**
 * "Send again" on the transfer detail: the bot's own repeat_transfer (its cap + EDD re-check, then
 * the same draft seam, on the web pointer) for the customer's OWN transfer. The transfer id is the
 * route's (bound), re-scoped to (host partner, session phone): another customer's id is "not found".
 */
export async function sendAgainAction(transferId: string, _prev: ContinueState, formData: FormData): Promise<ContinueState> {
  const site = await requirePortalSite();
  await requirePortalCustomer();
  const safeId = typeof transferId === 'string' && TRANSFER_ID_RE.test(transferId) ? transferId : '';
  const ctx = await requireFreshPortalAuth(safeId ? `/portal/transfers/${safeId}` : '/portal/transfers');
  const owner = ownerOf(ctx);
  let t: Awaited<ReturnType<typeof getPortalTransfer>>;
  let loaded: Awaited<ReturnType<typeof customerAndPartner>>;
  try {
    t = safeId ? await getPortalTransfer(owner, safeId) : null;
    loaded = await customerAndPartner(owner);
  } catch {
    logWarn('portal.send.again', 'read failed');
    return refuse({ error: 'portal.send.failed' });
  }
  // A business bill payment is never repeated as a consumer send (the bill flow is the bot's), and a
  // blocked transfer is never repeated (the page hides the button; this refuses a forged POST too).
  if (!t || t.transferType === 'b2b' || t.status === 'blocked') return refuse({ error: 'portal.send.not_found' });
  if (!(await withinSendLimit(owner))) return refuse({ error: 'portal.send.too_many' });

  const { customer, partner } = loaded;
  const gated = portalKycGate(partner, customer, site.brand);
  if (gated) return refuse(gated);

  let outcome: { kind: string; draftId?: string };
  let copy: SendCopy | undefined;
  try {
    ({ value: outcome } = await runOnce(getRedis(), 'portal-send-again', owner.partnerId, owner.phone, text(formData, 'requestKey', 64), async () => {
      const r = narrowRepeat(await executeTool('repeat_transfer', { transfer_id: t.id }, portalToolContext(owner)), site.brand);
      if (r.kind === 'copy') {
        copy = r.copy;
        return { kind: 'refused' };
      }
      await recordSendAudit(getDb(), owner, { action: 'customer.send.draft', meta: { draftId: r.draftId, via: 'send_again' } });
      return { kind: 'draft', draftId: r.draftId };
    }));
  } catch (err) {
    if (err instanceof RequestInFlightError) return refuse({ error: 'portal.send.busy' });
    if (!(err instanceof BadRequestKeyError)) logWarn('portal.send.again', 'repeat failed');
    return refuse({ error: 'portal.send.failed' });
  }
  if (outcome.kind === 'draft' && isDraftId(outcome.draftId)) redirect(portalPayUrl(outcome.draftId));
  // M2-14 (PR 413 L1): a dead-end 'verify' card becomes the contact card.
  return refuse(copy ? routeKycCopy(copy, canVerifyInProfile(partner, customer), site.brand) : { error: 'portal.send.cannot_complete' });
}
