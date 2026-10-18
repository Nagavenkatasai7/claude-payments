'use client';

import { useActionState } from 'react';
import { t } from '@/lib/i18n';
import { Button } from '@/components/ds';
import type { AgentAppActionState } from './actions';

// One app's "Disconnect" button (Stage C1). A plain <form action> (progressive enhancement) that
// posts the opaque grant id; the server re-scopes it to the signed-in customer's own grants, so
// nothing here is trusted. The result is fixed copy.

type Action = (prev: AgentAppActionState, formData: FormData) => Promise<AgentAppActionState>;

export function DisconnectApp({ action, grantId, appLabel }: { action: Action; grantId: string; appLabel: string }) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className="flex flex-col items-start gap-2 sm:items-end">
      <input type="hidden" name="grant" value={grantId} />
      <Button type="submit" variant="ghost" size="sm" disabled={pending} aria-label={`${t('portal.agentApps.disconnect')}: ${appLabel}`}>
        {pending ? t('portal.agentApps.disconnecting') : t('portal.agentApps.disconnect')}
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
