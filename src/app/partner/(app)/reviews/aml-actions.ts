'use server';

import { revalidatePath } from 'next/cache';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { PARTNER_ADMIN } from '@/lib/partner-access';
import { getDb } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { isAmlDisposition, parseAmlAlertId } from '@/lib/partner-reviews';
import { boundStaffNote } from '@/lib/send-limits';
import { isPartnerNoteShaped } from '@/lib/partner-transfers';
import { scopeOf } from '@/lib/staff-scope';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import type { ActionResult } from '../../action-result';

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

/**
 * Close one of THIS tenant's open AML review items from /partner (merge plan 2c, owner D5: admin
 * only). Ported from the legacy reviewAmlAlertAction (admin-dashboard/compliance/actions.ts):
 *  1. the partner-site host guard, then the PARTNER_ADMIN gate (outside any try);
 *  2. the alert id is parsed strictly and the disposition is allow-listed (shared parsers);
 *     an optional note is bounded and must carry no phone/account-length number (audit meta is
 *     append-only);
 *  3. the alert is loaded with audit.getById PINNED to the SESSION tenant and must be an
 *     `aml.alert` row with a subject: a missing id, another tenant's alert and a non-alert row are
 *     the SAME not-found result;
 *  4. ONE `aml.reviewed` row under the session tenant (subject = the alert's transfer, meta
 *     {alertId, disposition, note, actorScope}). An already-reviewed alert writes nothing and
 *     reports ok (it is closed either way). Two simultaneous reviews can both write, as in the
 *     legacy action: benign, both decisions are audited.
 * Nothing here touches the transfer: an AML alert is a review item, never a hold.
 */
export async function reviewAmlAlertAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ADMIN);
  const notFound: ActionResult = { ok: false, error: t('partner.reviews.aml.notFound') };

  const alertId = parseAmlAlertId(formData.get('alertId'));
  if (alertId === null) return notFound;
  const audit = createAuditRepo(getDb());
  const alert = await audit.getById(ctx.partnerId, alertId);
  if (!alert || alert.partnerId !== ctx.partnerId || alert.action !== 'aml.alert' || !alert.subjectId) return notFound;

  const disposition = formData.get('disposition');
  if (!isAmlDisposition(disposition)) return { ok: false, error: t('partner.reviews.aml.invalidDisposition') };
  const note = boundStaffNote(formData.get('note'));
  if (note !== null && !isPartnerNoteShaped(note)) return { ok: false, error: t('partner.reviews.aml.noteHasNumber') };

  try {
    const history = await audit.listBySubject(ctx.partnerId, alert.subjectId, new Date(alert.at), new Date(Date.now() + 60_000));
    const alreadyReviewed = history.some((r) => r.action === 'aml.reviewed' && Number(r.meta.alertId) === alertId);
    if (!alreadyReviewed) {
      await audit.record({
        partnerId: ctx.partnerId,
        actor: ctx.username,
        actorType: 'staff',
        action: 'aml.reviewed',
        subjectId: alert.subjectId,
        meta: { alertId, disposition, note, actorScope: scopeOf(ctx.staff).kind },
      });
    }
  } catch (err) {
    logWarn('partner.aml.review', errName(err), { partnerId: ctx.partnerId });
    return { ok: false, error: t('partner.common.failed') };
  }
  revalidatePath('/partner/reviews');
  return { ok: true };
}
