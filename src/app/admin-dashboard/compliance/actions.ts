'use server';

import { revalidatePath } from 'next/cache';
import { requireScope } from '@/lib/auth';
import { boundStaffNote } from '@/lib/send-limits';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { getDb } from '@/db/client';

/**
 * Program-Fix 43 (compliance-09, partial): close an AML review item.
 *
 * Server actions are PUBLIC POST endpoints, so this self-gates in order:
 *   1. requireScope — a signed-in, non-support staff member (support is
 *      bounced to tickets); partner staff are pinned to their tenant;
 *   2. the alert id is parsed strictly (a positive safe integer) and the
 *      disposition is allow-listed;
 *   3. the alert is loaded with audit.getById PINNED to the staff member's
 *      tenant, and must be an `aml.alert` row. A missing id, another tenant's
 *      alert and a non-alert audit row are the SAME 'Alert not found'
 *      (404-never-403, and no review can be attached to arbitrary rows);
 *   4. one `aml.reviewed` row under the ALERT's tenant, subject = the alert's
 *      transfer, meta {alertId, disposition, note}. A second review of an
 *      already-reviewed alert writes nothing. Two staff reviewing at the same
 *      instant can both write — benign: the alert is closed either way and
 *      both decisions are audited.
 *
 * Nothing here touches the transfer: an AML alert is a review item, never a
 * hold (owner decision), and it never reaches the customer or the partner API.
 */

const DISPOSITIONS = ['no_action', 'escalated'] as const;
type Disposition = (typeof DISPOSITIONS)[number];

function parseAlertId(raw: FormDataEntryValue | null): number | null {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!/^[1-9]\d{0,14}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

export async function reviewAmlAlertAction(formData: FormData): Promise<void> {
  const { staff, scope } = await requireScope();
  const alertId = parseAlertId(formData.get('alertId'));
  if (alertId === null) throw new Error('Alert not found');
  const disposition = String(formData.get('disposition') ?? '') as Disposition;
  if (!DISPOSITIONS.includes(disposition)) throw new Error('Invalid disposition');
  const note = boundStaffNote(formData.get('note'));

  const db = getDb();
  const audit = createAuditRepo(db);
  const alert = await audit.getById(scope.kind === 'partner' ? scope.partnerId : null, alertId);
  if (!alert || alert.action !== 'aml.alert' || !alert.subjectId) throw new Error('Alert not found');

  const history = await audit.listBySubject(
    alert.partnerId,
    alert.subjectId,
    new Date(alert.at),
    new Date(Date.now() + 60_000),
  );
  const alreadyReviewed = history.some(
    (r) => r.action === 'aml.reviewed' && Number(r.meta.alertId) === alertId,
  );
  if (!alreadyReviewed) {
    await audit.record({
      partnerId: alert.partnerId ?? undefined,
      actor: staff.username,
      actorType: 'staff',
      action: 'aml.reviewed',
      subjectId: alert.subjectId,
      meta: { alertId, disposition, note },
    });
  }
  revalidatePath('/admin-dashboard/compliance');
}
