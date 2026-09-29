'use server';

import { revalidatePath } from 'next/cache';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { PARTNER_ADMIN } from '@/lib/partner-access';
import { getDb } from '@/db/client';
import { getStore } from '@/lib/store';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { getPartnerStore } from '@/lib/partner-store';
import { isPartnerReleasableHold } from '@/lib/compliance-config';
import { loadSenderScreening } from '@/lib/sender-screening';
import { canReleaseHeld, releaseTransfer } from '@/lib/dashboard-ops';
import { scopeOf } from '@/lib/staff-scope';
import { requireStaffReason, STAFF_REASON_MIN } from '@/lib/send-limits';
import { isReasonValid } from '@/lib/ui/confirm-reason';
import { isPartnerNoteShaped, isTransferId } from '@/lib/partner-transfers';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import type { ActionResult } from '../../../action-result';

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

/**
 * Release one of THIS tenant's held transfers from /partner (UI redesign M3-10). A MONEY action:
 * SPEC §3.3 + D7, KYC may be delegated, sanctions may not.
 *
 * Refused unless ALL hold: a PARTNER_ADMIN session; the transfer is resolved INSIDE the session
 * tenant (missing and foreign are the same result, 404-never-403); a typed reason of at least
 * STAFF_REASON_MIN characters (the ConfirmDialog minimum) with no phone/account-length number
 * (the reason lands in append-only audit_events.meta); the owning partner's KYC is DELEGATED; and
 * every hold reason is in PARTNER_RELEASABLE_REASONS (isPartnerReleasableHold: any screening /
 * sanctions or AML reason, an unknown or empty list, a blocked row ⇒ refused), re-checked by the
 * legacy canReleaseHeld rule as defence in depth. M3-10 follow-up: the transfer SENDER's customer
 * row (read inside the session tenant) must exist and carry no PEP / watchlist hit; a missing row
 * or a failed lookup is refused (fail closed). Known residuals: (1) the flags are read before the
 * guarded claim and the claim does not re-check them, so a flag raised by the Persona webhook in
 * that window is not seen (the same read-then-claim shape as the kycMode check); (2) a sandbox mint
 * writes no customer row (partner-api-service.ts, live only), so a sandbox hold is never
 * partner-releasable.
 *
 * The money movement is NOT forked: releaseTransfer (dashboard-ops.ts) → settlement.releaseHold
 * commits the guarded in_review → paid claim, the rail effect and the ONE `transfer.release` audit
 * row (actor, reason) in a single transaction. This action writes no row of its own. A concurrent
 * or repeated submit loses the guarded claim and is reported as not allowed.
 */
export async function releaseHoldAction(formData: FormData): Promise<ActionResult> {
  // A partner-site host never runs an apex action (the site-host guard rule for every action).
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ADMIN);
  const notFound: ActionResult = { ok: false, error: t('partner.common.notFound') };
  const notAllowed: ActionResult = { ok: false, error: t('partner.release.notAllowed') };

  // The target id comes from the form and is re-scoped to the SESSION tenant; any partnerId or
  // partner field in the body is never read.
  const id = String(formData.get('id') ?? '').trim();
  if (!isTransferId(id)) return notFound;
  const transfer = await createTransferRepo(getDb()).getOwnedTransfer(ctx.partnerId, id);
  if (!transfer || transfer.partnerId !== ctx.partnerId) return notFound;

  // The typed reason: the client ConfirmDialog rule (code points) AND the server rule (bounded,
  // collapsed, cut at 500), both at the same minimum, before any write.
  const rawReason = formData.get('reason');
  let reason: string;
  try {
    if (!isReasonValid(rawReason, STAFF_REASON_MIN)) throw new Error('short');
    reason = requireStaffReason(rawReason);
  } catch {
    return { ok: false, error: t('partner.release.reasonTooShort') };
  }
  if (!isPartnerNoteShaped(reason)) return { ok: false, error: t('partner.release.reasonHasNumber') };

  // The guard. One generic refusal for screening, AML, 'ours', blocked, not held and unknown.
  const owner = await getPartnerStore().getPartner(ctx.partnerId);
  const sender = await loadSenderScreening(getDb(), ctx.partnerId, transfer.phone);
  if (!isPartnerReleasableHold(transfer, owner, sender) || !canReleaseHeld(scopeOf(ctx.staff), owner, transfer, sender)) {
    return notAllowed;
  }

  try {
    await releaseTransfer(getStore(), getDb(), transfer.id, { actor: ctx.username, reason });
  } catch (err) {
    // Lost the guarded claim (a double submit or a concurrent release/reject): nothing moved.
    if (err instanceof Error && err.message.startsWith('Cannot release')) return notAllowed;
    // The error NAME only: a failed query's message carries its bound params.
    logWarn('partner.release', errName(err), { transferId: transfer.id });
    return { ok: false, error: t('partner.common.failed') };
  }
  revalidatePath('/partner/transfers');
  revalidatePath(`/partner/transfers/${transfer.id}`);
  return { ok: true };
}
