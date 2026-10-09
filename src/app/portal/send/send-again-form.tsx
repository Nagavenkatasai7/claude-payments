'use client';

import { useActionState } from 'react';
import { t } from '@/lib/i18n';
import { Button } from '@/components/ds';
import type { TransferPurpose } from '@/lib/types';
import type { ContinueState } from './actions';
import { KycCard, SendAlert } from './kyc-card';
import { PurposeFields } from './purpose-fields';
import { ScamWarning } from './scam-warning';

// "Send again" on the transfer detail (UI redesign M2-9, Task 9.4). The bound action re-scopes the
// transfer id on the server; this form carries the server-minted request key and the purpose for
// THIS send (required, owner decision 2026-10-08). The select starts on the last transfer's purpose
// (Q1: offered as the default, in plain sight, so submitting it is the customer's yes); a transfer
// with none starts on "Choose a reason".
//
// Batch B follow-up A3: when the last transfer carried the customer's own reason (only ever given with
// Other), the form starts on Other with those words (the owner's own words, read for them only); the
// server applies the rule again, so a reason that named a purpose becomes that purpose again. A4: a
// reason that matches a scam pattern comes back with the warning and the required tick.
export function SendAgainForm({
  action,
  requestKey,
  lastPurpose,
  lastPurposeDetail,
}: {
  action: (prev: ContinueState, formData: FormData) => Promise<ContinueState>;
  requestKey: string;
  lastPurpose?: TransferPurpose;
  lastPurposeDetail?: string;
}) {
  const [state, formAction, pending] = useActionState(action, { requestKey } satisfies ContinueState);
  const purpose = state.values ? state.values.purpose : lastPurposeDetail ? 'other' : (lastPurpose ?? '');
  const purposeDetail = state.values ? state.values.purpose_detail : lastPurposeDetail;
  const detailError = state.error === 'portal.send.purpose_detail_invalid' || state.error === 'portal.send.purpose_detail_too_long'
    ? t(state.error) : undefined;
  const ackError = state.error === 'portal.send.scam_ack_required' ? t(state.error) : undefined;
  return (
    <form action={formAction} className="flex flex-col gap-3" noValidate>
      <input type="hidden" name="requestKey" value={state.requestKey} />
      <PurposeFields key={`purpose-${state.requestKey}`} purpose={purpose} purposeDetail={purposeDetail} detailError={detailError} />
      {state.scamWarning ? <ScamWarning key={`ack-${state.requestKey}`} error={ackError} /> : null}
      <div>
        <Button type="submit" variant="ghost" size="md" disabled={pending}>
          {pending ? t('portal.send.continuing') : t('portal.send.sendAgainCta')}
        </Button>
      </div>
      <div aria-live="polite">
        {state.error && !detailError && !ackError ? (
          state.kyc ? <KycCard kind={state.kyc} message={t(state.error, state.vars)} /> : <SendAlert message={t(state.error, state.vars)} />
        ) : null}
      </div>
    </form>
  );
}
