'use client';

import { useState } from 'react';
import { t, type MessageKey } from '@/lib/i18n';
import { STAFF_REASON_MIN } from '@/lib/send-limits';
import { Button, ConfirmDialog } from '@/components/ds';
import type { ScheduleControls as Controls, ScheduleOp } from '@/lib/partner-schedules';
import type { ActionResult } from '../../action-result';
import { scheduleOpAction } from './actions';

// The schedule row's pause / resume / cancel dialogs (merge plan 2a). The page renders them only
// for a PARTNER_ADMIN and only for the ops the transition table allows; that is UX. The server
// action re-gates, re-scopes the id to the session tenant, re-checks the reason (same minimum) and
// the transition. The result renders OUTSIDE the dialog, because ConfirmDialog closes after the action.

const OPS: ScheduleOp[] = ['pause', 'resume', 'cancel'];
const key = (op: ScheduleOp, part: 'trigger' | 'title' | 'body' | 'confirm' | 'done') => `partner.schedules.${op}.${part}` as MessageKey;

export function ScheduleControls({ id, controls }: { id: string; controls: Controls }) {
  const [result, setResult] = useState<{ op: ScheduleOp; r: ActionResult } | null>(null);
  const run = (op: ScheduleOp) => async (formData: FormData) => {
    formData.set('id', id);
    formData.set('op', op);
    setResult({ op, r: await scheduleOpAction(formData) });
  };
  return (
    <div className="flex flex-col gap-2" data-testid="partner-schedule-controls">
      <div className="flex flex-wrap items-center gap-2">
        {OPS.filter((op) => controls[op]).map((op) => (
          <ConfirmDialog
            key={op}
            trigger={
              <Button type="button" variant={op === 'cancel' ? 'danger' : 'ghost'} size="sm">
                {t(key(op, 'trigger'))}
              </Button>
            }
            title={t(key(op, 'title'))}
            body={t(key(op, 'body'))}
            confirmLabel={t(key(op, 'confirm'))}
            reasonMin={STAFF_REASON_MIN}
            destructive={op === 'cancel'}
            action={run(op)}
          />
        ))}
      </div>
      <div aria-live="polite">
        {result?.r.ok === true ? (
          <p role="status" className="text-[13.5px] font-semibold text-ds-success-ink">
            {t(key(result.op, 'done'))}
          </p>
        ) : null}
        {result && result.r.ok === false ? (
          <p role="alert" className="text-[13.5px] font-semibold text-ds-danger-ink">
            {result.r.error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
