'use client';

import * as React from 'react';
import { t } from '@/lib/i18n';
import { Button } from '@/components/ds';
import type { StepUpRequired } from '@/lib/staff-step-up-result';
import type { ActionResult } from '../../action-result';
import { StepUpPrompt, useStepUpAction } from '../integrations/step-up';
import { setComplianceUserAction } from './actions';

// Fix pack 3 T9 (R15): add or take off one compliance user. The username and the direction ride on
// the form like any field: the server action re-gates (admin + own MFA + step-up), takes the tenant
// from the session and, when adding, checks the target is an active admin or agent of that tenant.

export function ComplianceUserToggle({ username, on }: { username: string; on: boolean }) {
  const flow = useStepUpAction<ActionResult | StepUpRequired>((fd) => setComplianceUserAction(null, fd));
  const [pending, start] = React.useTransition();
  const result = flow.stepUp ? null : (flow.result as ActionResult | null);
  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    start(async () => {
      await flow.run(fd);
    });
  };
  return (
    <div className="flex flex-col items-start gap-1">
      <form onSubmit={onSubmit}>
        <input type="hidden" name="username" value={username} />
        <input type="hidden" name="on" value={on ? 'off' : 'on'} />
        <Button
          type="submit"
          variant="ghost"
          size="sm"
          disabled={pending || flow.retrying}
          aria-label={t(on ? 'partner.staff.complianceUser.removeName' : 'partner.staff.complianceUser.addName', { name: username })}
        >
          {t(on ? 'partner.staff.complianceUser.remove' : 'partner.staff.complianceUser.add')}
        </Button>
      </form>
      <span aria-live="polite">
        {result && result.ok === false ? (
          <span role="alert" className="block text-[13px] font-semibold text-ds-danger-ink">
            {result.error}
          </span>
        ) : null}
      </span>
      {flow.stepUp ? <StepUpPrompt stepUp={flow.stepUp} onSubmit={flow.retry} onCancel={flow.dismiss} pending={flow.retrying} /> : null}
    </div>
  );
}
