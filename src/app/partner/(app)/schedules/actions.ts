'use server';

import { revalidatePath } from 'next/cache';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { PARTNER_ADMIN } from '@/lib/partner-access';
import { scopeOf } from '@/lib/staff-scope';
import { getDb } from '@/db/client';
import { getPartnerSchedule } from '@/db/repos/partner-schedule-reads';
import { parseScheduleOp, scheduleControls } from '@/lib/partner-schedules';
import { applyStaffScheduleTransition } from '@/lib/staff-schedule-ops';
import { requireStaffReason, STAFF_REASON_MIN } from '@/lib/send-limits';
import { isReasonValid } from '@/lib/ui/confirm-reason';
import { isPartnerNoteShaped } from '@/lib/partner-transfers';
import { t, type MessageKey } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import { PARTNER_ROUTES } from '../../routes';
import type { ActionResult } from '../../action-result';

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');
const refused = (key: MessageKey, vars?: Record<string, string | number>): ActionResult => ({ ok: false, error: t(key, vars) });

/**
 * Pause, resume or cancel one of THIS tenant's recurring transfers (merge plan 2a). Viewing is a
 * money read; every change is PARTNER_ADMIN (owner decision D1: partner agents never control
 * schedules, whatever legacy permission they hold).
 *
 * Refused unless ALL hold: an admin session (site-host guard and gate outside any try); a closed-set
 * op; the schedule resolved INSIDE the session tenant (missing, foreign and malformed are the same
 * not-found; any partnerId / partner form field is never read); a typed reason of at least
 * STAFF_REASON_MIN characters with no phone/account-length number (it lands in append-only audit
 * meta); and the transition table allows the op from the current state. The write is the shared
 * staff writer (applyStaffScheduleTransition): the conditional status update and the audit row
 * (actorScope from the session) commit in one transaction; a lost race writes nothing.
 * No money moves here: a schedule only mints through the scheduled run, with its own checks.
 */
export async function scheduleOpAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ADMIN);

  const op = parseScheduleOp(formData.get('op'));
  if (!op) return refused('partner.schedules.notAllowed');
  const schedule = await getPartnerSchedule(getDb(), ctx.partnerId, formData.get('id'));
  if (!schedule) return refused('partner.schedules.notFound');

  // The typed reason: the ConfirmDialog rule (code points) AND the server rule, same minimum.
  const rawReason = formData.get('reason');
  let reason: string;
  try {
    if (!isReasonValid(rawReason, STAFF_REASON_MIN)) throw new Error('short');
    reason = requireStaffReason(rawReason);
  } catch {
    return refused('partner.schedules.reasonTooShort', { min: STAFF_REASON_MIN });
  }
  if (!isPartnerNoteShaped(reason)) return refused('partner.schedules.reasonHasNumber');

  if (!scheduleControls(schedule.status, ctx.role)[op]) return refused('partner.schedules.notAllowed');

  let r;
  try {
    r = await applyStaffScheduleTransition(
      getDb(),
      { id: schedule.id, partnerId: ctx.partnerId, status: schedule.status },
      op,
      { username: ctx.username, reason, actorScope: scopeOf(ctx.staff).kind },
    );
  } catch (err) {
    // The error NAME only: a failed query's message carries its bound params.
    logWarn('partner.schedules', errName(err), { scheduleId: schedule.id });
    return refused('partner.common.failed');
  }
  if (!r.ok) return refused(r.code === 'changed' ? 'partner.schedules.changed' : 'partner.schedules.notAllowed');
  revalidatePath(PARTNER_ROUTES.schedules.href);
  return { ok: true };
}
