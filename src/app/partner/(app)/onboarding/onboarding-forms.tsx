'use client';

import { useActionState } from 'react';
import { t } from '@/lib/i18n';
import { Button, Checkbox } from '@/components/ds';
import type { ActionResult } from '../../action-result';
import { attestTemplatesAction, requestGoLiveAction } from './actions';

// The two onboarding writes (UI redesign M3-20). Nothing here is trusted: each server action
// re-gates (admin + MFA), takes the tenant from the session and, for go-live, re-computes the
// checklist from stored facts. `disabled` on the request button is a convenience only.

async function submitAttest(_prev: ActionResult | null, formData: FormData): Promise<ActionResult | null> {
  return attestTemplatesAction(formData);
}
async function submitRequest(_prev: ActionResult | null, formData: FormData): Promise<ActionResult | null> {
  return requestGoLiveAction(formData);
}

function Result({ state, okKey }: { state: ActionResult | null; okKey: Parameters<typeof t>[0] }) {
  return (
    <div aria-live="polite">
      {state?.ok === true ? (
        <p role="status" className="text-[14px] font-semibold text-ds-success-ink">
          {t(okKey)}
        </p>
      ) : null}
      {state && state.ok === false ? (
        <p role="alert" className="text-[14px] font-semibold text-ds-danger-ink">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}

export function AttestTemplatesForm() {
  const [state, formAction, pending] = useActionState(submitAttest, null);
  return (
    <form action={formAction} className="mt-3 flex flex-col gap-2" data-testid="partner-onboarding-attest-form">
      <Checkbox name="authentication" label={t('partner.onboarding.attest.authentication')} required />
      <Checkbox name="transfer_delivered" label={t('partner.onboarding.attest.transferDelivered')} required />
      <div>
        <Button type="submit" size="md" variant="ghost" disabled={pending}>
          {pending ? t('partner.onboarding.attest.saving') : t('partner.onboarding.attest.submit')}
        </Button>
      </div>
      <Result state={state} okKey="partner.onboarding.attest.saved" />
    </form>
  );
}

export function RequestGoLiveForm({ ready }: { ready: boolean }) {
  const [state, formAction, pending] = useActionState(submitRequest, null);
  return (
    <form action={formAction} className="mt-3 flex flex-col gap-2">
      <div>
        <Button type="submit" size="md" data-testid="partner-onboarding-request" disabled={!ready || pending}>
          {pending ? t('partner.onboarding.request.sending') : t('partner.onboarding.request.submit')}
        </Button>
      </div>
      {!ready ? <p className="text-[14px] text-ds-ink-muted">{t('partner.onboarding.request.blocked')}</p> : null}
      <Result state={state} okKey="partner.onboarding.request.sent" />
    </form>
  );
}
