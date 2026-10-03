'use client';

import { useState } from 'react';
import { t } from '@/lib/i18n';
import { STAFF_REASON_MIN } from '@/lib/send-limits';
import { Button, Checkbox, ConfirmDialog } from '@/components/ds';
import type { StepUpRequired } from '@/lib/staff-step-up-result';
import type { ActionResult } from '../../../action-result';
import { StepUpPrompt, useStepUpAction } from '../../integrations/step-up';
import { issueRefundAction } from './refund-actions';

// Issue refund on the transfer page (lost-features restore p1 A7). The page renders it only for a
// PARTNER_ADMIN and only when issueRefundEligibility allows; that is UX. The server action re-gates,
// re-scopes the id to the session tenant, re-checks the reason, the routing, the eligibility and
// the clawback tick, and asks for a fresh step-up: the step_up_required result shows StepUpPrompt,
// whose retry re-sends the SAME submission (reason and tick included) with the secret added. The
// result renders OUTSIDE the dialog, because ConfirmDialog closes after the action.

export function IssueRefundDialog({ id, delivered }: { id: string; delivered: boolean }) {
  const [clawback, setClawback] = useState(false);
  const flow = useStepUpAction<ActionResult | StepUpRequired>((fd) => issueRefundAction(fd));
  const result = flow.stepUp ? null : (flow.result as ActionResult | null);
  const run = async (formData: FormData) => {
    formData.set('id', id);
    if (delivered && clawback) formData.set('clawback', 'yes');
    await flow.run(formData);
  };
  return (
    <div className="flex flex-col gap-2" data-testid="partner-issue-refund">
      <div>
        <ConfirmDialog
          trigger={
            <Button type="button" variant="danger" size="md">
              {t('partner.transferOps.refund.button')}
            </Button>
          }
          title={t('partner.transferOps.refund.dialogTitle')}
          body={
            <div className="flex flex-col gap-3">
              <p>{delivered ? t('partner.transferOps.refund.bodyDelivered') : t('partner.transferOps.refund.bodyPaid')}</p>
              {delivered ? (
                <Checkbox
                  name="clawbackConfirm"
                  checked={clawback}
                  onChange={(e) => setClawback(e.target.checked)}
                  label={t('partner.transferOps.refund.clawbackConfirm')}
                />
              ) : null}
            </div>
          }
          confirmLabel={t('partner.transferOps.refund.button')}
          reasonMin={STAFF_REASON_MIN}
          destructive
          action={run}
        />
      </div>
      {flow.stepUp ? <StepUpPrompt stepUp={flow.stepUp} onSubmit={flow.retry} onCancel={flow.dismiss} pending={flow.retrying} /> : null}
      <div aria-live="polite">
        {result?.ok === true ? (
          <p role="status" className="text-[14px] font-semibold text-ds-success-ink">
            {t('partner.transferOps.refund.done')}
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
