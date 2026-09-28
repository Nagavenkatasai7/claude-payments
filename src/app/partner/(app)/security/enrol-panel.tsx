'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import {
  beginMfaEnrolmentAction,
  confirmMfaEnrolmentAction,
  type MfaEnrolState,
} from '@/app/admin-dashboard/account/actions';
import { t } from '@/lib/i18n';
import { Button, Field, Input, buttonVariants } from '@/components/ds';

// The partner-app enrolment panel. It reuses the existing self-gated action pair: step 1 re-proves
// the current password (rate-limited on the sign-in guard) and returns a fresh secret shown once;
// step 2 turns it on with one code (audited as auth.mfa.enroll). Both act only on the session's own
// username. The secret lives only in this component's state and is never stored by the page.

const INITIAL: MfaEnrolState = { ok: false };

/** "ABCD EFGH …" for manual entry. */
const grouped = (s: string) => s.replace(/(.{4})/g, '$1 ').trim();

export function EnrolPanel() {
  const [begun, beginAction, beginning] = useActionState(beginMfaEnrolmentAction, INITIAL);
  const [confirmed, confirmAction, confirming] = useActionState(confirmMfaEnrolmentAction, INITIAL);

  if (confirmed.ok) {
    return (
      <div className="flex flex-col items-start gap-4">
        <p role="status" className="text-[15px] text-ds-ink">
          {confirmed.message}
        </p>
        <Link href="/partner" className={buttonVariants({ variant: 'primary', size: 'md' })}>
          {t('partner.security.continue')}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex max-w-md flex-col gap-6">
      <form action={beginAction} className="flex flex-col gap-4">
        <Field
          name="currentPassword"
          label={t('partner.security.passwordLabel')}
          error={!begun.ok && begun.message ? begun.message : undefined}
          required
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              name="currentPassword"
              type="password"
              required
              autoComplete="current-password"
              aria-describedby={describedBy}
              invalid={invalid}
            />
          )}
        </Field>
        <div>
          <Button type="submit" variant={begun.ok ? 'ghost' : 'primary'} size="md" disabled={beginning}>
            {beginning
              ? t('partner.security.starting')
              : begun.ok
                ? t('partner.security.restart')
                : t('partner.security.start')}
          </Button>
        </div>
      </form>

      {begun.ok && begun.secret ? (
        <form action={confirmAction} className="flex flex-col gap-4">
          <p className="text-[15px] leading-relaxed text-ds-ink-muted">{t('partner.security.keyIntro')}</p>
          <p
            aria-label={t('partner.security.keyLabel')}
            className="rounded-ds-inner border border-ds-border bg-ds-tint px-4 py-3 font-mono text-[15px] tracking-wider break-all text-ds-ink"
          >
            {grouped(begun.secret)}
          </p>
          {begun.uri ? (
            <details className="text-[13px] text-ds-ink-muted">
              <summary className="cursor-pointer">{t('partner.security.uriSummary')}</summary>
              <p className="mt-1 font-mono break-all">{begun.uri}</p>
            </details>
          ) : null}
          <Field
            name="code"
            label={t('partner.security.codeLabel')}
            error={!confirmed.ok && confirmed.message ? confirmed.message : undefined}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                name="code"
                required
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9 ]{6,7}"
                maxLength={7}
                aria-describedby={describedBy}
                invalid={invalid}
                className="max-w-48"
              />
            )}
          </Field>
          <div>
            <Button type="submit" size="md" disabled={confirming}>
              {confirming ? t('partner.security.confirming') : t('partner.security.confirm')}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
