'use server';

import { revalidatePath } from 'next/cache';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { PARTNER_OPS } from '@/lib/partner-access';
import { hasPermission } from '@/lib/permissions';
import { getDb } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { getAuthStore } from '@/lib/auth-store';
import { assignTransfer } from '@/lib/dashboard-ops';
import { isTenantTransferAssignee } from '@/lib/transfer-assignable';
import { parseAssigneeField } from '@/lib/partner-tickets';
import { boundStaffNote } from '@/lib/send-limits';
import { isPartnerNoteShaped, isTransferId } from '@/lib/partner-transfers';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import type { ActionResult } from '../../../action-result';

// The /partner transfer actions that move no money (lost-features restore p1): assign, resend the
// payment link, cancel an unpaid transfer. The shared /partner action shape: the site-host guard and
// the role gate first (outside any try), then the per-staff permission (hasPermission: admin always,
// an agent only with the flag), the id from the form resolved INSIDE the session tenant (missing and
// foreign are the same not-found), the input validated before any write, and the write + its audit
// row in ONE transaction through the shared core. Errors are fixed translated copy; logs carry the
// error name only.

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');
const notFound = (): ActionResult => ({ ok: false, error: t('partner.common.notFound') });
const noPermission = (): ActionResult => ({ ok: false, error: t('partner.transferOps.noPermission') });

async function ownedTransfer(partnerId: string, formData: FormData) {
  const id = String(formData.get('id') ?? '').trim();
  if (!isTransferId(id)) return null;
  const transfer = await createTransferRepo(getDb()).getOwnedTransfer(partnerId, id);
  return transfer && transfer.partnerId === partnerId ? transfer : null;
}

function revalidate(id: string): void {
  revalidatePath('/partner/transfers');
  revalidatePath(`/partner/transfers/${id}`);
}

/**
 * Assign (or unassign, with an empty assignee) one of THIS tenant's transfers. The assignee must be
 * an active admin or agent of this tenant (isTenantTransferAssignee: never a SmartRemit or test
 * account). The optional note is bounded, refused when it carries a phone-length number, and lives
 * only in the `transfer.assign` audit row. assignTransfer never writes adminNote.
 */
export async function assignTransferAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_OPS);
  if (!hasPermission(ctx.staff, 'canAssign')) return noPermission();

  const transfer = await ownedTransfer(ctx.partnerId, formData);
  if (!transfer) return notFound();
  const invalid: ActionResult = { ok: false, error: t('partner.transferOps.assign.invalid') };
  const parsed = parseAssigneeField(formData.get('assignee'));
  if (!parsed.ok) return invalid;
  if (parsed.assignee !== null && !isTenantTransferAssignee(await getAuthStore().getStaff(parsed.assignee), ctx.partnerId)) return invalid;
  const note = boundStaffNote(formData.get('assignNote'));
  if (note && !isPartnerNoteShaped(note)) return { ok: false, error: t('partner.transferOps.assign.noteHasNumber') };

  try {
    await assignTransfer(getDb(), transfer.id, parsed.assignee, { actor: ctx.username, note, actorScope: 'partner' }, { partnerId: ctx.partnerId });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Cannot assign')) return { ok: false, error: t('partner.transferOps.assign.stale') };
    if (err instanceof Error && err.message === 'Transfer not found') return notFound();
    logWarn('partner.transfers.assign', errName(err), { transferId: transfer.id });
    return { ok: false, error: t('partner.common.failed') };
  }
  revalidate(transfer.id);
  return { ok: true };
}
