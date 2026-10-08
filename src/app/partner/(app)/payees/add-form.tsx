'use client';

import { useActionState } from 'react';
import { t } from '@/lib/i18n';
import { Button, Field, Input } from '@/components/ds';
import { addPayeeAction, type AddPayeeState } from './actions';

// Batch B2: the "Add a company" form. A POST, so bank details never reach the URL. The action
// re-validates every field; this form only shows what comes back. The account number is typed
// twice and hidden while typed (the pay page's recipe), and is never echoed back after a refusal.

const HIDDEN = '[-webkit-text-security:disc]';

async function submit(_prev: AddPayeeState | null, formData: FormData): Promise<AddPayeeState | null> {
  return addPayeeAction(formData);
}

export function AddPayeeForm() {
  const [state, formAction, pending] = useActionState(submit, null);
  const fe = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-2" data-testid="partner-payee-add">
      <Field name="legalName" label={t('partner.payees.add.legalName')} error={fe.legalName} required>
        {(ids) => <Input id={ids.id} name="legalName" autoComplete="off" maxLength={120} required invalid={ids.invalid} aria-describedby={ids.describedBy} />}
      </Field>
      <Field name="accountHolder" label={t('partner.payees.add.accountHolder')} error={fe.accountHolder} required>
        {(ids) => <Input id={ids.id} name="accountHolder" autoComplete="off" maxLength={120} required invalid={ids.invalid} aria-describedby={ids.describedBy} />}
      </Field>
      <Field name="ifsc" label={t('partner.payees.add.ifsc')} error={fe.ifsc} required>
        {(ids) => (
          <Input id={ids.id} name="ifsc" autoComplete="off" maxLength={11} required className="uppercase" invalid={ids.invalid} aria-describedby={ids.describedBy} />
        )}
      </Field>
      <div className="hidden sm:block" />
      <Field name="accountNumber" label={t('partner.payees.add.accountNumber')} error={fe.accountNumber} required>
        {(ids) => (
          <Input id={ids.id} name="accountNumber" inputMode="numeric" autoComplete="off" maxLength={40} required className={HIDDEN} invalid={ids.invalid} aria-describedby={ids.describedBy} />
        )}
      </Field>
      <Field name="accountNumberConfirm" label={t('partner.payees.add.accountNumberConfirm')} error={fe.accountNumberConfirm} required>
        {(ids) => (
          <Input id={ids.id} name="accountNumberConfirm" inputMode="numeric" autoComplete="off" maxLength={40} required className={HIDDEN} invalid={ids.invalid} aria-describedby={ids.describedBy} />
        )}
      </Field>
      <p className="text-[14px] text-ds-ink-muted sm:col-span-2">{t('partner.payees.add.note')}</p>
      <div className="sm:col-span-2">
        <Button type="submit" size="md" disabled={pending}>
          {t('partner.payees.add.submit')}
        </Button>
      </div>
      <div aria-live="polite" className="sm:col-span-2">
        {state ? (
          <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'text-[14px] font-semibold text-ds-success-ink' : 'text-[14px] font-semibold text-ds-danger-ink'}>
            {state.ok ? state.message : state.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
