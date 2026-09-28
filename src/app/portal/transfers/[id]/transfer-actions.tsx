'use client';

import * as React from 'react';
import { useActionState } from 'react';
import { t, type MessageKey } from '@/lib/i18n';
import { Button, Field, Select } from '@/components/ds';
import type { PortalTransferActionState } from './actions';

// The transfer detail's action forms (UI redesign M2-7). Each is a plain <form action> (progressive
// enhancement) carrying the server-minted request key; the result is fixed copy. The bound action
// re-scopes the transfer id on the server: nothing here is trusted.

type BoundAction = (prev: PortalTransferActionState, formData: FormData) => Promise<PortalTransferActionState>;

function Result({ state }: { state: PortalTransferActionState }) {
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

export function ActionForm({
  action,
  requestKey,
  label,
  busyLabel,
  variant = 'ghost',
  children,
}: {
  action: BoundAction;
  requestKey: string;
  label: string;
  busyLabel: string;
  variant?: 'primary' | 'ghost' | 'danger';
  children?: React.ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="requestKey" value={requestKey} />
      {children}
      <div>
        <Button type="submit" variant={variant} size="md" disabled={pending}>
          {pending ? busyLabel : label}
        </Button>
      </div>
      <div aria-live="polite">
        <Result state={state} />
      </div>
    </form>
  );
}

export function RecallForm({
  action,
  requestKey,
  reasons,
}: {
  action: BoundAction;
  requestKey: string;
  reasons: Array<{ value: string; label: MessageKey }>;
}) {
  return (
    <ActionForm action={action} requestKey={requestKey} label={t('portal.detail.recallCta')} busyLabel={t('portal.detail.working')}>
      <Field name="reason" label={t('portal.detail.recallReason')} required>
        {({ id, describedBy }) => (
          <Select id={id} name="reason" required defaultValue="" aria-describedby={describedBy}>
            <option value="" disabled>
              {t('portal.detail.recallChoose')}
            </option>
            {reasons.map((r) => (
              <option key={r.value} value={r.value}>
                {t(r.label)}
              </option>
            ))}
          </Select>
        )}
      </Field>
    </ActionForm>
  );
}
