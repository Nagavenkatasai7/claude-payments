'use client';

import { useState } from 'react';
import { t, type MessageKey } from '@/lib/i18n';
import { STAFF_REASON_MIN } from '@/lib/send-limits';
import { Button, ConfirmDialog } from '@/components/ds';
import type { RefundControls as Controls, RefundOp } from '@/lib/partner-refunds';
import type { StepUpRequired } from '@/lib/staff-step-up-result';
import type { ActionResult } from '../../action-result';
import { StepUpPrompt, useStepUpAction } from '../integrations/step-up';
import { refundOpAction } from './actions';

// The refund row's approve / dismiss / retry dialogs (merge plan 2b). The page renders them only for
// a PARTNER_ADMIN and only for the ops the refund's state allows; that is UX. The server action
// re-gates, re-scopes the id to the session tenant, re-checks the reason (same minimum) and the
// state. Approve and retry need a fresh step-up: the step_up_required result shows StepUpPrompt,
// whose retry re-sends the SAME submission (the typed reason included) with the secret added.
// The result renders OUTSIDE the dialog, because ConfirmDialog closes after the action.

const OPS: RefundOp[] = ['approve', 'dismiss', 'retry'];
const key = (op: RefundOp, part: 'trigger' | 'title' | 'body' | 'confirm' | 'done') => `partner.refunds.${op}.${part}` as MessageKey;

export function RefundControls({ id, controls }: { id: string; controls: Controls }) {
  const [lastOp, setLastOp] = useState<RefundOp | null>(null);
  const flow = useStepUpAction<ActionResult | StepUpRequired>((fd) => refundOpAction(fd));
  const result = flow.stepUp ? null : (flow.result as ActionResult | null);
  const run = (op: RefundOp) => async (formData: FormData) => {
    formData.set('id', id);
    formData.set('op', op);
    setLastOp(op);
    await flow.run(formData);
  };
  return (
    <div className="flex flex-col gap-2" data-testid="partner-refund-controls">
      <div className="flex flex-wrap items-center gap-2">
        {OPS.filter((op) => controls[op]).map((op) => (
          <ConfirmDialog
            key={op}
            trigger={
              <Button type="button" variant={op === 'dismiss' ? 'ghost' : 'primary'} size="sm">
                {t(key(op, 'trigger'))}
              </Button>
            }
            title={t(key(op, 'title'))}
            body={t(key(op, 'body'))}
            confirmLabel={t(key(op, 'confirm'))}
            reasonMin={STAFF_REASON_MIN}
            action={run(op)}
          />
        ))}
      </div>
      {flow.stepUp ? <StepUpPrompt stepUp={flow.stepUp} onSubmit={flow.retry} onCancel={flow.dismiss} pending={flow.retrying} /> : null}
      <div aria-live="polite">
        {result?.ok === true && lastOp ? (
          <p role="status" className="text-[13.5px] font-semibold text-ds-success-ink">
            {t(key(lastOp, 'done'))}
          </p>
        ) : null}
        {result && result.ok === false ? (
          <p role="alert" className="text-[13.5px] font-semibold text-ds-danger-ink">
            {result.error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
