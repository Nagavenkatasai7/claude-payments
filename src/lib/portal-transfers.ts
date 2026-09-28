import { getDb, type DbOrTx } from '@/db/client';
import { createTransferRepo, PORTAL_QUERY_MAX, type PortalStatusGroup } from '@/db/repos/transfer-repo';
import type { MessageKey } from './i18n';
import type { PartnerId, PayoutMethod, RefundStatus, Transfer, TransferStatus } from './types';

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

// ── The timeline (pure) ────────────────────────────────────────────────────────────────────────

export type TimelineState = 'done' | 'current' | 'upcoming' | 'stopped';
export interface TimelineStep {
  key: MessageKey;
  state: TimelineState;
  /** Only `created` (createdAt) and `refunded` (refundedAt) ever carry a time: none is invented. */
  at?: string;
}

/**
 * The customer-facing steps of a transfer: the forward-only status machine plus the refund overlay.
 * A held (in_review) or blocked transfer shows ONE neutral "under review" step: never a sanctions
 * or compliance detail.
 */
export function transferTimeline(t: Pick<Transfer, 'status' | 'createdAt' | 'paidAt' | 'refundStatus' | 'refundedAt'>): TimelineStep[] {
  const created: TimelineStep = { key: 'portal.timeline.created', state: 'done', ...(t.createdAt ? { at: t.createdAt } : {}) };
  const steps: TimelineStep[] = [created];
  switch (t.status) {
    case 'awaiting_payment':
      steps.push({ key: 'portal.timeline.paid', state: 'current' }, { key: 'portal.timeline.delivered', state: 'upcoming' });
      break;
    case 'paid':
      steps.push({ key: 'portal.timeline.paid', state: 'done' }, { key: 'portal.timeline.delivered', state: 'current' });
      break;
    case 'delivered':
      steps.push({ key: 'portal.timeline.paid', state: 'done' }, { key: 'portal.timeline.delivered', state: 'done' });
      break;
    case 'in_review':
      steps.push(
        { key: 'portal.timeline.paid', state: 'done' },
        { key: 'portal.timeline.under_review', state: 'stopped' },
        { key: 'portal.timeline.delivered', state: 'upcoming' },
      );
      break;
    case 'cancelled':
      if (t.paidAt) steps.push({ key: 'portal.timeline.paid', state: 'done' });
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
