'use client';

import { useActionState } from 'react';
import { t } from '@/lib/i18n';
import { Button, Field, Input, Select } from '@/components/ds';
import type { StaffOption } from '@/lib/staff-options';
import type { ActionResult } from '../../../action-result';
import { assignTransferAction, resendPayLinkAction } from './ops-actions';

// The transfer page's non-money actions (lost-features restore p1). The page renders each control
// only for viewers transferOpsFor allows; that is UX. Every server action re-gates, re-checks the
// per-staff permission, re-scopes the id to the session tenant and validates the input, so nothing
// here is trusted. Results render as fixed, translated copy.

function Result({ state, done }: { state: ActionResult | null; done: string }) {
  return (
    <div aria-live="polite">
      {state?.ok === true ? (
        <p role="status" className="text-[14px] font-semibold text-ds-success-ink">
          {done}
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

async function assign(_prev: ActionResult | null, formData: FormData): Promise<ActionResult | null> {
  return assignTransferAction(formData);
}

/** Assign to one of the tenant's own admins or agents, or to nobody. Usernames and names only. */
export function AssignForm({ id, options, current }: { id: string; options: StaffOption[]; current: string | null }) {
  const [state, formAction, pending] = useActionState(assign, null);
  return (
    <form action={formAction} className="flex flex-col gap-3" data-testid="partner-assign-form">
      <input type="hidden" name="id" value={id} />
      <Field name="assignee" label={t('partner.transferOps.assign.label')}>
        {({ id: fieldId, describedBy }) => (
          <Select id={fieldId} name="assignee" defaultValue={current ?? ''} aria-describedby={describedBy}>
            <option value="">{t('partner.transferOps.assign.nobody')}</option>
            {options.map((o) => (
              <option key={o.username} value={o.username}>
                {o.name} ({o.username})
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field name="assignNote" label={t('partner.transferOps.assign.note')} hint={t('partner.transferOps.assign.noteHint')}>
        {({ id: fieldId, describedBy }) => <Input id={fieldId} name="assignNote" maxLength={500} autoComplete="off" aria-describedby={describedBy} />}
      </Field>
      <div>
        <Button type="submit" size="md" disabled={pending}>
          {pending ? t('partner.transferOps.assign.saving') : t('partner.transferOps.assign.save')}
        </Button>
      </div>
      <Result state={state} done={t('partner.transferOps.assign.done')} />
    </form>
  );
}

async function resend(_prev: ActionResult | null, formData: FormData): Promise<ActionResult | null> {
  return resendPayLinkAction(formData);
}

/** Queue the payment link again on WhatsApp (the outbox sends it from the partner's own number). */
export function ResendForm({ id }: { id: string }) {
  const [state, formAction, pending] = useActionState(resend, null);
  return (
    <form action={formAction} className="flex flex-col gap-2" data-testid="partner-resend-form">
      <input type="hidden" name="id" value={id} />
      <p className="text-[13px] text-ds-ink-muted">{t('partner.transferOps.resend.hint')}</p>
      <div>
        <Button type="submit" size="md" variant="ghost" disabled={pending}>
          {pending ? t('partner.transferOps.resend.sending') : t('partner.transferOps.resend.button')}
        </Button>
      </div>
      <Result state={state} done={t('partner.transferOps.resend.queued')} />
    </form>
  );
}
