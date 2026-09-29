'use client';

import * as React from 'react';
import { t } from '@/lib/i18n';
import { Button, Field, Input } from '@/components/ds';
import { isStepUpRequired, withStepUpSecret, withoutStepUpSecret, type StepUpRequired } from '@/lib/staff-step-up-result';

// The /partner 15-minute step-up, client side (M3-14 follow-up). An action that needs a fresh
// re-authentication returns the typed step_up_required result; the control shows StepUpPrompt
// (the TOTP code for an enrolled account, else the password) and retries the SAME submission with
// the secret added. The server runs the action in that retry's request, so a key / secret reveal
// still comes from exactly one result. The kept submission never holds the secret, and the secret
// is never written to storage or the URL.

/**
 * Wraps a server action call: `run` is the form / dialog action, `retry(secret)` re-sends the last
 * submission with the step-up secret, `dismiss` clears the result.
 */
export function useStepUpAction<R>(call: (fd: FormData) => Promise<R>) {
  const [result, setResult] = React.useState<R | null>(null);
  const last = React.useRef<FormData | null>(null);
  const [retrying, startRetry] = React.useTransition();
  const run = async (fd: FormData) => {
    last.current = withoutStepUpSecret(fd);
    setResult(await call(fd));
  };
  const retry = (secret: string) => {
    const base = last.current;
    if (!base) return;
    startRetry(async () => {
      const r = await call(withStepUpSecret(base, secret));
      startRetry(() => setResult(r));
    });
  };
  const dismiss = () => setResult(null);
  return { result, run, retry, retrying, dismiss, stepUp: isStepUpRequired(result) ? result : null };
}

/** The inline re-verify: its own form (never nested in the control's form). */
export function StepUpPrompt({
  stepUp,
  onSubmit,
  onCancel,
  pending,
}: {
  stepUp: StepUpRequired;
  onSubmit: (secret: string) => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const totp = stepUp.factor === 'totp';
  const [value, setValue] = React.useState('');
  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const secret = value;
    setValue(''); // the input never keeps the secret after a submit
    if (secret) onSubmit(secret);
  };
  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-3 rounded-ds-inner border border-ds-border bg-ds-surface p-4" data-testid="partner-step-up">
      <p className="text-[15px] font-semibold text-ds-ink">{t('partner.stepUp.title')}</p>
      <p role="alert" className="text-[14px] leading-relaxed text-ds-ink-muted">
        {stepUp.error}
      </p>
      <Field name="stepUpSecret" label={t(totp ? 'partner.stepUp.label.totp' : 'partner.stepUp.label.password')} hint={totp ? t('partner.stepUp.hint.totp') : undefined}>
        {(ids) => (
          <Input
            id={ids.id}
            aria-describedby={ids.describedBy}
            type={totp ? 'text' : 'password'}
            inputMode={totp ? 'numeric' : undefined}
            autoComplete={totp ? 'one-time-code' : 'current-password'}
            pattern={totp ? '[0-9 ]*' : undefined}
            maxLength={totp ? 8 : 128}
            spellCheck={false}
            required
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" size="md" disabled={pending}>
          {pending ? t('partner.stepUp.verifying') : t('partner.stepUp.submit')}
        </Button>
        <Button type="button" variant="ghost" size="md" onClick={onCancel} disabled={pending}>
          {t('partner.stepUp.cancel')}
        </Button>
      </div>
    </form>
  );
}
