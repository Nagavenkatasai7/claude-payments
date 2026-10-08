'use client';

import { useActionState } from 'react';
import { t } from '@/lib/i18n';
import { Button, Field, Input, Select } from '@/components/ds';
import { createLinkAction, type CreateLinkState } from './actions';
import { CopyButton } from './copy-button';

// Batch B2: "New link" for one customer. A POST, so the phone and the amount stay out of the URL.
// The action re-validates every field (purpose required) and refuses a payee that is not this
// tenant's approved one. On success the link is shown with a copy button: SmartRemit sends nothing.

export interface PayeeOption {
  id: string;
  legalName: string;
}

async function submit(_prev: CreateLinkState | null, formData: FormData): Promise<CreateLinkState | null> {
  return createLinkAction(formData);
}

export function CreateLinkForm({ payees, purposes }: { payees: PayeeOption[]; purposes: Array<{ code: string; label: string }> }) {
  const [state, formAction, pending] = useActionState(submit, null);
  const fe = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} className="grid gap-4 sm:grid-cols-2" data-testid="partner-paylink-create">
        <Field name="payeeId" label={t('partner.paymentLinks.create.payee')} required className="sm:col-span-2">
          {(ids) => (
            <Select id={ids.id} name="payeeId" required defaultValue={payees[0]?.id} aria-describedby={ids.describedBy}>
              {payees.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.legalName}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field name="name" label={t('partner.paymentLinks.create.name')} error={fe.name} required>
          {(ids) => <Input id={ids.id} name="name" autoComplete="off" maxLength={120} required invalid={ids.invalid} aria-describedby={ids.describedBy} />}
        </Field>
        <Field name="phone" label={t('partner.paymentLinks.create.phone')} hint={t('partner.paymentLinks.create.phoneHint')} error={fe.phone} required>
          {(ids) => (
            <Input id={ids.id} name="phone" type="tel" inputMode="tel" autoComplete="off" maxLength={40} required invalid={ids.invalid} aria-describedby={ids.describedBy} />
          )}
        </Field>
        <Field name="amount" label={t('partner.paymentLinks.create.amount')} error={fe.amount} required>
          {(ids) => (
            <Input id={ids.id} name="amount" inputMode="decimal" autoComplete="off" maxLength={20} required invalid={ids.invalid} aria-describedby={ids.describedBy} />
          )}
        </Field>
        <Field name="reference" label={t('partner.paymentLinks.create.reference')} hint={t('partner.paymentLinks.create.referenceHint')} error={fe.reference} required>
          {(ids) => (
            <Input id={ids.id} name="reference" autoComplete="off" maxLength={64} required invalid={ids.invalid} aria-describedby={ids.describedBy} />
          )}
        </Field>
        <Field name="purpose" label={t('partner.paymentLinks.create.purpose')} error={fe.purpose} required>
          {(ids) => (
            <Select id={ids.id} name="purpose" required defaultValue="" invalid={ids.invalid} aria-describedby={ids.describedBy}>
              <option value="" disabled>
                {t('partner.paymentLinks.create.purposePick')}
              </option>
              {purposes.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="sm:col-span-2">
          <Button type="submit" size="md" disabled={pending}>
            {t('partner.paymentLinks.create.submit')}
          </Button>
        </div>
      </form>
      <div aria-live="polite">
        {state && !state.ok ? (
          <p role="alert" className="text-[14px] font-semibold text-ds-danger-ink">
            {state.error}
          </p>
        ) : null}
        {state && state.ok ? (
          <div role="status" className="flex flex-col gap-2 rounded-ds-inner border border-ds-success-border bg-ds-success-bg p-4">
            <p className="text-[14px] font-semibold text-ds-success-ink">{t('partner.paymentLinks.create.done', { reference: state.reference })}</p>
            <p className="break-all font-mono text-[13px] text-ds-ink">{state.url}</p>
            {state.warnings.map((w) => (
              <p key={w} className="text-[13px] text-ds-warning-ink">
                {w}
              </p>
            ))}
            <div>
              <CopyButton text={state.url} />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
