'use server';

import { revalidatePath } from 'next/cache';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { PARTNER_ADMIN } from '@/lib/partner-access';
import { getDb } from '@/db/client';
import { getStore } from '@/lib/store';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { getPartnerStore } from '@/lib/partner-store';
import { loadSenderScreening } from '@/lib/sender-screening';
import { canReleaseHeld, rejectTransfer } from '@/lib/dashboard-ops';
import { partnerMayRejectHold } from '@/lib/partner-reviews';
import { scopeOf } from '@/lib/staff-scope';
import { requireStaffReason, STAFF_REASON_MIN } from '@/lib/send-limits';
import { isReasonValid } from '@/lib/ui/confirm-reason';
import { isPartnerNoteShaped, isTransferId } from '@/lib/partner-transfers';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import { gatePartnerStepUp } from '@/lib/partner-step-up-gate';
import type { StepUpRequired } from '@/lib/staff-step-up-result';
import type { ActionResult } from '../../../action-result';

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

/**
 * Reject (and, when charged, refund) one of THIS tenant's held transfers from /partner (merge plan
 * 2c, owner D4). A MONEY action, gated exactly like releaseHoldAction:
 *  - a PARTNER_ADMIN session (refuseOnSiteHost and the gate run outside any try);
 *  - the id is resolved INSIDE the session tenant (missing and foreign are the same not-found);
 *  - a typed reason of at least STAFF_REASON_MIN characters with no phone/account-length number
 *    (it lands in append-only audit meta);
 *  - D4: only a hold the partner may release (partnerMayRejectHold, the isPartnerReleasableHold
 *    rule: delegated KYC, KYC-class reasons only, a present and unflagged sender), re-checked by
 *    canReleaseHeld. Sanctions, screening and AML holds stay PLATFORM-only. One generic refusal;
 *  - a fresh 15-minute step-up (owner D2, target 'transfer.reject'), checked after the checks
 *    above and before any write; a stale session gets step_up_required.
 *
 * The money path is NOT forked: rejectTransfer (dashboard-ops.ts) commits the guarded
 * in_review → cancelled claim, the ONE `transfer.reject` audit row (actor, reason, actorScope
 * 'partner') and, for a charged row, refund pending + the deduped funding.refund outbox row, all in
 * one transaction. The partner claim re-checks the tenant, a non-blocked row and the sender flags
 * in the same UPDATE, so a flag raised after the read below still refuses. A concurrent or
 * repeated submit loses the claim and is reported as not allowed. Known residual (as release):
 * the kycMode check is read-then-claim.
 */
export async function rejectHoldAction(formData: FormData): Promise<ActionResult | StepUpRequired> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ADMIN);
  const notFound: ActionResult = { ok: false, error: t('partner.common.notFound') };
  const notAllowed: ActionResult = { ok: false, error: t('partner.reject.notAllowed') };

  // The id comes from the form and is re-scoped to the SESSION tenant; any partner field is ignored.
  const id = String(formData.get('id') ?? '').trim();
  if (!isTransferId(id)) return notFound;
  const transfer = await createTransferRepo(getDb()).getOwnedTransfer(ctx.partnerId, id);
  if (!transfer || transfer.partnerId !== ctx.partnerId) return notFound;

  const rawReason = formData.get('reason');
  let reason: string;
  try {
    if (!isReasonValid(rawReason, STAFF_REASON_MIN)) throw new Error('short');
    reason = requireStaffReason(rawReason);
  } catch {
    return { ok: false, error: t('partner.reject.reasonTooShort') };
  }
  if (!isPartnerNoteShaped(reason)) return { ok: false, error: t('partner.reject.reasonHasNumber') };

  const owner = await getPartnerStore().getPartner(ctx.partnerId);
  const sender = await loadSenderScreening(getDb(), ctx.partnerId, transfer.phone);
  if (!partnerMayRejectHold(transfer, owner, sender) || !canReleaseHeld(scopeOf(ctx.staff), owner, transfer, sender)) {
    return notAllowed;
  }

  // D2: a reject can start a refund, so it needs a fresh step-up (after the input and rule checks,
  // before any write), as refund approve / retry do.
  const stepUp = await gatePartnerStepUp(ctx, formData, 'transfer.reject');
  if (stepUp) return stepUp;

  try {
    await rejectTransfer(getStore(), getDb(), transfer.id, { actor: ctx.username, reason }, { partnerId: ctx.partnerId });
  } catch (err) {
    // Lost the guarded claim (a double submit, a concurrent release/reject, a new sender flag).
    if (err instanceof Error && err.message.startsWith('Cannot reject')) return notAllowed;
    logWarn('partner.reject', errName(err), { transferId: transfer.id });
    return { ok: false, error: t('partner.common.failed') };
  }
  revalidatePath('/partner/transfers');
  revalidatePath(`/partner/transfers/${transfer.id}`);
  revalidatePath('/partner/reviews');
  return { ok: true };
}
