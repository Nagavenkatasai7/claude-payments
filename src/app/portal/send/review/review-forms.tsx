'use client';

import { useActionState } from 'react';
import { t } from '@/lib/i18n';
import { Button, Field, Input } from '@/components/ds';
import { continueToPayAction, setSenderNameAction, type ContinueState, type NameFormState } from '../actions';
import { KycCard, SendAlert } from '../kyc-card';
import { ScamWarning } from '../scam-warning';

// The review step's forms (UI redesign M2-9). Continue carries only the server-minted request key and
// the review id: the amount, rate and fees are re-derived on the server, never posted.

// Batch B follow-up A4: `scamWarning` (decided on the server from the review's reason) shows the
// warning with the required "I have read this warning" tick; the action refuses without it.
export function ContinueForm({ rv, requestKey, scamWarning = false }: { rv: string; requestKey: string; scamWarning?: boolean }) {
  const [state, action, busy] = useActionState(continueToPayAction, { requestKey } satisfies ContinueState);
  const ackError = state.error === 'portal.send.scam_ack_required' ? t(state.error) : undefined;
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="requestKey" value={state.requestKey} />
      <input type="hidden" name="rv" value={rv} />
      {scamWarning ? <ScamWarning key={`ack-${state.requestKey}`} error={ackError} /> : null}
      <div aria-live="polite">
        {state.error && !ackError ? (
          state.kyc ? <KycCard kind={state.kyc} message={t(state.error, state.vars)} /> : <SendAlert message={t(state.error, state.vars)} />
        ) : null}
      </div>
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? t('portal.send.continuing') : t('portal.send.continue')}
        </Button>
      </div>
    </form>
  );
}

export function NameForm() {
  const [state, action, busy] = useActionState(setSenderNameAction, {} satisfies NameFormState);
  return (
    <form action={action} className="flex flex-col gap-4">
      <Field name="fullName" label={t('portal.send.legalNameLabel')} error={state.error ? t(state.error) : undefined} required>
        {({ id, describedBy, invalid }) => (
          <Input id={id} name="fullName" autoComplete="name" maxLength={80} required aria-describedby={describedBy} invalid={invalid} />
        )}
      </Field>
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? t('portal.send.nameSaving') : t('portal.send.nameSave')}
        </Button>
      </div>
    </form>
  );
}
