'use client';

import { useActionState } from 'react';
import { t } from '@/lib/i18n';
import { Button, Checkbox } from '@/components/ds';
import type { ActionResult } from '../../../action-result';
import { recordEsignWithdrawalAction } from './esign-actions';

// Fix pack 6 truth check TC-T1: the "Record withdrawal" form of the Electronic records block. It
// carries only the opaque customer ref and the confirmation tick; the server action re-gates,
// re-scopes the ref to the session tenant and requires the tick, so nothing here is trusted.

async function submit(_prev: ActionResult | null, formData: FormData): Promise<ActionResult | null> {
  return recordEsignWithdrawalAction(formData);
}

export function EsignWithdrawalForm({ customerRef }: { customerRef: string }) {
  const [state, formAction, pending] = useActionState(submit, null);
  return (
    <form action={formAction} className="mt-3 flex flex-col gap-3" data-testid="partner-customer-esign-form">
      <input type="hidden" name="ref" value={customerRef} />
      <Checkbox name="confirm" label={t('partner.customers.esign.confirm')} required />
      <div>
        <Button type="submit" size="md" variant="ghost" disabled={pending}>
          {pending ? t('partner.customers.esign.saving') : t('partner.customers.esign.submit')}
        </Button>
      </div>
      <div aria-live="polite">
        {state?.ok === true ? (
          <p role="status" className="text-[14px] font-semibold text-ds-success-ink">
            {t('partner.customers.esign.saved')}
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
