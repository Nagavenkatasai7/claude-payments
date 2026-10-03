'use client';

import { useActionState } from 'react';
import { t } from '@/lib/i18n';
import { Button, Field, Input } from '@/components/ds';
import type { ActionResult } from '../../action-result';
import { findCustomerAction } from './actions';

// "Find by phone" (lost-features p2 A11): a POST form, so the full number stays out of the URL. A
// hit redirects to the customer's sealed ref; a miss shows fixed copy.

async function submit(_prev: ActionResult | null, formData: FormData): Promise<ActionResult | null> {
  return findCustomerAction(formData);
}

export function FindCustomerForm() {
  const [state, formAction, pending] = useActionState(submit, null);
  return (
    <form
      action={formAction}
      aria-label={t('partner.customers.find.label')}
      className="flex flex-col gap-2 rounded-ds-card border border-ds-border bg-ds-surface p-4"
      data-testid="partner-customer-find"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <Field name="phone" label={t('partner.customers.find.label')} hint={t('partner.customers.find.hint')} className="min-w-0 flex-1">
          {(ids) => (
            <Input
              id={ids.id}
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="off"
              maxLength={40}
              required
              placeholder={t('partner.customers.find.placeholder')}
              aria-describedby={ids.describedBy}
            />
          )}
        </Field>
        <Button type="submit" size="md" disabled={pending} className="sm:mt-[30px]">
          {t('partner.customers.find.submit')}
        </Button>
      </div>
      <div aria-live="polite">
        {state && state.ok === false ? (
          <p role="alert" className="text-[14px] font-semibold text-ds-danger-ink">
            {state.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
