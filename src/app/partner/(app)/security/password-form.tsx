'use client';

import { useActionState } from 'react';
import { t } from '@/lib/i18n';
import { Button, Field, Input } from '@/components/ds';
import { changePasswordAction } from './password-actions';

// Lost-features A14: change your own password. The action returns the shared ActionResult, so every
// refusal (wrong current password, policy, throttle, a concurrent change) is shown, never swallowed.
export function PasswordForm() {
  const [state, formAction, pending] = useActionState(changePasswordAction, null);
  const error = state && !state.ok ? state.error : undefined;
  return (
    <form action={formAction} className="flex max-w-md flex-col gap-4" data-testid="partner-password-form">
      <Field name="currentPassword" label={t('partner.security.password.current')} required>
        {({ id, describedBy, invalid }) => (
          <Input id={id} name="currentPassword" type="password" required autoComplete="current-password" aria-describedby={describedBy} invalid={invalid} />
        )}
      </Field>
      <Field name="newPassword" label={t('partner.security.password.new')} hint={t('partner.security.password.newHint')} required>
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            name="newPassword"
            type="password"
            required
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </Field>
      <Field name="confirmPassword" label={t('partner.security.password.confirm')} error={error} required>
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            name="confirmPassword"
            type="password"
            required
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </Field>
      <div>
        <Button type="submit" variant="primary" size="md" disabled={pending}>
          {pending ? t('partner.security.password.submitting') : t('partner.security.password.submit')}
        </Button>
      </div>
      {state?.ok ? (
        <p role="status" className="text-[15px] text-ds-ink">
          {t('partner.security.password.done')}
        </p>
      ) : null}
    </form>
  );
}
