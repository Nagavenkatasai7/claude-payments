'use client';

import { useActionState } from 'react';
import { t } from '@/lib/i18n';
import { Button, Field, Input, Select } from '@/components/ds';
import { INVITE_ROLES } from '@/lib/staff-invite-input';
import type { ActionResult } from '../../action-result';
import { inviteStaffAction } from './actions';

// The invite form (UI redesign M3-8). A plain <form action>: the server action re-gates, takes the
// tenant from the session and re-validates every field, so nothing here is trusted. There is no
// tenant field. The form resets after a successful send (React resets uncontrolled form fields
// once a form action completes).

async function submit(_prev: ActionResult | null, formData: FormData): Promise<ActionResult | null> {
  return inviteStaffAction(formData);
}

export function InviteForm() {
  const [state, formAction, pending] = useActionState(submit, null);
  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-2" data-testid="partner-staff-invite-form">
      <Field name="email" label={t('partner.staff.fieldEmail')}>
        {(ids) => (
          <Input id={ids.id} name="email" type="email" required maxLength={254} autoComplete="off" aria-describedby={ids.describedBy} />
        )}
      </Field>
      <Field name="name" label={t('partner.staff.fieldName')}>
        {(ids) => <Input id={ids.id} name="name" required maxLength={80} autoComplete="off" aria-describedby={ids.describedBy} />}
      </Field>
      <Field name="username" label={t('partner.staff.fieldUsername')} hint={t('partner.staff.fieldUsernameHint')}>
        {(ids) => (
          <Input
            id={ids.id}
            name="username"
            required
            minLength={3}
            maxLength={64}
            pattern="[a-z0-9._\-]{3,64}"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            aria-describedby={ids.describedBy}
          />
        )}
      </Field>
      <Field name="role" label={t('partner.staff.fieldRole')}>
        {(ids) => (
          <Select id={ids.id} name="role" required defaultValue="agent" aria-describedby={ids.describedBy}>
            {INVITE_ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`partner.staff.role.${r}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <ul className="flex flex-col gap-1 text-[13px] text-ds-ink-muted sm:col-span-2">
        {INVITE_ROLES.map((r) => (
          <li key={r}>{t(`partner.staff.roleHint.${r}`)}</li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <Button type="submit" size="md" disabled={pending}>
          {pending ? t('partner.staff.inviteSending') : t('partner.staff.inviteSubmit')}
        </Button>
        <div aria-live="polite">
          {state?.ok === true ? (
            <p role="status" className="text-[14px] font-semibold text-ds-success-ink">
              {t('partner.staff.invited')}
            </p>
          ) : null}
          {state && state.ok === false ? (
            <p role="alert" className="text-[14px] font-semibold text-ds-danger-ink">
              {state.error}
            </p>
          ) : null}
        </div>
      </div>
    </form>
  );
}
