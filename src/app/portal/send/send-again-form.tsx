'use client';

import { useActionState } from 'react';
import { t } from '@/lib/i18n';
import { Button, Field, Select } from '@/components/ds';
import { PURPOSE_LABELS, TRANSFER_PURPOSES } from '@/lib/purpose-codes';
import type { TransferPurpose } from '@/lib/types';
import type { ContinueState } from './actions';
import { KycCard, SendAlert } from './kyc-card';

// "Send again" on the transfer detail (UI redesign M2-9, Task 9.4). The bound action re-scopes the
// transfer id on the server; this form carries the server-minted request key and the purpose for
// THIS send (required, owner decision 2026-10-08). The select starts on the last transfer's purpose
// (Q1: offered as the default, in plain sight, so submitting it is the customer's yes); a transfer
// with none starts on "Choose a reason".
export function SendAgainForm({
  action,
  requestKey,
  lastPurpose,
}: {
  action: (prev: ContinueState, formData: FormData) => Promise<ContinueState>;
  requestKey: string;
  lastPurpose?: TransferPurpose;
}) {
  const [state, formAction, pending] = useActionState(action, { requestKey } satisfies ContinueState);
  return (
    <form action={formAction} className="flex flex-col gap-3" noValidate>
      <input type="hidden" name="requestKey" value={state.requestKey} />
      <Field name="purpose" label={t('portal.send.purposeLabel')} required>
        {({ id, describedBy }) => (
          <Select id={id} name="purpose" defaultValue={lastPurpose ?? ''} required aria-describedby={describedBy}>
            <option value="" disabled>{t('portal.send.purposePlaceholder')}</option>
            {TRANSFER_PURPOSES.map((p) => (
              <option key={p} value={p}>{PURPOSE_LABELS[p]}</option>
            ))}
          </Select>
        )}
      </Field>
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
