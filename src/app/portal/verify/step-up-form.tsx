'use client';

import { useActionState } from 'react';
import { portalStepUpAction, type PortalStepUpState } from './actions';
import { t } from '@/lib/i18n';
import { Button, Field, Input } from '@/components/ds';

// Step-up: send a code to the signed-in customer's own WhatsApp (the phone is the session's, never a
// field), then the code, then the authenticator code for an enrolled customer. `next` is re-checked
// against the allow-list by every server step.
export function StepUpForm({ next }: { next: string }) {
  const [state, action, busy] = useActionState(portalStepUpAction, { step: 'start', next } satisfies PortalStepUpState);
  const error = state.error ? t(state.error) : undefined;
  const codeStep = state.step === 'code' || state.step === 'mfa';
  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="next" value={state.next} />
      {codeStep ? <input type="hidden" name="pending" value={state.pending ?? ''} /> : null}
      {state.step === 'code' && state.notice ? (
        <p role="status" className="text-[15px] text-ds-ink-muted">{t(state.notice)}</p>
      ) : null}
      {state.step === 'mfa' ? <p className="text-[15px] text-ds-ink-muted">{t('portal.verify.mfaSub')}</p> : null}
      {codeStep ? (
        <Field name="code" label={state.step === 'mfa' ? t('portal.login.mfaLabel') : t('portal.login.codeLabel')} error={error} required>
          {({ id, describedBy, invalid }) => (
            <Input id={id} name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6}
              required aria-describedby={describedBy} invalid={invalid} />
          )}
        </Field>
      ) : error ? (
        <p role="alert" className="text-[14px] font-semibold text-ds-danger-ink">{error}</p>
      ) : null}
      <Button type="submit" name="intent" value={state.step === 'code' ? 'verify' : state.step === 'mfa' ? 'mfa' : 'request'} disabled={busy}>
        {codeStep ? (busy ? t('portal.login.verifying') : t('portal.login.verify')) : t('portal.verify.sendCode')}
      </Button>
    </form>
  );
}
