'use client';

import { useActionState } from 'react';
import { t } from '@/lib/i18n';
import { Button } from '@/components/ds';
import type { ContinueState } from './actions';
import { KycCard, SendAlert } from './kyc-card';

// "Send again" on the transfer detail (UI redesign M2-9, Task 9.4). The bound action re-scopes the
// transfer id on the server; this form carries only the server-minted request key.
export function SendAgainForm({
  action,
  requestKey,
}: {
  action: (prev: ContinueState, formData: FormData) => Promise<ContinueState>;
  requestKey: string;
}) {
  const [state, formAction, pending] = useActionState(action, { requestKey } satisfies ContinueState);
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="requestKey" value={state.requestKey} />
      <div>
        <Button type="submit" variant="ghost" size="md" disabled={pending}>
          {pending ? t('portal.send.continuing') : t('portal.send.sendAgainCta')}
        </Button>
      </div>
      <div aria-live="polite">
        {state.error ? (
          state.kyc ? <KycCard kind={state.kyc} message={t(state.error, state.vars)} /> : <SendAlert message={t(state.error, state.vars)} />
        ) : null}
      </div>
    </form>
  );
}
