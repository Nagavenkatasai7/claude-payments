'use client';

import * as React from 'react';
import { useActionState } from 'react';
import { t } from '@/lib/i18n';
import { Button, Checkbox, Field, Input } from '@/components/ds';
import type { ActionResult } from '../../action-result';
import { saveAlertEmailAction, saveDisclosureAction, saveSupportPortalAction } from './actions';
import { StepUpPrompt, useStepUpAction } from '../integrations/step-up';

// The /partner/settings forms (partner-dashboard merge, 2f). Plain forms: nothing here is trusted.
// The server actions re-gate, take the tenant from the session and validate every value; the
// client attributes (type, maxLength, pattern) are conveniences only. Errors are the server's
// fixed copy. The disclosure save may ask for the 15-minute step-up: StepUpPrompt then re-sends the
// SAME submission with the secret added (../integrations/step-up.tsx).

function Status({ state }: { state: { ok: boolean; error?: string } | null }) {
  return (
    <div aria-live="polite">
      {state?.ok === true ? (
        <p role="status" className="text-[14px] font-semibold text-ds-success-ink">
          {t('partner.settings.saved')}
        </p>
      ) : null}
      {state && state.ok === false && state.error ? (
        <p role="alert" className="text-[14px] font-semibold text-ds-danger-ink">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}

function SaveButton({ pending }: { pending: boolean }) {
  return (
    <Button type="submit" size="md" disabled={pending}>
      {pending ? t('partner.settings.saving') : t('partner.settings.save')}
    </Button>
  );
}

async function submitPortal(_prev: ActionResult | null, formData: FormData): Promise<ActionResult | null> {
  return saveSupportPortalAction(formData);
}

export function SupportPortalForm({ enabled }: { enabled: boolean }) {
  const [state, formAction, pending] = useActionState(submitPortal, null);
  return (
    <form action={formAction} className="flex flex-col gap-4" data-testid="settings-portal-form">
      <Checkbox name="enableSupportPortal" label={t('partner.settings.portal.label')} defaultChecked={enabled} />
      <div>
        <SaveButton pending={pending} />
      </div>
      <Status state={state} />
    </form>
  );
}

async function submitAlert(_prev: ActionResult | null, formData: FormData): Promise<ActionResult | null> {
  return saveAlertEmailAction(formData);
}

export function AlertEmailForm({ current }: { current: string }) {
  const [state, formAction, pending] = useActionState(submitAlert, null);
  return (
    <form action={formAction} className="flex flex-col gap-4" data-testid="settings-alert-form">
      <Field name="alertEmail" label={t('partner.settings.alert.label')}>
        {(ids) => (
          <Input
            id={ids.id}
            name="alertEmail"
            type="email"
            defaultValue={current}
            aria-describedby={ids.describedBy}
            maxLength={254}
            autoComplete="off"
            spellCheck={false}
          />
        )}
      </Field>
      <div>
        <SaveButton pending={pending} />
      </div>
      <Status state={state} />
    </form>
  );
}

export interface DisclosureValues {
  licensedEntity: string;
  licenseIds: string;
  phone: string;
  website: string;
  regulatorName: string;
  regulatorPhone: string;
  regulatorWebsite: string;
  deliveryBusinessDays: string;
}

type TextName = Exclude<keyof DisclosureValues, 'licenseIds'>;

function TextField({ name, label, hint, value, type = 'text', max = 120 }: { name: TextName; label: string; hint?: string; value: string; type?: 'text' | 'tel' | 'url'; max?: number }) {
  return (
    <Field name={name} label={label} hint={hint}>
      {(ids) => (
        <Input
          id={ids.id}
          name={name}
          type={type}
          inputMode={type === 'tel' ? 'tel' : type === 'url' ? 'url' : undefined}
          defaultValue={value}
          aria-describedby={ids.describedBy}
          maxLength={max}
          autoComplete="off"
          spellCheck={false}
        />
      )}
    </Field>
  );
}

export function DisclosureForm({ current, maxDays }: { current: DisclosureValues; maxDays: number }) {
  const flow = useStepUpAction<ActionResult>((fd) => saveDisclosureAction(null, fd));
  const [pending, startSave] = React.useTransition();
  const result = flow.stepUp ? null : flow.result;
  // An onSubmit handler (not a form action), so the fields keep what was typed while the step-up
  // prompt is open: the retry re-sends that same submission. Editing a field drops the prompt.
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
        className="flex flex-col gap-4"
        data-testid="settings-disclosure-form"
      >
        <TextField name="licensedEntity" label={t('partner.settings.disclosure.entity')} value={current.licensedEntity} />
        <Field name="licenseIds" label={t('partner.settings.disclosure.licenseIds')} hint={t('partner.settings.disclosure.licenseIdsHint')}>
          {(ids) => (
            <textarea
              id={ids.id}
              name="licenseIds"
              defaultValue={current.licenseIds}
              aria-describedby={ids.describedBy}
              rows={3}
              maxLength={2400}
              spellCheck={false}
              className="block min-h-[46px] w-full min-w-0 rounded-ds-inner border border-ds-border-input bg-ds-surface px-4 py-2.5 text-[15px] text-ds-ink focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring"
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField name="phone" type="tel" max={24} label={t('partner.settings.disclosure.phone')} value={current.phone} />
          <TextField name="website" type="url" max={200} label={t('partner.settings.disclosure.website')} hint={t('partner.settings.disclosure.websiteHint')} value={current.website} />
        </div>
        <TextField name="regulatorName" label={t('partner.settings.disclosure.regulatorName')} value={current.regulatorName} />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField name="regulatorPhone" type="tel" max={24} label={t('partner.settings.disclosure.regulatorPhone')} value={current.regulatorPhone} />
          <TextField name="regulatorWebsite" type="url" max={200} label={t('partner.settings.disclosure.regulatorWebsite')} hint={t('partner.settings.disclosure.websiteHint')} value={current.regulatorWebsite} />
        </div>
        <Field name="deliveryBusinessDays" label={t('partner.settings.disclosure.days')} hint={t('partner.settings.disclosure.daysHint', { max: maxDays })}>
          {(ids) => (
            <Input
              id={ids.id}
              name="deliveryBusinessDays"
              inputMode="numeric"
              pattern="[0-9]*"
              defaultValue={current.deliveryBusinessDays}
              aria-describedby={ids.describedBy}
              maxLength={2}
              autoComplete="off"
              className="max-w-[8rem]"
            />
          )}
        </Field>
        <div>
          <SaveButton pending={pending} />
        </div>
        <Status state={result} />
      </form>
      {flow.stepUp ? <StepUpPrompt stepUp={flow.stepUp} onSubmit={flow.retry} onCancel={flow.dismiss} pending={flow.retrying} /> : null}
    </div>
  );
}
