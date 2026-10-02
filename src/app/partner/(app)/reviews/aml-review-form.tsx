'use client';

import { useActionState, useId } from 'react';
import { t } from '@/lib/i18n';
import { Button, Input, Select } from '@/components/ds';
import type { ActionResult } from '../../action-result';
import { reviewAmlAlertAction } from './aml-actions';

// Close one AML review item (merge plan 2c, D5: admins only; the page renders this only for an
// admin). The alert id rides in a hidden field; the server action re-gates, loads the alert inside
// the session tenant and validates the outcome and note, so nothing here is trusted.

async function submit(_prev: ActionResult | null, formData: FormData): Promise<ActionResult | null> {
  return reviewAmlAlertAction(formData);
}

export function AmlReviewForm({ alertId }: { alertId: number }) {
  const [state, formAction, pending] = useActionState(submit, null);
  const id = useId();
  if (state?.ok === true) {
    return (
      <p role="status" className="text-[13.5px] font-semibold text-ds-success-ink">
        {t('partner.reviews.aml.closed')}
      </p>
    );
  }
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2" data-testid="partner-aml-review-form">
      <input type="hidden" name="alertId" value={String(alertId)} />
      <div className="flex flex-col">
        <label htmlFor={`${id}-d`} className="mb-1 text-[12.5px] font-semibold text-ds-ink-muted">
          {t('partner.reviews.aml.disposition')}
        </label>
        <Select id={`${id}-d`} name="disposition" defaultValue="no_action" className="min-w-[11rem]">
          <option value="no_action">{t('partner.reviews.aml.disposition.no_action')}</option>
          <option value="escalated">{t('partner.reviews.aml.disposition.escalated')}</option>
        </Select>
      </div>
      <div className="flex min-w-[12rem] flex-1 flex-col">
        <label htmlFor={`${id}-n`} className="mb-1 text-[12.5px] font-semibold text-ds-ink-muted">
          {t('partner.reviews.aml.note')}
        </label>
        <Input id={`${id}-n`} name="note" maxLength={500} autoComplete="off" />
      </div>
      <Button type="submit" size="md" variant="ghost" disabled={pending}>
        {t('partner.reviews.aml.submit')}
      </Button>
      {state && state.ok === false ? (
        <p role="alert" className="w-full text-[13.5px] font-semibold text-ds-danger-ink">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
