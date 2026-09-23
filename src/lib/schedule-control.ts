import type { ScheduleStatus } from './types';

// schedule-control: the ONE transition table for the staff kill switch on
// recurring schedules (Program-Fix 36 / schedules-02).
//
//   pause   active → paused
//   resume  paused → active
//   cancel  active | paused → cancelled     (cancelled is terminal)
//
// Every other request is refused. PURE: the server actions decide here, then
// write with the conditional `setStatusIf(id, partnerId, from, to)` — the
// `from` list below IS the SQL guard (`status IN (<from>)`), so a lost race
// writes nothing. The same pattern as decideStaffCancel (Program-Fix 9).

export type ScheduleAction = 'pause' | 'resume' | 'cancel';

export type ScheduleDecision =
  | { ok: true; from: ScheduleStatus[]; to: ScheduleStatus }
  | { ok: false; reason: string };

/** Refusal copy. Thrown to the browser, so staff-safe: it names states only. */
export const SCHEDULE_REFUSAL = {
  alreadyPaused: 'This schedule is already paused.',
  notPaused: 'Only a paused schedule can be resumed.',
  cancelled: 'This schedule is cancelled — cancelled is final, it cannot be paused, resumed or cancelled again.',
  changed: 'Cannot update: the schedule changed concurrently — reload and try again.',
} as const;

export function decideScheduleAction(current: ScheduleStatus, action: ScheduleAction): ScheduleDecision {
  switch (current) {
    case 'active':
      switch (action) {
        case 'pause': return { ok: true, from: ['active'], to: 'paused' };
        case 'resume': return { ok: false, reason: SCHEDULE_REFUSAL.notPaused };
        case 'cancel': return { ok: true, from: ['active', 'paused'], to: 'cancelled' };
        default: return refuseUnknownAction(action);
      }
    case 'paused':
      switch (action) {
        case 'pause': return { ok: false, reason: SCHEDULE_REFUSAL.alreadyPaused };
        case 'resume': return { ok: true, from: ['paused'], to: 'active' };
        case 'cancel': return { ok: true, from: ['active', 'paused'], to: 'cancelled' };
        default: return refuseUnknownAction(action);
      }
    case 'cancelled':
      return { ok: false, reason: SCHEDULE_REFUSAL.cancelled };
    default: {
      // Exhaustive: a new ScheduleStatus fails tsc HERE until its transitions
      // are decided. At runtime an unknown ledger value is refused, never written.
      const unknownStatus: never = current;
      return { ok: false, reason: `Cannot update a schedule in status ${String(unknownStatus)}.` };
    }
  }
}

function refuseUnknownAction(action: never): ScheduleDecision {
  return { ok: false, reason: `Unknown schedule action ${String(action)}.` };
}
