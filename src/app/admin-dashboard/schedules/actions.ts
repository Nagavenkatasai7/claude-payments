'use server';

import { revalidatePath } from 'next/cache';
import { requireStaff } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { scopeOf, canSee } from '@/lib/staff-scope';
import { getScheduleStore } from '@/lib/schedule-store';
import { decideScheduleAction, SCHEDULE_REFUSAL, type ScheduleAction } from '@/lib/schedule-control';
import { createScheduleRepo } from '@/db/repos/schedule-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { getDb } from '@/db/client';
import type { Schedule, Staff } from '@/lib/types';

/**
 * Staff kill switch on recurring schedules (Program-Fix 36 / schedules-02):
 * pause (active → paused), resume (paused → active), cancel (active | paused →
 * cancelled; terminal).
 *
 * Server actions are PUBLIC POST endpoints, so each one self-gates in order:
 *   1. requireStaff + canCancel (admins always pass; support has no money
 *      permissions, so it is refused here without special-casing the role);
 *   2. load the schedule by the FORM id — the only trusted body field — and
 *      check partner scope; a miss and an out-of-scope row are the SAME generic
 *      'Schedule not found' (404-never-403, no tenant disclosure);
 *   3. decideScheduleAction: the one transition table (pure);
 *   4. ONE transaction: the CONDITIONAL single-column status write (`WHERE id
 *      AND partner_id AND status IN (from)`, partnerId from the LOADED row) and
 *      the audit row. A lost race writes nothing and says so; a failed audit
 *      insert rolls the status write back (the bar fix 16b set).
 * The audit meta names states and the optional reason only — never the payout
 * destination or the customer's phone.
 */

const REASON_MAX = 200;

async function requireCanCancel(): Promise<Staff> {
  const staff = await requireStaff();
  if (!hasPermission(staff, 'canCancel')) {
    throw new Error('You do not have permission to perform this action.');
  }
  return staff;
}

async function getScopedSchedule(staff: Staff, id: string): Promise<Schedule> {
  if (!id) throw new Error('Schedule not found');
  const schedule = await getScheduleStore().getSchedule(id);
  if (!schedule || !canSee(scopeOf(staff), schedule.partnerId)) {
    throw new Error('Schedule not found');
  }
  return schedule;
}

function readReason(formData: FormData): string | undefined {
  const reason = String(formData.get('reason') ?? '').trim().slice(0, REASON_MAX);
  return reason.length > 0 ? reason : undefined;
}

async function transition(action: ScheduleAction, formData: FormData): Promise<void> {
  const staff = await requireCanCancel();
  const id = String(formData.get('id') ?? '');
  const schedule = await getScopedSchedule(staff, id);
  const decision = decideScheduleAction(schedule.status, action);
  if (!decision.ok) throw new Error(decision.reason);
  const reason = readReason(formData);

  await getDb().transaction(async (tx) => {
    // tx-bound repos ONLY inside the transaction: the guarded write and its
    // audit row commit together or not at all.
    const updated = await createScheduleRepo(tx).setStatusIf(
      schedule.id,
      schedule.partnerId,
      decision.from,
      decision.to,
    );
    if (!updated) throw new Error(SCHEDULE_REFUSAL.changed);
    await createAuditRepo(tx).record({
      partnerId: schedule.partnerId,
      actor: staff.username,
      actorType: 'staff',
      action: `schedule.${action}`,
      subjectId: schedule.id,
      meta: reason ? { from: schedule.status, to: decision.to, reason } : { from: schedule.status, to: decision.to },
    });
  });
  // 'layout' revalidates every page under /admin-dashboard (the overview's
  // due-soon card reads schedules too), not just this list.
  revalidatePath('/admin-dashboard', 'layout');
}

export async function pauseScheduleAction(formData: FormData): Promise<void> {
  await transition('pause', formData);
}

export async function resumeScheduleAction(formData: FormData): Promise<void> {
  await transition('resume', formData);
}

export async function cancelScheduleAction(formData: FormData): Promise<void> {
  await transition('cancel', formData);
}
