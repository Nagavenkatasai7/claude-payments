import type { Db } from '@/db/client';
import { createScheduleRepo } from '@/db/repos/schedule-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { decideScheduleAction, SCHEDULE_REFUSAL, type ScheduleAction } from './schedule-control';
import type { PartnerId, ScheduleStatus } from './types';

/**
 * staff-schedule-ops — the ONE staff writer of a schedule status change (Program-Fix 36), shared by
 * the legacy /admin-dashboard schedule actions and /partner/schedules (merge plan 2a). The caller
 * has already gated the session and resolved the schedule inside the caller's scope; this function
 * then:
 *   1. decides with the one transition table (decideScheduleAction, pure);
 *   2. in ONE transaction, writes the CONDITIONAL single-column status update
 *      (`WHERE id AND partner_id AND status IN (from)`, the partner id from the LOADED row) and the
 *      audit row. A lost race writes nothing and says so; a failed audit insert throws and rolls the
 *      status write back (the fix-16b bar).
 * The audit meta names the states, the optional reason and (for a /partner call) the actor scope:
 * never the payout destination or the customer's phone.
 */

export interface StaffScheduleTarget {
  id: string;
  partnerId: PartnerId;
  status: ScheduleStatus;
}

export interface StaffScheduleActor {
  username: string;
  /** Already bounded by the caller; omitted from the meta when absent. */
  reason?: string;
  /** Recorded in the meta when given (the /partner actions derive it from the session). */
  actorScope?: 'platform' | 'partner';
}

export type StaffScheduleTransitionResult =
  | { ok: true; from: ScheduleStatus; to: ScheduleStatus }
  | { ok: false; code: 'refused' | 'changed'; reason: string };

export async function applyStaffScheduleTransition(
  db: Db,
  schedule: StaffScheduleTarget,
  action: ScheduleAction,
  actor: StaffScheduleActor,
): Promise<StaffScheduleTransitionResult> {
  const decision = decideScheduleAction(schedule.status, action);
  if (!decision.ok) return { ok: false, code: 'refused', reason: decision.reason };
  const written = await db.transaction(async (tx): Promise<boolean> => {
    // tx-bound repos ONLY inside the transaction: the guarded write and its audit row commit
    // together or not at all.
    const updated = await createScheduleRepo(tx).setStatusIf(schedule.id, schedule.partnerId, decision.from, decision.to);
    if (!updated) return false; // lost race: nothing was written
    await createAuditRepo(tx).record({
      partnerId: schedule.partnerId,
      actor: actor.username,
      actorType: 'staff',
      action: `schedule.${action}`,
      subjectId: schedule.id,
      meta: {
        from: schedule.status,
        to: decision.to,
        ...(actor.reason ? { reason: actor.reason } : {}),
        ...(actor.actorScope ? { actorScope: actor.actorScope } : {}),
      },
    });
    return true;
  });
  if (!written) return { ok: false, code: 'changed', reason: SCHEDULE_REFUSAL.changed };
  return { ok: true, from: schedule.status, to: decision.to };
}
