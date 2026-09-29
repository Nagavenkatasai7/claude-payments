'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { t } from '@/lib/i18n';
import { Button } from '@/components/ds';
import { verifyEmailAction } from './actions';

// The POST-confirm for the verify link: the token travels only in this form's hidden field.
export function VerifyEmailForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(verifyEmailAction, null);
  if (state?.notice) {
    return (
      <div className="flex flex-col gap-3">
        <p role="status" className="text-[15px] font-semibold text-ds-success-ink">
          {t(state.notice)}
        </p>
        <Link href="/portal/notifications" className="text-[14.5px] font-semibold text-ds-primary hover:underline">
          {t('portal.email.back_to_notifications')}
        </Link>
      </div>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="token" value={token} />
      <div>
        <Button type="submit" size="md" disabled={pending}>
          {pending ? t('portal.detail.working') : t('portal.email.verify_cta')}
        </Button>
      </div>
      {state?.error ? (
        <p role="alert" className="text-[14px] font-semibold text-ds-danger-ink">
          {t(state.error)}
        </p>
      ) : null}
    </form>
  );
}
