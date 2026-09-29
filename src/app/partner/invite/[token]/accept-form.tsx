'use client';

import { useActionState } from 'react';
import { t } from '@/lib/i18n';
import { Button, Field, Input } from '@/components/ds';
import { acceptInviteAction } from './actions';
import type { AcceptInviteResult } from './accept-result';
import { DeadInvite } from './dead-invite';

// The invite acceptance form (UI redesign M3-9). The ONLY fields the action reads are the token (a
// hidden input) and the two passwords. The username shown here is display-only (no name attribute):
// the account's username, name, role and tenant all come from the stored invite, never this form.
// A dead result swaps the whole form for the one dead sheet; a password problem stays on the form.

async function submit(_prev: AcceptInviteResult | null, formData: FormData): Promise<AcceptInviteResult | null> {
  return acceptInviteAction(formData);
}

export function AcceptForm({
  token,
  username,
  title,
  roleLabel,
}: {
  token: string;
  username: string;
  title: string;
  roleLabel: string;
}) {
  const [state, formAction, pending] = useActionState(submit, null);
  if (state && 'dead' in state) return <DeadInvite />;
  const error = state && 'error' in state ? state.error : undefined;
  // The header lives here, not in the page, so a dead result replaces the WHOLE card body (one <h1>).
  return (
    <>
    <div className="mb-6 flex flex-col gap-2">
      <h1 className="text-[24px] font-semibold tracking-tight text-ds-ink">{title}</h1>
      <p className="text-[15px] text-ds-ink-muted">{t('partner.invite.sub')}</p>
      <p className="text-[14px] text-ds-ink">
        <span className="font-semibold">{t('partner.invite.role')}:</span> {roleLabel}
      </p>
    </div>
    <form action={formAction} className="flex flex-col gap-4" data-testid="partner-invite-form">
      <input type="hidden" name="token" value={token} />
      <Field name="invite-username" label={t('partner.invite.username')}>
        {(ids) => (
          <Input id={ids.id} type="text" value={username} readOnly autoComplete="username" aria-describedby={ids.describedBy} />
        )}
      </Field>
      <Field name="password" label={t('partner.invite.password')} hint={t('partner.invite.passwordHint')} error={error}>
        {(ids) => (
          <Input
            id={ids.id}
            name="password"
            type="password"
            required
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
            aria-describedby={ids.describedBy}
            invalid={ids.invalid}
          />
        )}
      </Field>
      <Field name="confirm" label={t('partner.invite.confirm')}>
        {(ids) => (
          <Input
            id={ids.id}
            name="confirm"
            type="password"
            required
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
            aria-describedby={ids.describedBy}
          />
        )}
      </Field>
      <p className="text-[13px] text-ds-ink-muted">{t('partner.invite.next')}</p>
      <div>
        <Button type="submit" size="md" disabled={pending}>
          {pending ? t('partner.invite.submitting') : t('partner.invite.submit')}
        </Button>
      </div>
    </form>
    </>
  );
}
