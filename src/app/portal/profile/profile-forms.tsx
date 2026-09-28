'use client';

import { useActionState } from 'react';
import { t } from '@/lib/i18n';
import { Button, Field, Input } from '@/components/ds';
import {
  beginPortalMfaEnrolmentAction,
  confirmPortalMfaEnrolmentAction,
  startPortalVerificationAction,
  type PortalMfaState,
  type ProfileActionState,
} from './actions';

// The Profile forms (UI redesign M2-11). Plain <form action>s; results are fixed copy keys. The TOTP
// secret is shown once from the action state and never stored by the page.

const MFA_INITIAL: PortalMfaState = { ok: false };
/** "ABCD EFGH …" for manual entry. */
const grouped = (s: string) => s.replace(/(.{4})/g, '$1 ').trim();

function Notice({ state }: { state: { notice?: Parameters<typeof t>[0]; error?: Parameters<typeof t>[0] } | null }) {
  if (state?.notice) {
    return (
      <p role="status" className="text-[14px] font-semibold text-ds-success-ink">
        {t(state.notice)}
      </p>
    );
  }
  if (state?.error) {
    return (
      <p role="alert" className="text-[14px] font-semibold text-ds-danger-ink">
        {t(state.error)}
      </p>
    );
  }
  return null;
}

export function KycStartForm() {
  const [state, action, pending] = useActionState<ProfileActionState, FormData>(startPortalVerificationAction, null);
  return (
    <form action={action} className="flex flex-col gap-3">
      <div>
        <Button type="submit" size="md" disabled={pending}>
          {pending ? t('portal.detail.working') : t('portal.kyc.start_cta')}
        </Button>
      </div>
      <p className="text-[13px] text-ds-ink-muted">{t('portal.kyc.return_note')}</p>
      <div aria-live="polite">
        <Notice state={state} />
      </div>
    </form>
  );
}

export function MfaEnrolForm() {
  const [begun, beginAction, beginning] = useActionState(beginPortalMfaEnrolmentAction, MFA_INITIAL);
  const [confirmed, confirmAction, confirming] = useActionState(confirmPortalMfaEnrolmentAction, MFA_INITIAL);
  if (confirmed.ok) return <Notice state={confirmed} />;
  return (
    <div className="flex flex-col gap-4">
      <form action={beginAction} className="flex flex-col gap-3">
        <div>
          <Button type="submit" variant={begun.ok ? 'ghost' : 'primary'} size="md" disabled={beginning}>
            {beginning ? t('portal.detail.working') : begun.ok ? t('portal.mfa.restart') : t('portal.mfa.start')}
          </Button>
        </div>
        {!begun.ok ? <Notice state={begun} /> : null}
      </form>
      {begun.ok && begun.secret ? (
        <>
          <div className="flex flex-col gap-2 text-[14px] text-ds-ink-muted">
            <p>{t('portal.mfa.key_intro')}</p>
            <p className="break-all rounded-ds-inner border border-ds-border bg-ds-ground px-3 py-2 font-mono tracking-wider text-ds-ink" aria-label={t('portal.mfa.key_label')}>
              {grouped(begun.secret)}
            </p>
            {begun.uri ? (
              <details className="text-[13px]">
                <summary className="cursor-pointer">{t('portal.mfa.link_label')}</summary>
                <p className="mt-1 break-all font-mono">{begun.uri}</p>
              </details>
            ) : null}
          </div>
          <form action={confirmAction} className="flex flex-col gap-3">
            <Field name="code" label={t('portal.login.mfaLabel')} error={confirmed.error ? t(confirmed.error) : undefined} required>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9 ]{6,7}"
                  maxLength={7}
                  required
                  aria-describedby={describedBy}
                  invalid={invalid}
                />
              )}
            </Field>
            <div>
              <Button type="submit" size="md" disabled={confirming}>
                {confirming ? t('portal.login.verifying') : t('portal.mfa.turn_on')}
              </Button>
            </div>
          </form>
        </>
      ) : null}
    </div>
  );
}
