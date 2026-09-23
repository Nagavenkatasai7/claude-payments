import { describe, it, expect } from 'vitest';
import { decideScheduleAction, type ScheduleAction } from '@/lib/schedule-control';
import type { ScheduleStatus } from '@/lib/types';

// Program-Fix 36 (schedules-02): the ONE transition table for the staff
// pause/resume/cancel kill switch. Pure; the server actions and the cron
// route every status flip through it.

describe('decideScheduleAction', () => {
  it('pause: active → paused', () => {
    expect(decideScheduleAction('active', 'pause')).toEqual({ ok: true, from: ['active'], to: 'paused' });
  });

  it('resume: paused → active', () => {
    expect(decideScheduleAction('paused', 'resume')).toEqual({ ok: true, from: ['paused'], to: 'active' });
  });

  it('cancel: active|paused → cancelled (the guard accepts BOTH from-states)', () => {
    expect(decideScheduleAction('active', 'cancel')).toEqual({ ok: true, from: ['active', 'paused'], to: 'cancelled' });
    expect(decideScheduleAction('paused', 'cancel')).toEqual({ ok: true, from: ['active', 'paused'], to: 'cancelled' });
  });

  it('refuses pause on a paused or cancelled schedule', () => {
    expect(decideScheduleAction('paused', 'pause')).toMatchObject({ ok: false });
    expect(decideScheduleAction('cancelled', 'pause')).toMatchObject({ ok: false });
  });

  it('refuses resume on an active or cancelled schedule', () => {
    expect(decideScheduleAction('active', 'resume')).toMatchObject({ ok: false });
    expect(decideScheduleAction('cancelled', 'resume')).toMatchObject({ ok: false });
  });

  it('cancelled is terminal: cancel is refused too', () => {
    expect(decideScheduleAction('cancelled', 'cancel')).toMatchObject({ ok: false });
  });

  it('every refusal carries a staff-safe reason (no PII: it only names the states)', () => {
    const refusals: Array<[ScheduleStatus, ScheduleAction]> = [
      ['paused', 'pause'], ['cancelled', 'pause'],
      ['active', 'resume'], ['cancelled', 'resume'],
      ['cancelled', 'cancel'],
    ];
    for (const [status, action] of refusals) {
      const d = decideScheduleAction(status, action);
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.reason).toMatch(/schedule/i);
    }
  });

  it('an unknown ledger value is refused at runtime, never written', () => {
    // The switch is exhaustive at compile time (a `never` check); at runtime a
    // value the type does not know about must fall through to a refusal.
    const d = decideScheduleAction('bogus' as ScheduleStatus, 'pause');
    expect(d.ok).toBe(false);
  });
});
