import { createHash, randomBytes } from 'node:crypto';
import { buildToolContext, type ToolContextDeps } from './tool-context';
import { executeTool, type ToolContext } from './tools';
import { getQuoteTyped, type PrepareSendInput, type QuoteTypedResult } from './send-seam';
import { getKycProvider } from './providers/kyc-provider';
import type { KycProvider } from './providers/kyc-provider';
import { getCustomerStore } from './customer-store';
import { getStore, type RedisLike } from './store';
import { env } from './env';
import { SEND_GATE_REASON } from './kyc-gate';
import { boundUntrustedText, NAME_MAX } from './untrusted-text';
import { isSupportedDestination, SUPPORTED_DESTINATIONS } from './destination-country';
import { isValidPhone, normalizePhone } from './phone';
import { isRid, validateRecipientName } from './portal-recipients';
import type { MessageKey } from './i18n';
import type { CountryCode, CurrencyCode, PartnerId, TurnContext } from './types';

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

export interface PortalOwner {
  partnerId: PartnerId;
  phone: string;
}

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
 * within [1, ceilingUsd] (the sender's quote ceiling); `to` a supported ISO2 corridor; `r` a
 * well-formed rid (the page resolves it inside the customer's own book, so another customer's,
 * another tenant's or a deleted recipient's rid is dropped there).
 */
export function parsePrefill(
  sp: Record<string, string | string[] | undefined>,
  opts: { ceilingUsd: number },
): { amount?: string; to?: CountryCode; rid?: string } {
  const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);
  const out: { amount?: string; to?: CountryCode; rid?: string } = {};
  const rawAmount = one(sp.amount);
  const amount = rawAmount !== undefined && /^\d{1,7}(\.\d{1,2})?$/.test(rawAmount) ? Number(rawAmount) : null;
  if (amount !== null && amount >= 1 && amount <= opts.ceilingUsd) out.amount = amount.toFixed(2);
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

function reviewKey(owner: PortalOwner): string {
  return `psend:${createHash('sha256').update(`${owner.partnerId}|${normalizePhone(owner.phone)}`).digest('hex')}`;
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
