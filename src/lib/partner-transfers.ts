import { createHash } from 'node:crypto';
import { t, type MessageKey } from '@/lib/i18n';
import {
  LIST_UNAVAILABLE_REASON,
  POSSIBLE_MATCH_REASON,
  RECIPIENT_WATCHLIST_REASON,
  SENDER_IDENTITY_MISSING_REASON,
  SENDER_WATCHLIST_REASON,
} from '@/lib/compliance-config';
import { AML_HOLD_REASON } from '@/lib/aml-hold';
import type { FundingMethod, Transfer, TransferStatus } from '@/lib/types';

// partner-transfers (UI redesign M3-5): the PURE helpers behind /partner/transfers. No I/O. The
// pages and the hold-note action read the ledger through tenant-scoped repos with the SESSION
// partnerId; everything here only parses request input into closed sets and shapes masked views.

/** Runtime list of the TransferStatus union (pinned against types.ts in the test). */
export const TRANSFER_STATUSES = Object.freeze([
  'awaiting_payment',
  'paid',
  'in_review',
  'delivered',
  'cancelled',
  'blocked',
] as const satisfies readonly TransferStatus[]);

export const PARTNER_TRANSFERS_PAGE_SIZE = 25;
export const PARTNER_TRANSFER_QUERY_MAX = 64;
/** A transfer id / reference: letters, digits, _ and -. Never a name or a phone. */
const ID_RE = /^[A-Za-z0-9_-]+$/;
/** A transfer id always carries a letter; an all-digit string is phone-shaped and is refused. */
const HAS_LETTER = /[A-Za-z]/;

export type TransferEnv = 'live' | 'test';
export interface TransferFilters {
  status?: TransferStatus;
  environment: TransferEnv;
  q?: string;
  cursor?: string;
}

type SearchParams = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

/** Parse the list page's query into closed sets. Any other key (partnerId, partner, …) is ignored. */
export function parseTransferFilters(sp: SearchParams): TransferFilters {
  const statusRaw = one(sp.status);
  const status = (TRANSFER_STATUSES as readonly string[]).includes(statusRaw ?? '') ? (statusRaw as TransferStatus) : undefined;
  const environment: TransferEnv = one(sp.environment) === 'test' ? 'test' : 'live';
  const qRaw = (one(sp.q) ?? '').trim().slice(0, PARTNER_TRANSFER_QUERY_MAX);
  const q = qRaw && ID_RE.test(qRaw) && HAS_LETTER.test(qRaw) ? qRaw : undefined;
  const cursor = decodeTransferCursor(one(sp.cursor));
  return { ...(status ? { status } : {}), environment, ...(q ? { q } : {}), ...(cursor ? { cursor } : {}) };
}

const CURSOR_MIN_MS = Date.UTC(2000, 0, 1);
const CURSOR_MAX_MS = Date.UTC(2200, 0, 1);

/** The repo's keyset cursor (`createdAt|id`) as an opaque URL token. */
export function encodeTransferCursor(cursor: string): string {
  return Buffer.from(cursor, 'utf8').toString('base64url');
}

/** The cursor behind a token, or undefined for anything malformed or oversized. */
export function decodeTransferCursor(token: unknown): string | undefined {
  if (typeof token !== 'string' || token.length === 0 || token.length > 200 || !/^[A-Za-z0-9_-]+$/.test(token)) return undefined;
  const c = Buffer.from(token, 'base64url').toString('utf8');
  if (!/^[0-9T:.Z+-]{10,40}\|[A-Za-z0-9_-]{1,64}$/.test(c)) return undefined;
  // A plausible timestamp only (the database rejects extreme years).
  const at = Date.parse(c.slice(0, c.lastIndexOf('|')));
  return Number.isFinite(at) && at >= CURSOR_MIN_MS && at <= CURSOR_MAX_MS ? c : undefined;
}

/** A list URL carrying only the known filters (a static path; the tenant is never in it). */
export function transfersListHref(f: { status?: TransferStatus; environment: TransferEnv; cursor?: string }): string {
  const qs = new URLSearchParams();
  if (f.status) qs.set('status', f.status);
  if (f.environment === 'test') qs.set('environment', 'test');
  if (f.cursor) qs.set('cursor', encodeTransferCursor(f.cursor));
  const s = qs.toString();
  return s ? `/partner/transfers?${s}` : '/partner/transfers';
}

/** First word plus the initial of the last word ("Testname S."); a single word is 1 char + "…". */
export function maskRecipientName(name: string): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '—';
  if (words.length === 1) return `${Array.from(words[0])[0]}…`;
  return `${words[0]} ${Array.from(words[words.length - 1])[0]}.`;
}

/** A provider / rail reference shown as `****` + its last 4 characters. */
export function maskRef(ref: string | undefined | null): string | undefined {
  if (!ref) return undefined;
  const v = ref.trim();
  return v.length <= 4 ? '****' : `****${v.slice(-4)}`;
}

const FINISHED = new Set(['delivered', 'cancelled']);

/**
 * Held: under review or blocked, or a flagged transfer that has not been released yet. The
 * `flagged` compliance status outlives the hold (markPaidIfInReview never clears it), so a flagged
 * transfer counts as held only while it is still awaiting payment or in review.
 */
export function isHeld(tr: Pick<Transfer, 'status' | 'complianceStatus'>): boolean {
  if (tr.status === 'in_review' || tr.status === 'blocked') return true;
  if (tr.complianceStatus === 'flagged') return tr.status === 'awaiting_payment';
  if (tr.complianceStatus === 'blocked') return !FINISHED.has(tr.status);
  return false;
}

// Only KNOWN hold-reason constants render as text. Screening reasons collapse to one label (they
// are already generic and non-tipping-off); anything unknown gets one generic label, so a free-text
// reason can never put a name or a number on the page.
const REASON_KEYS: Record<string, MessageKey> = {
  [POSSIBLE_MATCH_REASON]: 'partner.transfers.reason.screening',
  [LIST_UNAVAILABLE_REASON]: 'partner.transfers.reason.screening',
  [RECIPIENT_WATCHLIST_REASON]: 'partner.transfers.reason.screening',
  [SENDER_WATCHLIST_REASON]: 'partner.transfers.reason.screening',
  [SENDER_IDENTITY_MISSING_REASON]: 'partner.transfers.reason.identity',
  'Large transfer amount.': 'partner.transfers.reason.large',
  'High transfer velocity.': 'partner.transfers.reason.velocity',
  [AML_HOLD_REASON]: 'partner.transfers.reason.additional',
  edd_required: 'partner.transfers.reason.edd',
};

export function holdReasonKeys(reasons: readonly string[]): MessageKey[] {
  const out: MessageKey[] = [];
  for (const r of reasons ?? []) {
    const k = Object.hasOwn(REASON_KEYS, r) ? REASON_KEYS[r] : 'partner.transfers.reason.other';
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

// ── Timeline ────────────────────────────────────────────────────────────────
// Merge plan 2c: 'transfer.reject' (a partner's or SmartRemit's reject) shows as one row, never its reason.
export const TIMELINE_AUDIT_ACTIONS = Object.freeze(['transfer.hold.note', 'transfer.release', 'transfer.reject'] as const);

export interface TimelineAuditRow {
  at: Date;
  action: string;
  actor: string;
  actorType?: string;
  meta: unknown;
}
export type TimelineKind = 'created' | 'paid' | 'note' | 'release' | 'reject' | 'delivered' | 'refunded';
export interface TimelineRow {
  at: string;
  kind: TimelineKind;
  label: MessageKey;
  by?: string;
  note?: string;
}

/** The actor as a tenant user sees it: their own staff by name; everyone else by kind only. */
export function maskActor(actor: string, actorType: string | undefined, tenant: ReadonlySet<string>): string {
  if (actorType === 'system') return t('partner.transfers.actor.system');
  if (actorType === 'api_key') return t('partner.transfers.actor.apiKey');
  if (tenant.has(actor)) return actor;
  return t('partner.transfers.actor.smartremit');
}

const validIso = (s: string | undefined): s is string => typeof s === 'string' && Number.isFinite(Date.parse(s));

export function transferTimeline(tr: Transfer, audit: readonly TimelineAuditRow[], tenant: ReadonlySet<string>): TimelineRow[] {
  const rows: TimelineRow[] = [];
  if (validIso(tr.createdAt)) rows.push({ at: tr.createdAt, kind: 'created', label: 'partner.transfers.timeline.created' });
  if (validIso(tr.paidAt)) rows.push({ at: tr.paidAt, kind: 'paid', label: 'partner.transfers.timeline.paid' });
  if (validIso(tr.deliveredAt)) rows.push({ at: tr.deliveredAt, kind: 'delivered', label: 'partner.transfers.timeline.delivered' });
  if (tr.refundStatus === 'completed' && validIso(tr.refundedAt)) {
    rows.push({ at: tr.refundedAt, kind: 'refunded', label: 'partner.transfers.timeline.refunded' });
  }
  for (const a of audit) {
    const at = a.at instanceof Date ? a.at : new Date(a.at);
    if (!Number.isFinite(at.getTime())) continue;
    const by = maskActor(a.actor, a.actorType, tenant);
    if (a.action === 'transfer.hold.note') {
      const m = a.meta as { note?: unknown; actorScope?: unknown } | null;
      // Text only from a note THIS tenant's staff wrote through the partner app; any other writer's
      // free text (a platform or compliance flow reusing the action name) is never shown.
      const own = m?.actorScope === 'partner' && a.actorType === 'staff' && tenant.has(a.actor);
      const raw = own ? m?.note : undefined;
      rows.push({ at: at.toISOString(), kind: 'note', label: 'partner.transfers.timeline.note', by, ...(typeof raw === 'string' ? { note: raw } : {}) });
    } else if (a.action === 'transfer.release') {
      rows.push({ at: at.toISOString(), kind: 'release', label: 'partner.transfers.timeline.release', by });
    } else if (a.action === 'transfer.reject') {
      rows.push({ at: at.toISOString(), kind: 'reject', label: 'partner.transfers.timeline.reject', by });
    }
  }
  return rows.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
}

// ── H5: funding + settlement instruction (existing columns only) ────────────
const FUNDING_METHODS: readonly FundingMethod[] = ['credit_card', 'debit_card', 'bank_transfer', 'ach_pull', 'bank_pull'];
const FUNDING_STATES = ['pending', 'succeeded', 'failed', 'returned'] as const;
const PROVIDER_NAMES: Record<string, string> = { stripe: 'Stripe' };

export interface FundingView {
  method: MessageKey;
  provider?: string;
  state?: MessageKey;
  ref?: string;
}

export function fundingView(tr: Pick<Transfer, 'fundingMethod' | 'fundingProvider' | 'fundingState' | 'fundingIntentRef' | 'fundingRef'>): FundingView {
  const method: MessageKey = FUNDING_METHODS.includes(tr.fundingMethod)
    ? (`partner.transfers.funding.method.${tr.fundingMethod}` as MessageKey)
    : 'partner.transfers.funding.method.other';
  const provider = tr.fundingProvider && Object.hasOwn(PROVIDER_NAMES, tr.fundingProvider) ? PROVIDER_NAMES[tr.fundingProvider] : undefined;
  const state = tr.fundingState && (FUNDING_STATES as readonly string[]).includes(tr.fundingState)
    ? (`partner.transfers.funding.state.${tr.fundingState}` as MessageKey)
    : undefined;
  const ref = maskRef(tr.fundingIntentRef ?? tr.fundingRef);
  return { method, ...(provider ? { provider } : {}), ...(state ? { state } : {}), ...(ref ? { ref } : {}) };
}

const EVENT_TYPES: Record<string, MessageKey> = {
  'payment_intent.succeeded': 'partner.transfers.funding.event.succeeded',
  'payment_intent.processing': 'partner.transfers.funding.event.processing',
  'payment_intent.payment_failed': 'partner.transfers.funding.event.failed',
  'payment_intent.canceled': 'partner.transfers.funding.event.canceled',
  'charge.dispute.created': 'partner.transfers.funding.event.dispute',
};
const EVENT_OUTCOMES = ['processing', 'funded', 'funded_not_settled', 'noop', 'mismatch', 'test_mode_ignored', 'failed', 'returned', 'inquiry'] as const;

export interface FundingEventInput {
  eventType: string;
  outcome: string;
  eventId: string;
  receivedAt: Date;
}
export interface FundingEventRow {
  at: string;
  type: MessageKey;
  outcome: MessageKey;
  ref?: string;
}

export function fundingEventView(e: FundingEventInput): FundingEventRow {
  const type = Object.hasOwn(EVENT_TYPES, e.eventType) ? EVENT_TYPES[e.eventType] : 'partner.transfers.funding.event.other';
  const outcome = (EVENT_OUTCOMES as readonly string[]).includes(e.outcome)
    ? (`partner.transfers.funding.outcome.${e.outcome}` as MessageKey)
    : 'partner.transfers.funding.outcome.other';
  const at = e.receivedAt instanceof Date ? e.receivedAt : new Date(e.receivedAt);
  const ref = maskRef(e.eventId);
  return { at: Number.isFinite(at.getTime()) ? at.toISOString() : '', type, outcome, ...(ref ? { ref } : {}) };
}

export interface RailRow {
  status: string;
  attempts: number;
  createdAt: Date;
}
export interface SettlementView {
  state: MessageKey;
  ref?: string;
  attempts?: number;
}

/**
 * The settlement instruction's status, from the transfer plus its rail outbox rows. An outbox row
 * marked done is NOT proof of a send (the worker marks skipped instructions done), so "accepted"
 * needs the rail's reference on the transfer; otherwise a done row is only "processed".
 */
export function settlementView(tr: Pick<Transfer, 'status' | 'environment' | 'paymentProviderRef'>, rows: readonly RailRow[]): SettlementView {
  const ref = maskRef(tr.paymentProviderRef);
  const withRef = (v: SettlementView): SettlementView => (ref ? { ...v, ref } : v);
  if ((tr.environment ?? 'live') === 'test') return { state: 'partner.transfers.settlement.sandbox' };
  if (tr.status === 'delivered') return withRef({ state: 'partner.transfers.settlement.settled' });
  // A rail that accepted and later failed leaves its reference and a done row behind while the
  // transfer is cancelled (refund pending): never show that as accepted.
  if (tr.status === 'cancelled') return { state: 'partner.transfers.settlement.notCompleted' };
  if (tr.status === 'blocked') return { state: 'partner.transfers.settlement.blocked' };
  // A mock rail stamps `mock-<id>` (settlement.ts): simulated, not a real rail's acceptance.
  const simulated = (tr.paymentProviderRef ?? '').startsWith('mock-');
  const latest = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (!latest) return withRef({ state: 'partner.transfers.settlement.notStarted' });
  switch (latest.status) {
    case 'pending':
      return withRef({ state: 'partner.transfers.settlement.queued' });
    case 'processing':
      return withRef({ state: 'partner.transfers.settlement.sending' });
    case 'failed':
      return withRef({ state: 'partner.transfers.settlement.retrying', attempts: latest.attempts });
    case 'dead':
      return withRef({ state: 'partner.transfers.settlement.attention', attempts: latest.attempts });
    case 'done':
      if (simulated) return { state: 'partner.transfers.settlement.simulated' };
      return withRef({ state: ref ? 'partner.transfers.settlement.accepted' : 'partner.transfers.settlement.processed' });
    default:
      return withRef({ state: 'partner.transfers.settlement.processed' });
  }
}

// ── Hold note input ─────────────────────────────────────────────────────────
/**
 * A hold note must not carry a phone- or account-length number (10+ digits in any script; up to 3
 * non-letter separators between digits are ignored). Best-effort, not a PII classifier. The note is stored in the audit trail and shown
 * to the tenant's staff, so it stays free of the identifiers the ledger keeps masked.
 */
export function isPartnerNoteShaped(note: string): boolean {
  const collapsed = note.replace(/(?<=\p{Nd})[^\p{L}\p{Nd}]{1,3}(?=\p{Nd})/gu, '');
  return !/\p{Nd}{10,}/u.test(collapsed);
}

/** A transfer id as the ledger mints it (letters, digits, _ and -), bounded. */
export function isTransferId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= PARTNER_TRANSFER_QUERY_MAX && ID_RE.test(id);
}

/** The hold-note form's server-minted request key (128-bit hex). */
export function isRequestKey(k: unknown): k is string {
  return typeof k === 'string' && /^[0-9a-f]{32}$/.test(k);
}

/**
 * The replay claim for one hold-note submit, bound to (tenant, user, transfer, request key) and
 * hashed so no identifier sits in a Redis key name.
 */
export function holdNoteClaimKey(partnerId: string, username: string, transferId: string, requestKey: string): string {
  const digest = createHash('sha256').update(`${partnerId}|${username}|${transferId}|${requestKey}`).digest('hex');
  return `pnote:${digest}`;
}
