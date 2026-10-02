'use server';

import { revalidatePath } from 'next/cache';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { PARTNER_ADMIN } from '@/lib/partner-access';
import { scopeOf } from '@/lib/staff-scope';
import { getDb } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { approveRefund, dismissRefund, retryRefund, type StaffAuditCtx } from '@/lib/dashboard-ops';
import { parseRefundOp, refundControls, refundStepUpTarget } from '@/lib/partner-refunds';
import { gatePartnerStepUp } from '@/lib/partner-step-up-gate';
import { requireStaffReason, STAFF_REASON_MIN } from '@/lib/send-limits';
import { isReasonValid } from '@/lib/ui/confirm-reason';
import { isPartnerNoteShaped, isTransferId } from '@/lib/partner-transfers';
import { t, type MessageKey } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import type { StepUpRequired } from '@/lib/staff-step-up-result';
import { PARTNER_ROUTES } from '../../routes';
import type { ActionResult } from '../../action-result';

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');
const refused = (key: MessageKey, vars?: Record<string, string | number>): ActionResult => ({ ok: false, error: t(key, vars) });

/**
 * Approve, dismiss or retry a refund on one of THIS tenant's transfers (merge plan 2b). A MONEY
 * action: approve and retry start a refund effect. Viewing is a money read; every decision is
 * PARTNER_ADMIN (owner decision D1), and approve / retry need a fresh 15-minute step-up (D2).
 *
 * Refused unless ALL hold: an admin session (site-host guard and gate outside any try); a closed-set
 * op; the transfer resolved INSIDE the session tenant (missing, foreign and malformed are the same
 * not-found; any partnerId / partner form field is never read); a typed reason of at least
 * STAFF_REASON_MIN characters with no phone/account-length number (it lands in append-only audit
 * meta); the refund is in the state the op needs; and, for approve / retry, the step-up (checked
 * after the input parse and BEFORE any write).
 *
 * The money movement is NOT forked: dashboard-ops approveRefund / dismissRefund / retryRefund
 * re-check the state inside their transaction (reloading the transfer inside the session tenant),
 * treat the guarded refund-status write as the claim, and commit the state change, the
 * funding.refund effect and the ONE audit row (actor, reason, actorScope) together. A double submit
 * or a concurrent decision loses the claim and is reported as not allowed.
 */
export async function refundOpAction(formData: FormData): Promise<ActionResult | StepUpRequired> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ADMIN);
  const notFound = refused('partner.refunds.notFound');
  const notAllowed = refused('partner.refunds.notAllowed');

  const op = parseRefundOp(formData.get('op'));
  if (!op) return notAllowed;
  const id = formData.get('id');
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
    return refused('partner.refunds.reasonTooShort', { min: STAFF_REASON_MIN });
  }
  if (!isPartnerNoteShaped(reason)) return refused('partner.refunds.reasonHasNumber');

  if (!refundControls(transfer.refundStatus, ctx.role)[op]) return notAllowed;

  const target = refundStepUpTarget(op);
  if (target) {
    const stepUp = await gatePartnerStepUp(ctx, formData, target);
    if (stepUp) return stepUp;
  }

  const audit: StaffAuditCtx = { actor: ctx.username, reason, actorScope: scopeOf(ctx.staff).kind };
  const scope = { partnerId: ctx.partnerId };
  try {
    if (op === 'approve') await approveRefund(getDb(), transfer.id, audit, scope);
    else if (op === 'dismiss') await dismissRefund(getDb(), transfer.id, audit, scope);
    else await retryRefund(getDb(), transfer.id, audit, scope);
  } catch (err) {
    // The state re-check or the guarded claim refused (a double submit or a concurrent decision):
    // nothing was written.
    if (err instanceof Error && err.message.startsWith('Cannot ')) return notAllowed;
    // The error NAME only: a failed query's message carries its bound params.
    logWarn('partner.refunds', errName(err), { transferId: transfer.id, op });
    return refused('partner.common.failed');
  }
  revalidatePath(PARTNER_ROUTES.refunds.href);
  revalidatePath(`/partner/transfers/${transfer.id}`);
  return { ok: true };
}
