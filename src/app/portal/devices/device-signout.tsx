'use client';

import { useActionState } from 'react';
import { t } from '@/lib/i18n';
import { Button } from '@/components/ds';
import type { PortalDeviceActionState } from './actions';

// One device's "Sign out" button (UI redesign M2-13). A plain <form action> (progressive
// enhancement) that posts the opaque sid; the server re-scopes it to the signed-in customer's own
// device index, so nothing here is trusted. The result is fixed copy.

type Action = (prev: PortalDeviceActionState, formData: FormData) => Promise<PortalDeviceActionState>;

export function DeviceSignOut({ action, sid, deviceLabel }: { action: Action; sid: string; deviceLabel: string }) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className="flex flex-col items-start gap-2 sm:items-end">
      <input type="hidden" name="sid" value={sid} />
      <Button type="submit" variant="ghost" size="sm" disabled={pending} aria-label={`${t('portal.devices.signOutOne')}: ${deviceLabel}`}>
        {pending ? t('portal.devices.signingOut') : t('portal.devices.signOutOne')}
      </Button>
      <div aria-live="polite">
        {state?.notice ? (
          <p role="status" className="text-[13px] font-semibold text-ds-success-ink">
            {t(state.notice)}
          </p>
        ) : null}
        {state?.error ? (
          <p role="alert" className="text-[13px] font-semibold text-ds-danger-ink">
            {t(state.error)}
          </p>
        ) : null}
      </div>
    </form>
  );
}
