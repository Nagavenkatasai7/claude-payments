'use server';

import { revalidatePath } from 'next/cache';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { PARTNER_ADMIN } from '@/lib/partner-access';
import { getDb } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { issueRefund } from '@/lib/dashboard-ops';
import { issueRefundEligibility, type IssueRefundEligibility } from '@/lib/partner-transfer-ops';
import { gatePartnerStepUp } from '@/lib/partner-step-up-gate';
import { requireStaffReason, STAFF_REASON_MIN } from '@/lib/send-limits';
import { isReasonValid } from '@/lib/ui/confirm-reason';
import { isPartnerNoteShaped, isTransferId } from '@/lib/partner-transfers';
import { t, type MessageKey } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import type { StepUpRequired } from '@/lib/staff-step-up-result';
import type { ActionResult } from '../../../action-result';

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');
const refused = (key: MessageKey): ActionResult => ({ ok: false, error: t(key) });

const ELIGIBILITY_COPY: Record<Exclude<IssueRefundEligibility, 'ok'>, MessageKey> = {
  routed: 'partner.transferOps.refund.routed',
  sandbox: 'partner.transferOps.refund.sandbox',
  wrongStatus: 'partner.transferOps.refund.wrongStatus',
  notCharged: 'partner.transferOps.refund.notCharged',
  already: 'partner.transferOps.refund.already',
};

/**
 * Issue a refund on one of THIS tenant's paid or delivered, charged transfers (lost-features
 * restore p1 A7). A MONEY action, PARTNER_ADMIN only, through the ONE refund core
 * (dashboard-ops.issueRefund with the tenant scope): never a second money path.
 *
 * Refused unless ALL hold, in this order: an admin session (site-host guard and gate outside any
 * try); the transfer resolved INSIDE the session tenant (missing, foreign and malformed are the same
 * not-found; a partner form field is never read); a typed reason of at least STAFF_REASON_MIN
 * characters with no phone- or account-length number (it lands in append-only audit meta); the
 * transfer is eligible (issueRefundEligibility: a transfer another partner pays out is refused in
 * every status); for a delivered transfer, the explicit clawback tick; and a fresh 'refund.issue'
 * step-up, checked after the input and BEFORE any write.
 *
 * The core re-reads the row inside its transaction (tenant in the WHERE), re-checks the routing
 * and the eligibility there, claims the refund status from 'none', and commits the flip, the
 * funding.refund effect and the ONE refund.issue audit row together. A double submit or a row that
 * moved in between loses the claim and is reported as not allowed.
 */
export async function issueRefundAction(formData: FormData): Promise<ActionResult | StepUpRequired> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ADMIN);
  const notFound = refused('partner.common.notFound');

  const id = String(formData.get('id') ?? '').trim();
  if (!isTransferId(id)) return notFound;
  const transfer = await createTransferRepo(getDb()).getOwnedTransfer(ctx.partnerId, id);
  if (!transfer || transfer.partnerId !== ctx.partnerId) return notFound;

  // The typed reason: the ConfirmDialog rule (code points) AND the server rule, same minimum.
  const rawReason = formData.get('reason');
  let reason: string;
  try {
    if (!isReasonValid(rawReason, STAFF_REASON_MIN)) throw new Error('short');
    reason = requireStaffReason(rawReason);
  } catch {
    return refused('partner.transferOps.refund.reasonTooShort');
  }
  if (!isPartnerNoteShaped(reason)) return refused('partner.transferOps.refund.reasonHasNumber');

  const eligibility = issueRefundEligibility(transfer, ctx.partnerId);
  if (eligibility !== 'ok') return refused(ELIGIBILITY_COPY[eligibility]);
  if (transfer.status === 'delivered' && formData.get('clawback') !== 'yes') return refused('partner.transferOps.refund.clawbackRequired');

  const stepUp = await gatePartnerStepUp(ctx, formData, 'refund.issue');
  if (stepUp) return stepUp;

  try {
    await issueRefund(getDb(), transfer.id, { actor: ctx.username, reason, actorScope: 'partner' }, { partnerId: ctx.partnerId });
  } catch (err) {
    // The in-transaction re-check or the guarded claim refused: nothing was written.
    if (err instanceof Error && err.message.startsWith('Cannot ')) return refused('partner.transferOps.refund.notAllowed');
    // The error NAME only: a failed query's message carries its bound params.
    logWarn('partner.transfers.refund', errName(err), { transferId: transfer.id });
    return refused('partner.common.failed');
  }
  revalidatePath('/partner/transfers');
  revalidatePath(`/partner/transfers/${transfer.id}`);
  revalidatePath('/partner/refunds');
  return { ok: true };
}
