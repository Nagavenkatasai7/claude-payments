'use client';

import * as React from 'react';
import { useActionState } from 'react';
import { t } from '@/lib/i18n';
import { Button, Checkbox } from '@/components/ds';
import type { KycDecider, PostureRecord } from '@/lib/live-controls';
import type { StepUpRequired } from '@/lib/staff-step-up-result';
import type { ActionResult } from '../../action-result';
import { StepUpPrompt, useStepUpAction } from '../integrations/step-up';
import { attestTemplatesAction, requestGoLiveAction, signPostureAction } from './actions';

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

const RADIO = 'mt-1 size-4 shrink-0 accent-ds-primary';
const KYC_DECIDERS: readonly KycDecider[] = ['smartremit_procedures', 'partner'];
const HOLD_DECIDERS: readonly PostureRecord['holdDecider'][] = ['partner', 'smartremit_delegated'];

/**
 * Fix pack 3 T9 (R27): sign the compliance posture. The radio matching the platform kycMode is
 * pre-checked (`expected`); the server re-reads the locked kycMode and refuses a mismatch, so the
 * pre-check is a convenience only. The step-up retry re-sends the same submission.
 */
export function PostureForm({ expected }: { expected: KycDecider }) {
  const flow = useStepUpAction<ActionResult | StepUpRequired>((fd) => signPostureAction(null, fd));
  const [pending, startSign] = React.useTransition();
  const result = flow.stepUp ? null : (flow.result as ActionResult | null);
  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startSign(async () => {
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
        className="mt-3 flex flex-col gap-4"
        data-testid="partner-live-posture-form"
      >
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-[14px] font-semibold text-ds-ink">{t('partner.live.posture.kycDecider')}</legend>
          {KYC_DECIDERS.map((d) => (
            <label key={d} className="flex min-h-11 items-center gap-3 text-[15px] text-ds-ink">
              <input type="radio" name="kycDecider" value={d} defaultChecked={d === expected} required className={RADIO} />
              <span>{t(d === 'partner' ? 'partner.live.posture.kycDecider.partner' : 'partner.live.posture.kycDecider.smartremit_procedures')}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-[14px] font-semibold text-ds-ink">{t('partner.live.posture.holdDecider')}</legend>
          {HOLD_DECIDERS.map((d) => (
            <label key={d} className="flex min-h-11 items-center gap-3 text-[15px] text-ds-ink">
              <input type="radio" name="holdDecider" value={d} required className={RADIO} />
              <span>{t(d === 'partner' ? 'partner.live.posture.holdDecider.partner' : 'partner.live.posture.holdDecider.smartremit_delegated')}</span>
            </label>
          ))}
        </fieldset>
        <Checkbox name="fourEyesNonSanctions" label={t('partner.live.posture.fourEyes')} />
        <div>
          <Button type="submit" size="md" disabled={pending || flow.retrying}>
            {t('partner.live.posture.sign')}
          </Button>
        </div>
        <div aria-live="polite">
          {result && result.ok === false ? (
            <p role="alert" className="text-[14px] font-semibold text-ds-danger-ink">
              {result.error}
            </p>
          ) : null}
        </div>
      </form>
      {flow.stepUp ? <StepUpPrompt stepUp={flow.stepUp} onSubmit={flow.retry} onCancel={flow.dismiss} pending={flow.retrying} /> : null}
    </div>
  );
}
