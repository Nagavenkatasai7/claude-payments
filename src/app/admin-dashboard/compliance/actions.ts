'use server';

import { revalidatePath } from 'next/cache';
import { requirePlatformAdmin, requireScope } from '@/lib/auth';
import { createPartnerStore } from '@/lib/partner-store';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import type { CountryCode } from '@/lib/types';
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

/**
 * Program-Fix 43 PR B: the per-partner × corridor AML HOLD switch
 * (partners.corridor_compliance[<country>].amlHolds). OFF by default; when ON,
 * a cleared transfer on that partner's real `http` rail that hits R1/R2 in the
 * mint is flagged for review instead of settling (transfer-create.ts).
 *
 * Server actions are PUBLIC POST endpoints, so this self-gates in order:
 *   1. requirePlatformAdmin — platform admins only (never partner staff: a
 *      partner cannot switch its own compliance holds off);
 *   2. `on` is exactly 'on' | 'off'; the partner id is bounded;
 *   3. the default (demo) tenant is REFUSED — demo transfers are never held
 *      (mintLocked's amlHoldGate ignores it structurally too);
 *   4. the partner must exist ('Partner not found') and the corridor must be
 *      one it serves as a SOURCE (never IN);
 *   5. the column-targeted, row-locked write (updateCorridorCompliance) and
 *      the `aml.holds_set` audit row commit in ONE transaction. OFF removes
 *      the key (and an emptied corridor entry), so the stored jsonb returns to
 *      what it was before the switch was first turned on.
 */
export async function setAmlHoldsAction(formData: FormData): Promise<void> {
  const staff = await requirePlatformAdmin();
  const onRaw = String(formData.get('on') ?? '');
  if (onRaw !== 'on' && onRaw !== 'off') throw new Error('Invalid setting');
  const on = onRaw === 'on';
  const partnerId = String(formData.get('partnerId') ?? '').trim();
  if (!partnerId || partnerId.length > 100) throw new Error('Partner not found');
  if (partnerId === DEFAULT_PARTNER_ID) throw new Error('The default (demo) tenant is never held');
  const countryRaw = String(formData.get('country') ?? '');
  if (!/^[A-Z]{2}$/.test(countryRaw) || countryRaw === 'IN') throw new Error('Invalid corridor');
  const country = countryRaw as CountryCode;

  await getDb().transaction(async (tx) => {
    const partners = createPartnerStore(tx);
    const partner = await partners.getPartner(partnerId);
    if (!partner) throw new Error('Partner not found');
    if (!(partner.countries ?? []).includes(country)) throw new Error('Invalid corridor');
    const { found, previous } = await partners.updateCorridorCompliance(partnerId, (prev) => {
      const entry = { ...(prev[country] ?? {}) };
      if (on) entry.amlHolds = true;
      else delete entry.amlHolds;
      const next = { ...prev };
      if (Object.keys(entry).length === 0) delete next[country];
      else next[country] = entry;
      return next;
    });
    if (!found) throw new Error('Partner not found');
    await createAuditRepo(tx).record({
      partnerId,
      actor: staff.username,
      actorType: 'staff',
      action: 'aml.holds_set',
      subjectId: partnerId,
      meta: { country, from: previous[country]?.amlHolds === true, to: on },
    });
  });
  revalidatePath('/admin-dashboard/compliance');
}
