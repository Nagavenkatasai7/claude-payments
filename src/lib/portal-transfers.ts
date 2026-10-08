import { getDb, type DbOrTx } from '@/db/client';
import { createTransferRepo, PORTAL_QUERY_MAX, type PortalStatusGroup } from '@/db/repos/transfer-repo';
import { t, type MessageKey } from './i18n';
import { formatMoney } from './ui/money';
import { transferStatusView } from './ui/transfer-status';
import { payoutMethodLabel } from './payout-format';
import { isPartnerPulled } from './funding-method';
import { rewardReceiptLine } from './rewards/engine';
import { usdToSource } from './rewards/customer';
import type { QuotedReward } from './rewards/types';
import type { EntityType, PartnerId, PayoutMethod, RefundStatus, Transfer, TransferStatus } from './types';

/**
 * portal-transfers — the customer portal's transfer reads (UI redesign M2-7, Task 7.1).
 *
 * Identity is (host partner, session phone): callers build the owner from the resolved portal
 * context (`portalOwner(ctx)`), never from a form field, query or route param. Every read is scoped
 * to BOTH in the WHERE, LIVE rows only, and MASKED (the default ledger read: `****last4`). A
 * transfer of another partner, of another phone or that does not exist is the same `null`
 * (404-never-403).
 */

export interface PortalOwner {
  partnerId: PartnerId;
  phone: string;
}

/** The owner of a resolved portal context: the HOST partner and the SESSION phone. */
export function portalOwner(ctx: { site: { partnerId: PartnerId }; session: { phone: string } }): PortalOwner {
  return { partnerId: ctx.site.partnerId, phone: ctx.session.phone };
}

export type { PortalStatusGroup };
export const PORTAL_STATUS_GROUP_VALUES: readonly PortalStatusGroup[] = ['in_progress', 'completed', 'cancelled', 'refunded'];

/** A status group from untrusted input, or undefined. */
export function parseStatusGroup(v: unknown): PortalStatusGroup | undefined {
  return typeof v === 'string' && (PORTAL_STATUS_GROUP_VALUES as readonly string[]).includes(v) ? (v as PortalStatusGroup) : undefined;
}

/** A search string from untrusted input: trimmed, capped, control characters dropped; undefined when empty. */
export function parseQuery(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const q = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, PORTAL_QUERY_MAX);
  return q || undefined;
}

/** The transfer id shape the portal accepts (new 22-char ids and the legacy 8-char ones). */
export const PORTAL_TRANSFER_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

/** A masked row for the list and Home (no decrypted field, ever). */
export interface PortalTransferRow {
  id: string;
  createdAt: string;
  recipientName: string;
  /** The ledger's default masked read (`****last4`). */
  maskedDestination: string;
  payoutMethod: PayoutMethod;
  amount: number;
  currency: string;
  amountDest: number;
  destCurrency: string;
  status: TransferStatus;
  refundStatus: RefundStatus;
}

export function toPortalRow(t: Transfer): PortalTransferRow {
  return {
    id: t.id,
    createdAt: t.createdAt,
    recipientName: t.recipientName,
    maskedDestination: t.payoutDestination,
    payoutMethod: t.payoutMethod,
    amount: t.amountSource ?? t.amountUsd,
    currency: t.sourceCurrency ?? 'USD',
    amountDest: t.amountInr,
    destCurrency: t.destinationCurrency ?? 'INR',
    status: t.status,
    refundStatus: t.refundStatus ?? 'none',
  };
}

export interface PortalListParams {
  limit: number;
  cursor?: string;
  status?: PortalStatusGroup;
  q?: string;
}

/** The customer's own transfers, newest first, keyset-paginated. */
export async function listPortalTransfers(
  owner: PortalOwner,
  params: PortalListParams,
  db: DbOrTx = getDb(),
): Promise<{ items: PortalTransferRow[]; nextCursor?: string }> {
  const limit = Math.min(Math.max(1, Math.floor(params.limit)), 50);
  const page = await createTransferRepo(db).listByPhoneFiltered(owner.partnerId, owner.phone, {
    limit,
    cursor: typeof params.cursor === 'string' && params.cursor.length <= 128 ? params.cursor : undefined,
    status: parseStatusGroup(params.status),
    q: parseQuery(params.q),
  });
  return { items: page.items.map(toPortalRow), nextCursor: page.nextCursor };
}

/**
 * One transfer of THIS customer on THIS partner (masked), or null: the tenant-scoped
 * getOwnedTransfer AND the session phone AND a live row. "Missing" and "someone else's" are the
 * same null.
 */
export async function getPortalTransfer(owner: PortalOwner, id: unknown, db: DbOrTx = getDb()): Promise<Transfer | null> {
  if (typeof id !== 'string' || !PORTAL_TRANSFER_ID_RE.test(id)) return null;
  const t = await createTransferRepo(db).getOwnedTransfer(owner.partnerId, id);
  if (!t || t.phone !== owner.phone || t.partnerId !== owner.partnerId) return null;
  if ((t.environment ?? 'live') !== 'live') return null;
  return t;
}

// ── Business (B2B) parties ─────────────────────────────────────────────────────────────────────

/**
 * What a business transfer shows the customer: the two business names, the entity badges and the
 * funding line. Names and enums only: never the payout destination or the recipient's legal name.
 */
export interface PortalB2bParties {
  senderEntity: EntityType;
  recipientEntity: EntityType;
  senderBusinessName?: string;
  recipientBusinessName?: string;
  funding: 'business_account' | 'card_or_bank';
}

/** A shown business name: a masked or failed-decrypt value (`****last4`) or a blank one is dropped. */
const shownName = (v: string | undefined): string | undefined => {
  const s = v?.trim();
  return s && !s.startsWith('****') ? s : undefined;
};

/** The parties of a b2b transfer (null for a consumer one). Pure. */
export function b2bParties(
  t: Pick<Transfer, 'transferType' | 'senderEntityType' | 'recipientEntityType' | 'fundingMethod'>,
  names: { senderBusinessName?: string; recipientBusinessName?: string } | null,
): PortalB2bParties | null {
  if (t.transferType !== 'b2b') return null;
  const senderBusinessName = shownName(names?.senderBusinessName);
  const recipientBusinessName = shownName(names?.recipientBusinessName);
  return {
    senderEntity: t.senderEntityType ?? 'individual',
    recipientEntity: t.recipientEntityType ?? 'individual',
    ...(senderBusinessName ? { senderBusinessName } : {}),
    ...(recipientBusinessName ? { recipientBusinessName } : {}),
    funding: isPartnerPulled(t.fundingMethod) ? 'business_account' : 'card_or_bank',
  };
}

/**
 * The business parties of a transfer the caller already loaded with getPortalTransfer. A consumer
 * transfer is null with no second read. For b2b, ONE explicit decrypted read that repeats the same
 * ownership checks (host partner, session phone, live row); the decrypted row never leaves this
 * function (it also holds the full destination), only the names and enums do.
 */
export async function getPortalB2bParties(owner: PortalOwner, transfer: Transfer, db: DbOrTx = getDb()): Promise<PortalB2bParties | null> {
  if (transfer.transferType !== 'b2b') return null;
  const full = await createTransferRepo(db).getOwnedTransfer(owner.partnerId, transfer.id, { decrypt: true });
  if (!full || full.phone !== owner.phone || full.partnerId !== owner.partnerId) return null;
  if ((full.environment ?? 'live') !== 'live') return null;
  return b2bParties(full, { senderBusinessName: full.senderBusinessName, recipientBusinessName: full.recipientBusinessName });
}

// ── The timeline (pure) ────────────────────────────────────────────────────────────────────────

export type TimelineState = 'done' | 'current' | 'upcoming' | 'stopped';
export interface TimelineStep {
  key: MessageKey;
  state: TimelineState;
  /**
   * A time only on a DONE step whose row time is a valid date: created (createdAt), paid (paidAt),
   * delivered (deliveredAt), refunded (refundedAt). None is invented, and a current or upcoming
   * step never carries one.
   */
  at?: string;
}

const validIso = (s: string | undefined): s is string => typeof s === 'string' && Number.isFinite(Date.parse(s));

/**
 * The customer-facing steps of a transfer: the forward-only status machine plus the refund overlay.
 * A held (in_review) or blocked transfer shows ONE neutral "under review" step: never a sanctions
 * or compliance detail.
 */
export function transferTimeline(
  t: Pick<Transfer, 'status' | 'createdAt' | 'paidAt' | 'deliveredAt' | 'refundStatus' | 'refundedAt'>,
): TimelineStep[] {
  const created: TimelineStep = { key: 'portal.timeline.created', state: 'done', ...(t.createdAt ? { at: t.createdAt } : {}) };
  const paidDone: TimelineStep = { key: 'portal.timeline.paid', state: 'done', ...(validIso(t.paidAt) ? { at: t.paidAt } : {}) };
  const steps: TimelineStep[] = [created];
  switch (t.status) {
    case 'awaiting_payment':
      steps.push({ key: 'portal.timeline.paid', state: 'current' }, { key: 'portal.timeline.delivered', state: 'upcoming' });
      break;
    case 'paid':
      steps.push(paidDone, { key: 'portal.timeline.delivered', state: 'current' });
      break;
    case 'delivered':
      steps.push(paidDone, { key: 'portal.timeline.delivered', state: 'done', ...(validIso(t.deliveredAt) ? { at: t.deliveredAt } : {}) });
      break;
    case 'in_review':
      steps.push(paidDone, { key: 'portal.timeline.under_review', state: 'stopped' }, { key: 'portal.timeline.delivered', state: 'upcoming' });
      break;
    case 'cancelled':
      if (t.paidAt) steps.push(paidDone);
      steps.push({ key: 'portal.timeline.cancelled', state: 'stopped' });
      break;
    default:
      // blocked (never charged) and anything unknown: the neutral review step only.
      steps.push({ key: 'portal.timeline.under_review', state: 'stopped' });
  }
  const r = t.refundStatus ?? 'none';
  if (r === 'requested') steps.push({ key: 'portal.timeline.refund_requested', state: 'current' });
  else if (r === 'pending' || r === 'failed') steps.push({ key: 'portal.timeline.refund_in_progress', state: 'current' });
  else if (r === 'completed') steps.push({ key: 'portal.timeline.refunded', state: 'done', ...(t.refundedAt ? { at: t.refundedAt } : {}) });
  return steps;
}

// ── The receipt (pure) ─────────────────────────────────────────────────────────────────────────

/** What a receipt shows. Built from the MASKED read only: the destination is `****last4`. */
export interface ReceiptView {
  id: string;
  createdAt: string;
  recipientName: string;
  maskedDestination: string;
  payoutMethod: PayoutMethod;
  amount: number;
  fee: number;
  total: number;
  currency: string;
  amountDest: number;
  destCurrency: string;
  fxRate: number;
  statusKey: MessageKey;
  /** B3 rewards v1: the reward the transfer carried, e.g. "Reward: first transfer free (saved $1.99)." */
  rewardLine?: string;
}

export function receiptView(t: Transfer, reward?: Pick<QuotedReward, 'kind' | 'discountUsd' | 'detail'> | null): ReceiptView {
  return {
    id: t.id,
    createdAt: t.createdAt,
    recipientName: t.recipientName,
    maskedDestination: t.payoutDestination,
    payoutMethod: t.payoutMethod,
    amount: t.amountSource ?? t.amountUsd,
    fee: t.feeSource ?? t.feeUsd,
    total: t.totalChargeSource ?? t.totalChargeUsd,
    currency: t.sourceCurrency ?? 'USD',
    amountDest: t.amountInr,
    destCurrency: t.destinationCurrency ?? 'INR',
    fxRate: t.fxRate,
    statusKey: transferStatusView(t).labelKey,
    ...(reward ? { rewardLine: rewardReceiptLine(reward, (usd) => formatMoney(usdToSource(usd, t.sourceCurrency ?? 'USD', t.amountSource, t.amountUsd), t.sourceCurrency ?? 'USD')) } : {}),
  };
}

const RECEIPT_DATE = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

/** The plain-text receipt (the email body). Masked destination only; no HTML. */
export function renderReceiptText(v: ReceiptView, brand: string): string {
  const created = Number.isFinite(Date.parse(v.createdAt)) ? `${RECEIPT_DATE.format(new Date(v.createdAt))} UTC` : '—';
  return [
    t('portal.receipt.textHead', { brand }),
    '',
    `${t('portal.receipt.transferId')}: ${v.id}`,
    `${t('portal.receipt.date')}: ${created}`,
    `${t('portal.receipt.status')}: ${t(v.statusKey)}`,
    `${t('portal.receipt.recipient')}: ${v.recipientName}`,
    `${t('portal.receipt.destination')}: ${payoutMethodLabel(v.payoutMethod)} ${v.maskedDestination}`,
    `${t('portal.receipt.youSend')}: ${formatMoney(v.amount, v.currency)}`,
    `${t('portal.receipt.fee')}: ${formatMoney(v.fee, v.currency)}`,
    ...(v.rewardLine ? [v.rewardLine] : []),
    `${t('portal.receipt.total')}: ${formatMoney(v.total, v.currency)}`,
    `${t('portal.receipt.rate')}: 1 ${v.currency} = ${v.fxRate} ${v.destCurrency}`,
    `${t('portal.receipt.theyGet')}: ${formatMoney(v.amountDest, v.destCurrency)}`,
    '',
    t('portal.receipt.textFoot', { brand }),
  ].join('\n');
}

// ── The list cursor in a URL ───────────────────────────────────────────────────────────────────

/** The keyset cursor (`createdAt|id`) as an opaque base64url token for `?cursor=`. */
export function encodePortalCursor(cursor: string): string {
  return Buffer.from(cursor, 'utf8').toString('base64url');
}

/** The cursor behind a `?cursor=` token, or undefined for anything malformed or oversized. */
export function decodePortalCursor(token: unknown): string | undefined {
  if (typeof token !== 'string' || token.length === 0 || token.length > 200 || !/^[A-Za-z0-9_-]+$/.test(token)) return undefined;
  const c = Buffer.from(token, 'base64url').toString('utf8');
  return /^[0-9T:.Z+-]{10,40}\|[A-Za-z0-9_-]{1,64}$/.test(c) ? c : undefined;
}
