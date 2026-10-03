'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { portalLoginAction, type PortalLoginState } from './actions';
import { t } from '@/lib/i18n';
import { Button, Checkbox, Field, Input } from '@/components/ds';

// The sign-in steps in one form (progressive enhancement: a plain <form action> with the submit
// button's `intent`). The phone is never echoed back: the code step shows only the last 4 digits the
// customer typed. Links to the terms and privacy notice are absolute apex URLs (those pages are not
// served on partner subdomains).
const APEX = 'https://smartremit.ai';
const INITIAL: PortalLoginState = { step: 'phone' };

// `next` is the page to land on after sign-in (already allow-listed by the page; the actions check it
// again). Every step's form carries it, so it survives the code, authenticator and consent steps.
export function LoginForm({ brand, next }: { brand: string; next: string }) {
  const [state, action, busy] = useActionState(portalLoginAction, INITIAL);
  const error = state.error ? t(state.error) : undefined;
  const nextField = <input type="hidden" name="next" value={next} />;
  const startOver = next === '/portal' ? '/portal/login' : `/portal/login?next=${encodeURIComponent(next)}`;

  if (state.step === 'code') {
    return (
      <form action={action} className="flex flex-col gap-5">
        <input type="hidden" name="pending" value={state.pending ?? ''} />
        {nextField}
        {state.notice ? (
          <p role="status" className="text-[15px] text-ds-ink-muted">
            {t(state.notice, { last4: state.last4 ?? '' })}
          </p>
        ) : null}
        <Field name="code" label={t('portal.login.codeLabel')} error={error} required>
          {({ id, describedBy, invalid }) => (
            <Input id={id} name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6}
              required aria-describedby={describedBy} invalid={invalid} />
          )}
        </Field>
        <Button type="submit" name="intent" value="verify" disabled={busy}>
          {busy ? t('portal.login.verifying') : t('portal.login.verify')}
        </Button>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button type="submit" name="intent" value="resend" variant="link" size="md" formNoValidate disabled={busy}>
            {t('portal.login.resend')}
          </Button>
          <Link href={startOver} className="text-[14px] font-semibold text-ds-primary">
            {t('portal.login.startOver')}
          </Link>
        </div>
      </form>
    );
  }

  if (state.step === 'mfa') {
    return (
      <form action={action} className="flex flex-col gap-5">
        <input type="hidden" name="pending" value={state.pending ?? ''} />
        {nextField}
        <Field name="code" label={t('portal.login.mfaLabel')} error={error} required>
          {({ id, describedBy, invalid }) => (
            <Input id={id} name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6}
              required aria-describedby={describedBy} invalid={invalid} />
          )}
        </Field>
        <Button type="submit" name="intent" value="mfa" disabled={busy}>
          {busy ? t('portal.login.verifying') : t('portal.login.verify')}
        </Button>
      </form>
    );
  }

  if (state.step === 'consent') {
    return (
      <form action={action} className="flex flex-col gap-5">
        <input type="hidden" name="pending" value={state.pending ?? ''} />
        {nextField}
        <h2 className="text-[17px] font-semibold text-ds-ink">{t('portal.login.consentTitle')}</h2>
        <p className="text-[15px] text-ds-ink-muted">{t('portal.login.consentIntro')}</p>
        <Checkbox name="consent" value="yes" required label={t('portal.login.consentLabel', { brand })} error={error} />
        <p className="flex gap-4 text-[14px]">
          <a href={`${APEX}/terms`} target="_blank" rel="noopener noreferrer" className="font-semibold text-ds-primary underline">
            {t('portal.login.termsLink')}
          </a>
          <a href={`${APEX}/privacy`} target="_blank" rel="noopener noreferrer" className="font-semibold text-ds-primary underline">
            {t('portal.login.privacyLink')}
          </a>
        </p>
        <Button type="submit" name="intent" value="consent" disabled={busy}>
          {t('portal.login.verify')}
        </Button>
      </form>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-5">
      {nextField}
      <Field name="phone" label={t('portal.login.phoneLabel')} hint={t('portal.login.phoneHint')} error={error} required>
        {({ id, describedBy, invalid }) => (
          <Input id={id} name="phone" type="tel" inputMode="tel" autoComplete="tel" required aria-describedby={describedBy} invalid={invalid} />
        )}
      </Field>
      <Button type="submit" name="intent" value="request" disabled={busy}>
        {busy ? t('portal.login.sending') : t('portal.login.sendCode')}
      </Button>
    </form>
  );
}
