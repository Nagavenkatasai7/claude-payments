'use client';

import { useActionState } from 'react';
import { t } from '@/lib/i18n';
import { Button, Checkbox, Field, Input } from '@/components/ds';
import type { ActionResult } from '../../../action-result';
import { setCustomerLimitAction } from './limit-actions';

// The per-customer send-limit form (UI redesign M3-12). A plain <form action> carrying the opaque
// customer ref in a hidden field; the server action re-gates (admin only), re-scopes the ref to the
// session tenant, validates, clamps and refuses over a SmartRemit override, so nothing here is
// trusted. The page re-renders after a save with the new effective limits.

async function submit(_prev: ActionResult | null, formData: FormData): Promise<ActionResult | null> {
  return setCustomerLimitAction(formData);
}

export function LimitForm({ customerRef, capLabel }: { customerRef: string; capLabel: string }) {
  const [state, formAction, pending] = useActionState(submit, null);
  return (
    <form action={formAction} className="flex flex-col gap-4" data-testid="partner-customer-limit-form">
      <input type="hidden" name="ref" value={customerRef} />
      <p className="text-[13px] text-ds-ink-muted">{t('partner.limits.formHint', { cap: capLabel })}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="perTransferUsd" label={t('partner.limits.perTransferLabel')}>
          {(ids) => <Input id={ids.id} name="perTransferUsd" inputMode="numeric" pattern="[0-9]*" autoComplete="off" />}
        </Field>
        <Field name="t1DailyUsd" label={t('partner.limits.dailyLabel')}>
          {(ids) => <Input id={ids.id} name="t1DailyUsd" inputMode="numeric" pattern="[0-9]*" autoComplete="off" />}
        </Field>
        <Field name="expiresAt" label={t('partner.limits.expiresLabel')}>
          {(ids) => <Input id={ids.id} name="expiresAt" type="date" />}
        </Field>
      </div>
      <Field name="reason" label={t('partner.limits.reasonLabel')} hint={t('partner.limits.reasonHint')} required>
        {(ids) => (
          <Input id={ids.id} name="reason" required maxLength={200} autoComplete="off" aria-describedby={ids.describedBy} />
        )}
      </Field>
      <Checkbox name="clear" label={t('partner.limits.clearLabel')} />
      <div>
        <Button type="submit" size="md" disabled={pending}>
          {pending ? t('partner.limits.saving') : t('partner.limits.submit')}
        </Button>
      </div>
      <div aria-live="polite">
        {state?.ok === true ? (
          <p role="status" className="text-[14px] font-semibold text-ds-success-ink">
            {t('partner.limits.saved')}
          </p>
        ) : null}
        {state && state.ok === false ? (
          <p role="alert" className="text-[14px] font-semibold text-ds-danger-ink">
            {state.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
