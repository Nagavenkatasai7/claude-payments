'use client';

import * as React from 'react';
import { t } from '@/lib/i18n';
import { Button, Field, Input, Select } from '@/components/ds';
import { COUNTRY_NAMES, SUPPORTED_DESTINATIONS } from '@/lib/destination-country';
import type { StepUpRequired } from '@/lib/staff-step-up-result';
import type { ActionResult } from '../../action-result';
import { StepUpPrompt, useStepUpAction } from '../integrations/step-up';
import { approveCapabilityAction, setPartnerSwitchAction } from './actions';

// /partner/controls writes (fix pack 3 T11). Nothing here is trusted: each server action re-gates
// (admin + the actor's own MFA), takes the tenant from the session, validates the key, corridor,
// reason and capability, and asks for the step-up itself (resume, approve). The step-up retry
// re-sends the same submission. Hidden fields are a convenience only.

function Outcome({ result }: { result: ActionResult | null }) {
  return (
    <div aria-live="polite">
      {result?.ok === true ? (
        <p role="status" className="text-[14px] font-semibold text-ds-success-ink">
          {t('partner.controls.saved')}
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

/**
 * One pause or resume. `enabled` is what the submit sets ('on' = pause). `corridor`: a fixed
 * corridor (the resume of a corridor pause); `corridorChoice`: offer the corridor select (a pause
 * of a switch that may name one corridor; blank = the whole workspace).
 */
export function SwitchForm({
  switchKey,
  enabled,
  corridor,
  corridorChoice,
}: {
  switchKey: string;
  enabled: 'on' | 'off';
  corridor?: string;
  corridorChoice?: boolean;
}) {
  const flow = useStepUpAction<ActionResult | StepUpRequired>((fd) => setPartnerSwitchAction(null, fd));
  const [pending, startSave] = React.useTransition();
  const result = flow.stepUp ? null : (flow.result as ActionResult | null);
  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startSave(async () => {
      await flow.run(fd);
    });
  };
  return (
    <div>
      <form
        onSubmit={onSubmit}
        onChange={() => {
          if (flow.stepUp) flow.dismiss();
        }}
        className="mt-3 flex flex-col gap-3"
        data-testid="partner-controls-switch-form"
        data-enabled={enabled}
      >
        <input type="hidden" name="key" value={switchKey} />
        <input type="hidden" name="enabled" value={enabled} />
        {corridor ? <input type="hidden" name="corridor" value={corridor} /> : null}
        {corridorChoice && !corridor ? (
          <Field name="corridor" label={t('partner.controls.corridor')}>
            {(ids) => (
              <Select id={ids.id} name="corridor" aria-describedby={ids.describedBy} defaultValue="">
                <option value="">{t('partner.controls.wholeWorkspace')}</option>
                {SUPPORTED_DESTINATIONS.map((c) => (
                  <option key={c} value={c}>
                    {COUNTRY_NAMES[c]} ({c})
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
        <Field name="reason" label={t('partner.controls.reasonLabel')}>
          {(ids) => <Input id={ids.id} name="reason" aria-describedby={ids.describedBy} required minLength={10} maxLength={500} autoComplete="off" />}
        </Field>
        <div>
          <Button type="submit" size="md" variant={enabled === 'on' ? 'primary' : 'ghost'} disabled={pending || flow.retrying}>
            {t(enabled === 'on' ? 'partner.controls.pause' : 'partner.controls.resume')}
          </Button>
        </div>
        <Outcome result={result} />
      </form>
      {flow.stepUp ? <StepUpPrompt stepUp={flow.stepUp} onSubmit={flow.retry} onCancel={flow.dismiss} pending={flow.retrying} /> : null}
    </div>
  );
}

/** Approve (`on`) or withdraw one live feature. Approving asks for the step-up; withdrawing never does. */
export function CapabilityForm({ capability, on }: { capability: string; on: boolean }) {
  const flow = useStepUpAction<ActionResult | StepUpRequired>((fd) => approveCapabilityAction(null, fd));
  const [pending, startSave] = React.useTransition();
  const result = flow.stepUp ? null : (flow.result as ActionResult | null);
  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startSave(async () => {
      await flow.run(fd);
    });
  };
  return (
    <div>
      <form onSubmit={onSubmit} className="flex flex-col gap-2" data-testid="partner-controls-capability-form" data-on={on ? 'on' : 'off'}>
        <input type="hidden" name="capability" value={capability} />
        <input type="hidden" name="on" value={on ? 'on' : 'off'} />
        <div>
          <Button type="submit" size="sm" variant={on ? 'primary' : 'ghost'} disabled={pending || flow.retrying}>
            {t(on ? 'partner.controls.optin.approve' : 'partner.controls.optin.withdraw')}
          </Button>
        </div>
        <Outcome result={result} />
      </form>
      {flow.stepUp ? <StepUpPrompt stepUp={flow.stepUp} onSubmit={flow.retry} onCancel={flow.dismiss} pending={flow.retrying} /> : null}
    </div>
  );
}
