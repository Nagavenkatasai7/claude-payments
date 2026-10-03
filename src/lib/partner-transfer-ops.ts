import type { MessageKey } from '@/lib/i18n';
import { CANCEL_REFUSAL, decideStaffCancel } from './dashboard-cancel-policy';
import { PARTNER_ADMIN, PARTNER_OPS, type PartnerCtx } from './partner-access';
import { hasPermission } from './permissions';
import { isHeld } from './partner-transfers';
import type { PartnerId, Transfer } from './types';

// partner-transfer-ops (lost-features restore p1): the PURE rules behind the /partner transfer
// actions (cancel, assign, resend, issue refund, reveal) and the list / detail labels. No I/O. The
// page offers a control from these; every server action re-runs the same rule, so hiding a button
// is never the guard.

// ── Labels ──────────────────────────────────────────────────────────────────

/** The compliance column as a closed label. Never a reason, a screening hit or a PEP flag (D6). */
export function complianceViewKey(t: Pick<Transfer, 'status' | 'complianceStatus'>): MessageKey {
  if (t.status === 'blocked' || t.complianceStatus === 'blocked') return 'partner.transfers.compliance.blocked';
  if (isHeld(t)) return 'partner.transfers.compliance.held';
  if (t.complianceStatus === 'flagged') return 'partner.transfers.compliance.reviewed';
  return 'partner.transfers.compliance.clear';
}

/**
 * Which rail pays the transfer out, by class only. Another partner is never named: the settling
 * partner of a best-rate route is a different tenant.
 */
export function settlementRouteKey(t: Pick<Transfer, 'environment' | 'settlementPartnerId'>, ownerId: PartnerId): MessageKey {
  if ((t.environment ?? 'live') === 'test') return 'partner.transfers.settledVia.sandbox';
  if (t.settlementPartnerId && t.settlementPartnerId !== ownerId) return 'partner.transfers.settledVia.network';
  return 'partner.transfers.settledVia.own';
}

export type AssigneeView = { kind: 'none' } | { kind: 'tenant'; username: string } | { kind: 'smartremit' };

/** The assignee as a tenant sees it: its own staff by username, anyone else as SmartRemit. */
export function assigneeView(assignedTo: string | null | undefined, tenant: ReadonlySet<string>): AssigneeView {
  if (!assignedTo) return { kind: 'none' };
  return tenant.has(assignedTo) ? { kind: 'tenant', username: assignedTo } : { kind: 'smartremit' };
}

// ── Reveal ──────────────────────────────────────────────────────────────────

/**
 * The fields the transfer page may reveal. On a transfer, `full_name` and `phone` are the SENDER's
 * (the customer row's legal name, the transfer's phone); the recipient's carry their prefix. The
 * class of each comes from partner-reveal-policy (identity, or destination for the payout account).
 */
export const REVEALABLE_TRANSFER_FIELDS = Object.freeze([
  'full_name',
  'phone',
  'recipient_name',
  'recipient_phone',
  'payout_destination',
] as const);
export type RevealableTransferField = (typeof REVEALABLE_TRANSFER_FIELDS)[number];

export function isRevealableTransferField(f: unknown): f is RevealableTransferField {
  return typeof f === 'string' && (REVEALABLE_TRANSFER_FIELDS as readonly string[]).includes(f);
}

// ── Cancel ──────────────────────────────────────────────────────────────────

/** The policy's English refusal as translated /partner copy. Unknown text reads as "it changed". */
export function cancelRefusalKey(reason: string): MessageKey {
  switch (reason) {
    case CANCEL_REFUSAL.paid:
    case CANCEL_REFUSAL.paidPartnerPulled:
      return 'partner.transferOps.cancel.refused.paid';
    case CANCEL_REFUSAL.inReview:
      return 'partner.transferOps.cancel.refused.inReview';
    case CANCEL_REFUSAL.chargedAwaiting:
      return 'partner.transferOps.cancel.refused.charged';
    case CANCEL_REFUSAL.blocked:
      return 'partner.transferOps.cancel.refused.blocked';
    default:
      return 'partner.transferOps.cancel.refused.changed';
  }
}

// ── Resend ──────────────────────────────────────────────────────────────────

const PAYLINK_BUCKET_MS = 10 * 60_000;

/** The outbox dedupe key: one pay-link resend per transfer per 10-minute bucket. */
export function paylinkDedupeKey(id: string, nowMs: number): string {
  return `paylink:${id}:${Math.floor(nowMs / PAYLINK_BUCKET_MS)}`;
}

export type ResendEligibility = 'ok' | 'wrongStatus' | 'sandbox' | 'charged';

/**
 * A pay link is resent only for a live, unpaid transfer with no money in flight: a charged row (or
 * one with a bound debit) is being settled by the funding sweep, and a sandbox row is never payable.
 */
export function resendEligibility(t: Pick<Transfer, 'status' | 'environment' | 'fundingRef' | 'fundingIntentRef'>): ResendEligibility {
  if ((t.environment ?? 'live') === 'test') return 'sandbox';
  if (t.status !== 'awaiting_payment') return 'wrongStatus';
  if (t.fundingRef != null || t.fundingIntentRef != null) return 'charged';
  return 'ok';
}

// ── Issue refund ────────────────────────────────────────────────────────────

export type IssueRefundEligibility = 'ok' | 'routed' | 'sandbox' | 'wrongStatus' | 'notCharged' | 'debitNotSettled' | 'already';

/**
 * May the OWNER partner issue a refund on this transfer? The core (dashboard-ops.issueRefund)
 * re-checks the money rules inside its transaction; this adds the /partner-only refusals:
 *  - routed: another partner's rail pays it out (settlementPartnerId set and not the owner). A refund
 *    there is a cross-tenant money effect, so SmartRemit handles it. Refused in EVERY status (BL-2);
 *  - sandbox: a test transfer moved no money.
 * The core's money rules are mirrored here so the page hides the button too.
 */
export function issueRefundEligibility(
  t: Pick<Transfer, 'status' | 'environment' | 'fundingRef' | 'fundingState' | 'refundStatus' | 'settlementPartnerId'>,
  ownerId: PartnerId,
): IssueRefundEligibility {
  if (t.settlementPartnerId && t.settlementPartnerId !== ownerId) return 'routed';
  if ((t.environment ?? 'live') === 'test') return 'sandbox';
  if (t.status !== 'paid' && t.status !== 'delivered') return 'wrongStatus';
  if (!t.fundingRef) return 'notCharged';
  if (t.fundingState && t.fundingState !== 'succeeded') return 'debitNotSettled';
  if ((t.refundStatus ?? 'none') !== 'none') return 'already';
  return 'ok';
}

// ── The page's controls ─────────────────────────────────────────────────────

export interface TransferOps {
  cancel: boolean;
  assign: boolean;
  resend: boolean;
  refund: boolean;
}

/**
 * Which controls the detail page offers this viewer. Admin always; agent only with the per-staff
 * flag (hasPermission, which is false for every finance record); support and finance never.
 * Issue refund is admin only.
 */
export function transferOpsFor(t: Transfer, ctx: Pick<PartnerCtx, 'role' | 'staff' | 'partnerId'>): TransferOps {
  const ops = PARTNER_OPS.roles.includes(ctx.role);
  return {
    cancel: ops && hasPermission(ctx.staff, 'canCancel') && decideStaffCancel(t).kind === 'void',
    assign: ops && hasPermission(ctx.staff, 'canAssign'),
    resend: ops && hasPermission(ctx.staff, 'canResend') && resendEligibility(t) === 'ok',
    refund: PARTNER_ADMIN.roles.includes(ctx.role) && issueRefundEligibility(t, ctx.partnerId) === 'ok',
  };
}
