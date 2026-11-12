'use client';

import { startTransition, useActionState, useRef, useState } from 'react';
import { t } from '@/lib/i18n';
import { Button, Field, Input, Select } from '@/components/ds';
import type { CountryCode } from '@/lib/types';
import { isStepUpRequired, withStepUpSecret, withoutStepUpSecret, type StepUpRequired } from '@/lib/staff-step-up-result';
import type { ActionResult } from '../../../action-result';
import { StepUpPrompt } from '../../integrations/step-up';
import { createCustomerAction } from './actions';

// The "New customer" form (lost-features p2 A5). A POST, so the phone stays out of the URL; success
// redirects to the customer's sealed ref; a refusal shows fixed copy. `verified` is offered only when
// the page says the partner runs KYC (delegated); the action re-checks it server-side either way.
// Fix pack 7 T26 (R12): for a partner that decides KYC a `verified` create asks for a fresh
// step-up; StepUpPrompt re-sends the SAME submission with the secret added (never kept).

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring';
const TEXTAREA = `min-h-[96px] w-full rounded-ds-inner border border-ds-border-input bg-ds-surface px-4 py-3 text-[15px] text-ds-ink placeholder:text-ds-ink-subtle ${FOCUS}`;

type Result = ActionResult | StepUpRequired;

async function submit(_prev: Result | null, formData: FormData): Promise<Result | null> {
  return createCustomerAction(formData);
}

export function CreateCustomerForm({ countries, canVerify }: { countries: readonly CountryCode[]; canVerify: boolean }) {
  const [state, formAction, pending] = useActionState(submit, null);
  const last = useRef<FormData | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const send = (fd: FormData) => {
    last.current = withoutStepUpSecret(fd);
    setDismissed(false);
    formAction(fd);
  };
  const retry = (secret: string) => {
    const base = last.current;
    if (!base) return;
    startTransition(() => formAction(withStepUpSecret(base, secret)));
  };
  const stepUp = !dismissed && isStepUpRequired(state) ? state : null;
  return (
    <>
      <form action={send} className="flex flex-col gap-4" data-testid="partner-customer-create">
        <Field name="phone" label={t('partner.customers.create.phone')} hint={t('partner.customers.create.phoneHint')} required>
          {(ids) => (
            <Input id={ids.id} name="phone" type="tel" inputMode="tel" autoComplete="off" maxLength={40} required aria-describedby={ids.describedBy} />
          )}
        </Field>
        <Field name="fullName" label={t('partner.customers.create.name')}>
          {(ids) => <Input id={ids.id} name="fullName" autoComplete="off" maxLength={120} aria-describedby={ids.describedBy} />}
        </Field>
        <Field name="country" label={t('partner.customers.create.country')} required>
          {(ids) => (
            <Select id={ids.id} name="country" required defaultValue={countries[0]} aria-describedby={ids.describedBy}>
              {countries.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {canVerify ? (
          <>
            <Field name="kycStatus" label={t('partner.customers.create.kyc')}>
              {(ids) => (
                <Select id={ids.id} name="kycStatus" defaultValue="not_started" aria-describedby={ids.describedBy}>
                  <option value="not_started">{t('partner.customers.create.kycNotStarted')}</option>
                  <option value="verified">{t('partner.customers.create.kycVerified')}</option>
                </Select>
              )}
            </Field>
            <Field name="reason" label={t('partner.customers.create.reason')} hint={t('partner.customers.create.reasonHint')}>
              {(ids) => <textarea id={ids.id} name="reason" maxLength={500} rows={3} aria-describedby={ids.describedBy} className={TEXTAREA} />}
            </Field>
          </>
        ) : (
          <input type="hidden" name="kycStatus" value="not_started" />
        )}
        <p className="text-[14px] text-ds-ink-muted" data-create-note="">
          {t('partner.customers.create.noMessageNote')}
        </p>
        <div>
          <Button type="submit" size="md" disabled={pending}>
            {t('partner.customers.create.submit')}
          </Button>
        </div>
        <div aria-live="polite">
          {state && state.ok === false && !isStepUpRequired(state) ? (
            <p role="alert" className="text-[14px] font-semibold text-ds-danger-ink">
              {state.error}
            </p>
          ) : null}
        </div>
      </form>
      {stepUp ? <StepUpPrompt stepUp={stepUp} onSubmit={retry} onCancel={() => setDismissed(true)} pending={pending} /> : null}
    </>
  );
}
