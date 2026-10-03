'use client';

import { useActionState, useState } from 'react';
import { t, type MessageKey } from '@/lib/i18n';
import { Button, Checkbox, Field, Select } from '@/components/ds';
import { RECOVERY_CHECKS, RECOVERY_DECLINE_REASONS, type RecoveryActionResult } from '@/lib/customer-mfa-recovery-rules';
import type { StepUpRequired } from '@/lib/staff-step-up-result';
import { StepUpPrompt, useStepUpAction } from '../../integrations/step-up';
import { approveMfaRecoveryAction, declineMfaRecoveryAction } from './recovery-actions';

// The decision forms of the two-step recovery card (lost-features p4 B4). Rendered only for a
// partner admin on an open, not-escalated request; that is UX. The actions re-gate, re-scope the
// ticket to the session tenant, re-check the checks and the 24-hour wait, and ask for a fresh
// step-up: step_up_required shows StepUpPrompt, whose retry re-sends the SAME submission (the
// ticked checks included) with the code added. Decline asks for no step-up.

const DONE: Record<'approved' | 'already_off' | 'declined', MessageKey> = {
  approved: 'partner.support.mfaRecovery.done',
  already_off: 'partner.support.mfaRecovery.alreadyOff',
  declined: 'partner.support.mfaRecovery.declined',
};

function Outcome({ result }: { result: RecoveryActionResult | null }) {
  return (
    <div aria-live="polite">
      {result?.ok === true ? (
        <p role="status" className="text-[14px] font-semibold text-ds-success-ink">
          {t(DONE[result.outcome])}
        </p>
      ) : null}
      {result && result.ok === false ? (
        <p role="alert" className="text-[14px] font-semibold text-ds-danger-ink">
          {result.error}
        </p>
      ) : null}
    </div>
  );
}

export function RecoveryForms({ id, waitUntil }: { id: string; waitUntil: string }) {
  const flow = useStepUpAction<RecoveryActionResult | StepUpRequired>((fd) => approveMfaRecoveryAction(fd));
  const approveResult = flow.stepUp ? null : (flow.result as RecoveryActionResult | null);
  const [approving, setApproving] = useState(false);
  const [declineResult, decline, declining] = useActionState<RecoveryActionResult | null, FormData>(
    (_prev, fd) => declineMfaRecoveryAction(fd),
    null,
  );
  const decided = approveResult?.ok === true || declineResult?.ok === true;

  const approve = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setApproving(true);
    try {
      await flow.run(fd);
    } finally {
      setApproving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="partner-mfa-recovery-forms">
      {!decided ? (
        <form onSubmit={approve} className="flex flex-col gap-2">
          <input type="hidden" name="id" value={id} />
          <fieldset className="flex flex-col">
            <legend className="mb-1 text-[14px] font-semibold text-ds-ink">{t('partner.support.mfaRecovery.checksLegend')}</legend>
            <p className="mb-1 text-[13px] text-ds-ink-muted">{t('partner.support.mfaRecovery.checksHint', { at: waitUntil })}</p>
            {RECOVERY_CHECKS.map((c) => (
              <Checkbox key={c} name="check" value={c} label={t(`partner.support.mfaRecovery.check.${c}`)} />
            ))}
          </fieldset>
          <div>
            <Button type="submit" variant="danger" size="md" disabled={approving || flow.retrying}>
              {t('partner.support.mfaRecovery.approve')}
            </Button>
          </div>
        </form>
      ) : null}
      {flow.stepUp ? <StepUpPrompt stepUp={flow.stepUp} onSubmit={flow.retry} onCancel={flow.dismiss} pending={flow.retrying} /> : null}
      <Outcome result={approveResult} />

      {!decided ? (
        <form action={decline} className="flex flex-col gap-2 border-t border-ds-border pt-4">
          <input type="hidden" name="id" value={id} />
          <Field name="reason" label={t('partner.support.mfaRecovery.declineReasonLabel')}>
            {(ids) => (
              <Select id={ids.id} name="reason" aria-describedby={ids.describedBy} defaultValue={RECOVERY_DECLINE_REASONS[0]}>
                {RECOVERY_DECLINE_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {t(`partner.support.mfaRecovery.declineReason.${r}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div>
            <Button type="submit" variant="ghost" size="md" disabled={declining}>
              {t('partner.support.mfaRecovery.decline')}
            </Button>
          </div>
        </form>
      ) : null}
      <Outcome result={declineResult} />
    </div>
  );
}
