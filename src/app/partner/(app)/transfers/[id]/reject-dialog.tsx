'use client';

import { t } from '@/lib/i18n';
import { STAFF_REASON_MIN } from '@/lib/send-limits';
import { Button, ConfirmDialog } from '@/components/ds';
import type { StepUpRequired } from '@/lib/staff-step-up-result';
import type { ActionResult } from '../../../action-result';
import { StepUpPrompt, useStepUpAction } from '../../integrations/step-up';
import { rejectHoldAction } from './reject-actions';

// The reject-and-refund dialog (merge plan 2c, D4). The page renders it only beside ReleaseDialog
// (the same predicate, PARTNER_ADMIN); that is UX. The server action re-gates, re-scopes the id to
// the session tenant and re-checks the reason and the predicate, so nothing here is trusted. A
// reject can start a refund, so it needs a fresh step-up (D2): the step_up_required result shows
// StepUpPrompt, whose retry re-sends the SAME submission (the typed reason included) with the
// secret added. The result renders OUTSIDE the dialog, because ConfirmDialog closes after the action.

export function RejectDialog({ id }: { id: string }) {
  const flow = useStepUpAction<ActionResult | StepUpRequired>((fd) => rejectHoldAction(fd));
  const result = flow.stepUp ? null : (flow.result as ActionResult | null);
  const action = async (formData: FormData) => {
    formData.set('id', id);
    await flow.run(formData);
  };
  return (
    <div className="flex flex-col gap-3" data-testid="partner-reject">
      <div>
        <ConfirmDialog
          trigger={
            <Button type="button" variant="danger" size="md">
              {t('partner.reject.trigger')}
            </Button>
          }
          title={t('partner.reject.title')}
          body={t('partner.reject.body')}
          confirmLabel={t('partner.reject.confirm')}
          reasonMin={STAFF_REASON_MIN}
          destructive
          action={action}
        />
      </div>
      {flow.stepUp ? <StepUpPrompt stepUp={flow.stepUp} onSubmit={flow.retry} onCancel={flow.dismiss} pending={flow.retrying} /> : null}
      <div aria-live="polite">
        {result?.ok === true ? (
          <p role="status" className="text-[14px] font-semibold text-ds-success-ink">
            {t('partner.reject.rejected')}
          </p>
        ) : null}
        {result && result.ok === false ? (
          <p role="alert" className="text-[14px] font-semibold text-ds-danger-ink">
            {result.error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
