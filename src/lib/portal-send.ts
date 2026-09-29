import { randomBytes } from 'node:crypto';
import { buildToolContext, type ToolContextDeps } from './tool-context';
import { executeTool, type ToolContext } from './tools';
import { getQuoteTyped, type PrepareSendInput, type PrepareSendResult, type QuoteTypedResult } from './send-seam';
import { getKycProvider } from './providers/kyc-provider';
import type { KycProvider } from './providers/kyc-provider';
import { getCustomerStore } from './customer-store';
import { getStore, type RedisLike } from './store';
import { env } from './env';
import { isSendVerified, SEND_GATE_REASON, sendGateActive } from './kyc-gate';
import { resolveKycMode } from './partner-config';
import { createAuditRepo } from '@/db/repos/aux-repos';
import type { DbOrTx } from '@/db/client';
import { auditSubjectId } from './customer-ref';
import { PORTAL_AUTH_ACTOR } from './portal-auth-audit';
import { formatMoney } from './ui/money';
import { FX_MAX_AGE_MS } from './rate';
import type { DraftStore } from './draft-store';
import { boundUntrustedText, NAME_MAX } from './untrusted-text';
import { isSupportedDestination, SUPPORTED_DESTINATIONS } from './destination-country';
import { isValidPhone, normalizePhone } from './phone';
import { isRid, validateRecipientName } from './portal-recipients';
import type { MessageKey } from './i18n';
import type { PortalOwner } from './portal-transfers';
import type { CountryCode, CurrencyCode, Customer, Partner, TurnContext } from './types';

/**
 * portal-send — the customer portal's Send adapter (UI redesign M2-9). Server only.
 *
 * NO new money logic: the quote is the bot's getQuoteTyped, the limits are the bot's
 * check_send_limit (through executeTool, web channel), the draft is prepareSendDraft (the caller,
 * src/app/portal/send/actions.ts), and the mint stays on the existing pay page. This module only:
 *
 * - builds the tool context from the HOST partner and the SESSION phone (never a form field), through
 *   the one builder (buildToolContext), on the web channel;
 * - swaps in a NON-MINTING KYC provider. The bot's tools start a verification inquiry as a side effect
 *   (a verified customer inside the 3-day T0 window gets one on every check_send_limit, and on any
 *   over-cap quote). The portal never shows that link (it points at /portal/profile#verify), so a
 *   page render or a refused POST must not create provider inquiries;
 * - validates the Send form at the edge (consumer funding only: `ach_pull` alone makes a send B2B in
 *   the seam, so it never gets past here);
 * - keeps the in-progress send in ONE per-customer Redis slot (`psend:<sha256(partner|phone)>`), so
 *   no recipient name or phone is ever in a URL and the review survives the step-up round trip
 *   (the step-up `next` allow-list carries no query).
 */

// ── Limits and closed sets ────────────────────────────────────────────────────

/** Per customer, "Continue to pay" and "Send again" together: 20 an hour. */
export const PORTAL_SEND_LIMIT = { scope: 'portal-send', limit: 20, windowSec: 3600 } as const;

/**
 * The consumer funding methods (the bot's repeat_transfer set). `ach_pull` is deliberately absent:
 * prepareSendDraft treats funding `ach_pull` alone as a B2B bill payment.
 */
export const PORTAL_FUNDING_METHODS = ['bank_transfer', 'debit_card', 'credit_card'] as const;
export type PortalFundingMethod = (typeof PORTAL_FUNDING_METHODS)[number];

export const isPortalFunding = (v: unknown): v is PortalFundingMethod =>
  typeof v === 'string' && (PORTAL_FUNDING_METHODS as readonly string[]).includes(v);

/** The portal's destinations: every supported corridor (the one authority, destination-country.ts). */
export const PORTAL_DESTINATIONS: readonly CountryCode[] = SUPPORTED_DESTINATIONS;

export type { PortalOwner };

// ── The tool context ──────────────────────────────────────────────────────────

/** The TurnContext of a web form submit: no model message, never a new conversation. */
export const webFormTurn = (): TurnContext => ({ isNewConversation: false });

/**
 * A KYC provider that never starts an inquiry: `startVerification` returns an empty link and an empty
 * providerRef (so the tools' recordKycInquiry is skipped). Status reads and webhooks pass through.
 */
export function nonMintingKyc(real: KycProvider): KycProvider {
  return {
    startVerification: async () => ({ url: '', providerRef: '' }),
    getStatus: (ref) => real.getStatus(ref),
    handleWebhook: (body) => real.handleWebhook(body),
  };
}

/**
 * The bot's ToolContext for a portal customer: the host partner + session phone, channel 'web', a
 * web form turn, and the non-minting KYC provider. Every other dep is the bot's own singleton.
 */
export function portalToolContext(owner: PortalOwner, deps: Partial<ToolContextDeps> = {}): ToolContext {
  const kyc =
    deps.kycProvider ?? getKycProvider(deps.customerStore ?? getCustomerStore(deps.store ?? getStore()), env.appBaseUrl);
  return buildToolContext({
    partnerId: owner.partnerId,
    phone: owner.phone,
    channel: 'web',
    turn: webFormTurn(),
    deps: { ...deps, kycProvider: nonMintingKyc(kyc) },
  });
}

// ── Quote and limits (the bot's functions, typed) ─────────────────────────────

export interface PortalQuoteInput {
  amountSource: number;
  sourceCurrency: CurrencyCode;
  destinationCountry: CountryCode;
  fundingMethod: PortalFundingMethod;
}

/** getQuoteTyped over the portal context (the same numbers as the bot's get_quote). */
export function quoteForPortal(owner: PortalOwner, input: PortalQuoteInput, deps?: Partial<ToolContextDeps>): Promise<QuoteTypedResult> {
  return getQuoteTyped(portalToolContext(owner, deps), {
    amountSource: input.amountSource,
    sourceCurrency: input.sourceCurrency,
    destinationCountry: input.destinationCountry,
    fundingMethod: input.fundingMethod,
  });
}

export type PortalSendLimits =
  | {
      kind: 'limits';
      withinCap: boolean;
      tier: string;
      reason?: string;
      dailyCapUsd: number;
      perTransferCapUsd: number;
      todayRemainingUsd: number;
      eddRequired: boolean;
    }
  | { kind: 'kyc_required' }
  /** Anything else (FX down, an unexpected shape): generic copy, never the raw result. */
  | { kind: 'unavailable' };

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Narrow check_send_limit's record. An unknown shape is `unavailable`, never rendered raw. */
export function narrowSendLimits(r: Record<string, unknown>): PortalSendLimits {
  if (r.within_cap === false && r.reason === SEND_GATE_REASON && r.tier === undefined) return { kind: 'kyc_required' };
  if (
    typeof r.within_cap !== 'boolean' ||
    typeof r.tier !== 'string' ||
    !num(r.daily_cap_usd) ||
    !num(r.per_transfer_cap_usd) ||
    !num(r.today_remaining_usd) ||
    typeof r.edd_required !== 'boolean'
  ) {
    return { kind: 'unavailable' };
  }
  return {
    kind: 'limits',
    withinCap: r.within_cap,
    tier: r.tier,
    reason: typeof r.reason === 'string' ? r.reason : undefined,
    dailyCapUsd: r.daily_cap_usd,
    perTransferCapUsd: r.per_transfer_cap_usd,
    todayRemainingUsd: r.today_remaining_usd,
    eddRequired: r.edd_required,
  };
}

/**
 * The bot's check_send_limit (cap + EDD) on the portal context, with the argument shape
 * repeat_transfer passes (tools.ts repeatTransferTool). Without an amount it reads the limits only.
 */
export async function sendLimitsForPortal(
  owner: PortalOwner,
  amount?: { amountSource: number; sourceCurrency: CurrencyCode },
  deps?: Partial<ToolContextDeps>,
): Promise<PortalSendLimits> {
  const args = amount ? { amount_usd: amount.amountSource, source_currency: amount.sourceCurrency } : { amount_usd: 0 };
  try {
    return narrowSendLimits(await executeTool('check_send_limit', args, portalToolContext(owner, deps)));
  } catch {
    return { kind: 'unavailable' };
  }
}

// ── The consumer-only draft input ─────────────────────────────────────────────

/** What a portal send may carry: a consumer send and nothing else (no B2B, no EDD answers). */
export interface PortalSendInput {
  recipientPhone: string;
  recipientName: string;
  amountSource: number;
  sourceCurrency: CurrencyCode;
  destinationCountry: CountryCode;
  fundingMethod: PortalFundingMethod;
}

/**
 * Map to the seam's input. Sets ONLY the consumer fields: never entityType, the business names,
 * invoiceId, nor the EDD enums (recipientLegalName, relationship, purpose, sourceOfFunds,
 * occupation). The name is clamped like repeat_transfer's; null when it clamps to nothing.
 */
export function toPrepareSendInput(i: PortalSendInput): PrepareSendInput | null {
  const recipientName = boundUntrustedText(i.recipientName, NAME_MAX);
  if (!recipientName) return null;
  if (!isPortalFunding(i.fundingMethod)) return null;
  return {
    recipientPhone: i.recipientPhone,
    recipientName,
    amountSource: i.amountSource,
    sourceCurrency: i.sourceCurrency,
    destinationCountry: i.destinationCountry,
    fundingMethod: i.fundingMethod,
  };
}

// ── Edge validation ───────────────────────────────────────────────────────────

const AMOUNT_RE = /^\d{1,7}(\.\d{1,2})?$/;

/** A positive amount with at most 2 decimals, or null. */
export function parseAmount(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/,/g, '');
  if (!AMOUNT_RE.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export type SendRecipientChoice = { kind: 'saved'; rid: string } | { kind: 'new'; name: string; phone: string };

export interface SendFormValue {
  amountSource: number;
  sourceCurrency: CurrencyCode;
  destinationCountry: CountryCode;
  fundingMethod: PortalFundingMethod;
  recipient: SendRecipientChoice;
}

export type SendFormField = 'amount' | 'currency' | 'destination' | 'funding' | 'recipient' | 'name' | 'phone';
export type SendFormErrors = Partial<Record<SendFormField, MessageKey>>;

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === 'string' ? v : '';
};

/**
 * Validate the Send form. The currency must be one the partner sends in, the destination a supported
 * corridor, the funding a consumer method, and the recipient either a well-formed rid (resolved by the
 * caller inside the customer's own book) or a new name + phone. Unknown fields are never read.
 */
export function validateSendForm(
  fd: FormData,
  opts: { allowedCurrencies: readonly CurrencyCode[] },
): { ok: true; value: SendFormValue } | { ok: false; errors: SendFormErrors } {
  const errors: SendFormErrors = {};
  const amountSource = parseAmount(str(fd, 'amount'));
  if (amountSource === null) errors.amount = 'portal.send.amount_invalid';
  const currencyRaw = str(fd, 'currency').trim().toUpperCase();
  const sourceCurrency = opts.allowedCurrencies.find((c) => c === currencyRaw) ?? (opts.allowedCurrencies.length === 1 ? opts.allowedCurrencies[0] : undefined);
  if (!sourceCurrency) errors.currency = 'portal.send.currency_invalid';
  const destRaw = str(fd, 'destination').trim().toUpperCase();
  const destinationCountry = isSupportedDestination(destRaw) ? destRaw : undefined;
  if (!destinationCountry) errors.destination = 'portal.send.destination_invalid';
  const fundingRaw = str(fd, 'funding');
  if (!isPortalFunding(fundingRaw)) errors.funding = 'portal.send.funding_invalid';

  let recipient: SendRecipientChoice | undefined;
  const choice = str(fd, 'recipient');
  if (choice === 'new') {
    const name = validateRecipientName(str(fd, 'name'));
    const phone = normalizePhone(str(fd, 'phone'));
    if (!name) errors.name = 'portal.send.name_invalid';
    if (!isValidPhone(phone)) errors.phone = 'portal.send.phone_invalid';
    if (name && isValidPhone(phone)) recipient = { kind: 'new', name, phone };
  } else if (isRid(choice)) {
    recipient = { kind: 'saved', rid: choice };
  } else {
    errors.recipient = 'portal.send.recipient_invalid';
  }

  if (Object.keys(errors).length > 0 || amountSource === null || !sourceCurrency || !destinationCountry || !isPortalFunding(fundingRaw) || !recipient) {
    return { ok: false, errors };
  }
  return { ok: true, value: { amountSource, sourceCurrency, destinationCountry, fundingMethod: fundingRaw, recipient } };
}

/**
 * Home-send H2: the Send page's pre-fill from `?amount=&to=&r=`. INITIAL VALUES ONLY: each value is
 * validated here and dropped silently when doubtful (never coerced). The amount is a 2-decimal number
 * within [1, ceilingUsd] (the sender's quote ceiling; USD partners only); `to` a supported ISO2 corridor; `r` a
 * well-formed rid (the page resolves it inside the customer's own book, so another customer's,
 * another tenant's or a deleted recipient's rid is dropped there).
 */
export function parsePrefill(
  sp: Record<string, string | string[] | undefined>,
  opts: { ceilingUsd: number; sourceCurrency: string },
): { amount?: string; to?: CountryCode; rid?: string } {
  const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);
  const out: { amount?: string; to?: CountryCode; rid?: string } = {};
  const rawAmount = one(sp.amount);
  const amount = rawAmount !== undefined && /^\d{1,7}(\.\d{1,2})?$/.test(rawAmount) ? Number(rawAmount) : null;
  // The ceiling is USD: applied when the partner sends in USD; otherwise only the format and a floor
  // (the quote on the review applies the real bounds in any currency).
  const ceiling = opts.sourceCurrency === 'USD' ? opts.ceilingUsd : 9_999_999;
  if (amount !== null && amount >= 1 && amount <= ceiling) out.amount = amount.toFixed(2);
  const to = one(sp.to);
  if (to !== undefined && /^[A-Z]{2}$/.test(to) && isSupportedDestination(to)) out.to = to;
  const r = one(sp.r);
  if (isRid(r)) out.rid = r;
  return out;
}

// ── The per-customer review slot ──────────────────────────────────────────────

export const PORTAL_SEND_REVIEW_TTL_S = 1800;
const REVIEW_ID_RE = /^[0-9a-f]{32}$/;
const DRAFT_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

export interface PortalSendReview extends SendFormValue {
  /** The review version: Continue posts it back, and a mismatch (another tab replaced it) refuses. */
  id: string;
  /** Set once Continue made a draft; a return to review then checks the draft is still live. */
  draftId?: string;
}

/** Keyed (HMAC, customer-ref's auditSubjectId): a Redis key listing never reveals the sender phone. */
function reviewKey(owner: PortalOwner): string {
  return `psend:${auditSubjectId(owner.partnerId, normalizePhone(owner.phone))}`;
}

/** Store the customer's in-progress send (replacing any other); returns the new review id. */
export async function saveSendReview(redis: RedisLike, owner: PortalOwner, value: SendFormValue): Promise<string> {
  const id = randomBytes(16).toString('hex');
  const rec: PortalSendReview = { ...value, id };
  await redis.set(reviewKey(owner), JSON.stringify(rec), { ex: PORTAL_SEND_REVIEW_TTL_S });
  return id;
}

function parseReview(raw: unknown): PortalSendReview | null {
  if (typeof raw !== 'string') return null;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const { id, amountSource, sourceCurrency, destinationCountry, fundingMethod, recipient, draftId } = v;
  if (typeof id !== 'string' || !REVIEW_ID_RE.test(id)) return null;
  if (!num(amountSource) || amountSource <= 0) return null;
  if (typeof sourceCurrency !== 'string' || !/^[A-Z]{3}$/.test(sourceCurrency)) return null;
  if (typeof destinationCountry !== 'string' || !isSupportedDestination(destinationCountry)) return null;
  if (!isPortalFunding(fundingMethod)) return null;
  const r = recipient as Record<string, unknown> | null;
  let choice: SendRecipientChoice;
  if (r && r.kind === 'saved' && isRid(r.rid)) choice = { kind: 'saved', rid: r.rid };
  else if (r && r.kind === 'new' && typeof r.name === 'string' && typeof r.phone === 'string' && isValidPhone(r.phone)) {
    choice = { kind: 'new', name: r.name, phone: r.phone };
  } else return null;
  const out: PortalSendReview = {
    id,
    amountSource,
    sourceCurrency: sourceCurrency as CurrencyCode,
    destinationCountry,
    fundingMethod,
    recipient: choice,
  };
  if (typeof draftId === 'string' && DRAFT_ID_RE.test(draftId)) out.draftId = draftId;
  return out;
}

/** The customer's in-progress send, or null (none, expired, malformed). Bound to (partner, phone). */
export async function loadSendReview(redis: RedisLike, owner: PortalOwner): Promise<PortalSendReview | null> {
  return parseReview(await redis.get(reviewKey(owner)));
}

/** Record the draft Continue made, only when the slot still holds review `id`. */
export async function markReviewDrafted(redis: RedisLike, owner: PortalOwner, id: string, draftId: string): Promise<void> {
  const cur = await loadSendReview(redis, owner);
  if (!cur || cur.id !== id || !DRAFT_ID_RE.test(draftId)) return;
  await redis.set(reviewKey(owner), JSON.stringify({ ...cur, draftId }), { ex: PORTAL_SEND_REVIEW_TTL_S });
}

/** The last 4 digits of a phone for display ("•••• 3210"); the full number is never rendered. */
export const maskPhone = (phone: string) => `•••• ${normalizePhone(phone).slice(-4)}`;

// ── Fixed customer copy for every refusal (never a seam `message`, which is written for the model) ──

export interface SendCopy {
  error: MessageKey;
  vars?: Record<string, string>;
  /** 'verify' → the card linking /portal/profile#verify; 'contact' → contact the partner, no retry. */
  kyc?: 'verify' | 'contact';
}

const contactPartner = (brand: string): SendCopy => ({ error: 'portal.send.contact_partner', vars: { brand }, kyc: 'contact' });
const verifyCard: SendCopy = { error: 'portal.send.kycBody', kyc: 'verify' };

/**
 * M2-14 (#413 L1): does the verify card lead anywhere? Two dead ends, exactly: a DELEGATED partner
 * (the partner verifies; Profile shows the provider copy) and a GRANDFATHERED customer (Profile shows
 * them as verified, with no start control). A customer in review keeps the card: Profile says
 * "In review" and they only have to wait. (Rejected is routed to contact before this.)
 */
export function canVerifyInProfile(
  partner: Partner | null | undefined,
  customer: Pick<Customer, 'kycStatus'> | null | undefined,
): boolean {
  if (resolveKycMode(partner).mode === 'delegated') return false;
  return customer?.kycStatus !== 'grandfathered';
}

/** A 'verify' card that would be a dead end becomes the contact-the-partner card. */
export function routeKycCopy(copy: SendCopy, canVerify: boolean, brand: string): SendCopy {
  return copy.kyc === 'verify' && !canVerify ? contactPartner(brand) : copy;
}

/**
 * The bot's verify-before-send gate as PURE reads (kyc-gate.ts), run before any seam call so a gated
 * customer never reaches startVerificationForTurn. A rejected customer is told to contact the partner
 * and is never offered a retry (owner decision 2026-09-28); so is anyone whose Profile could not start
 * verification (M2-14, #413 L1).
 */
export function portalKycGate(
  partner: Partner | null | undefined,
  customer: Pick<Customer, 'kycStatus'> | null | undefined,
  brand: string,
): SendCopy | null {
  if (!sendGateActive(partner) || isSendVerified(customer)) return null;
  if (customer?.kycStatus === 'rejected') return contactPartner(brand);
  return routeKycCopy(verifyCard, canVerifyInProfile(partner, customer), brand);
}

/** The cap copy per reason; the limits are USD-equivalent (the cap basis), shown through formatMoney. */
export function capCopy(
  reason: string | undefined,
  fig: { todayRemainingUsd: number; perTransferCapUsd: number },
  brand: string,
): SendCopy {
  switch (reason) {
    case 'over_daily_cap':
      return { error: 'portal.send.cap_daily', vars: { remaining: formatMoney(fig.todayRemainingUsd, 'USD') } };
    case 'over_per_transfer_cap':
      return { error: 'portal.send.cap_per_transfer', vars: { max: formatMoney(fig.perTransferCapUsd, 'USD') } };
    case 'verification_rejected':
      return contactPartner(brand);
    case 'verification_required_after_window':
      return { error: 'portal.send.cap_verify', kyc: 'verify' };
    default:
      return { error: 'portal.send.cannot_complete' };
  }
}

/** Every non-draft arm of prepareSendDraft → fixed copy. `blocked` is neutral (no oracle). */
export function prepareResultCopy(r: Exclude<PrepareSendResult, { kind: 'draft' }>, brand: string): SendCopy {
  switch (r.kind) {
    case 'invalid_phone':
      return { error: 'portal.send.phone_invalid' };
    case 'bad_funding':
      return { error: 'portal.send.funding_invalid' };
    case 'missing_destination':
      return { error: 'portal.send.destination_invalid' };
    case 'invalid_request':
      return { error: 'portal.send.amount_not_allowed' };
    case 'fx_unavailable':
      return { error: 'portal.send.fx_unavailable' };
    case 'kyc_required':
      return verifyCard;
    case 'sender_name_required':
      return { error: 'portal.send.name_needed' };
    case 'cap':
      return capCopy(r.evaluation.reason, {
        todayRemainingUsd: r.evaluation.todayRemainingCents / 100,
        perTransferCapUsd: r.evaluation.perTransferCapCents / 100,
      }, brand);
    case 'bill_refused':
    case 'blocked':
      return { error: 'portal.send.cannot_complete' };
  }
}

/** check_send_limit → the refusal to show before any draft (cap, then EDD), or null to go on. */
export function limitsCopy(l: PortalSendLimits, brand: string): SendCopy | null {
  if (l.kind === 'kyc_required') return verifyCard;
  if (l.kind === 'unavailable') return { error: 'portal.send.fx_unavailable' };
  if (!l.withinCap) return capCopy(l.reason, l, brand);
  if (l.eddRequired) return { error: 'portal.send.edd_whatsapp' };
  return null;
}

// ── Audit ─────────────────────────────────────────────────────────────────────

export type SendAuditEvent =
  | { action: 'customer.send.draft'; meta: { draftId: string; via: 'send' | 'send_again' } }
  | { action: 'customer.sender_name.set'; meta: Record<string, never> };

/**
 * One audit row for a portal send step: actor `system:customer-portal`, subject = the keyed customer
 * subject (never the phone). Meta is an allow-list: a draft id and the path, nothing else (never a
 * name, phone or amount). Throws on a guard refusal or a DB failure.
 */
export async function recordSendAudit(db: DbOrTx, owner: PortalOwner, e: SendAuditEvent): Promise<void> {
  for (const [k, v] of Object.entries(e.meta as Record<string, unknown>)) {
    const ok =
      (e.action === 'customer.send.draft' && k === 'draftId' && typeof v === 'string' && DRAFT_ID_RE.test(v)) ||
      (e.action === 'customer.send.draft' && k === 'via' && (v === 'send' || v === 'send_again'));
    if (!ok) throw new Error('portal send audit: meta not allowed');
  }
  await createAuditRepo(db).record({
    partnerId: owner.partnerId,
    actor: PORTAL_AUTH_ACTOR,
    actorType: 'system',
    action: e.action,
    subjectId: auditSubjectId(owner.partnerId, normalizePhone(owner.phone)),
    meta: e.meta,
  });
}

/** Whether `id` looks like a draft id (the replay value and the audit carry only this shape). */
export const isDraftId = (v: unknown): v is string => typeof v === 'string' && DRAFT_ID_RE.test(v);

/**
 * Review round (M1): once Continue made a draft, the review never offers Continue again (a second
 * click after paying would send the money twice). Back on the review: 'live' = the customer's own
 * draft still exists with a fresh rate (the page links to that same payment page); 'gone' = consumed
 * (paid), expired, not this customer's, or its rate is older than the 1-hour FX limit (the page says
 * it was already sent: check Transfers, or start a new transfer on purpose). No draft yet → null.
 */
export async function reviewDraftState(
  draftStore: Pick<DraftStore, 'getDraft'>,
  owner: PortalOwner,
  review: Pick<PortalSendReview, 'draftId'>,
  now: number = Date.now(),
): Promise<'live' | 'gone' | null> {
  if (!review.draftId) return null;
  let d: Awaited<ReturnType<DraftStore['getDraft']>> = null;
  try {
    d = await draftStore.getDraft(review.draftId);
  } catch {
    d = null;
  }
  const mine = d && d.partnerId === owner.partnerId && normalizePhone(d.senderPhone) === normalizePhone(owner.phone);
  if (!d || !mine) return 'gone';
  const at = d.quote?.fxFetchedAt;
  if (typeof at === 'number' && now - at > FX_MAX_AGE_MS) return 'gone';
  return 'live';
}

/**
 * One draft per review, atomically (review round: two tabs on the same review with different request
 * keys). SET NX on `psend-drafted:<review id>`; the loser answers "already sent". A refused or failed
 * attempt releases it, so a corrected retry is not stuck. The review id is random and server-minted.
 */
export async function claimReviewDraft(redis: RedisLike, reviewId: string): Promise<boolean> {
  if (!REVIEW_ID_RE.test(reviewId)) return false;
  return (await redis.set(`psend-drafted:${reviewId}`, '1', { nx: true, ex: PORTAL_SEND_REVIEW_TTL_S })) !== null;
}

export async function releaseReviewDraft(redis: RedisLike, reviewId: string): Promise<void> {
  if (REVIEW_ID_RE.test(reviewId)) await redis.del(`psend-drafted:${reviewId}`);
}
