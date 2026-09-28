'use client';

import { useActionState } from 'react';
import { t, type MessageKey } from '@/lib/i18n';
import { Button, Field, Input } from '@/components/ds';
import {
  setEmailReceiptsAction,
  setWhatsappNotificationsAction,
  updateEmailAction,
  type NotificationsActionState,
} from './actions';

// The Notifications forms (UI redesign M2-11). Plain <form action>s carrying only the choice, the new
// address and the server-minted request key; the server re-derives everything else.

function Result({ state }: { state: { notice?: MessageKey; error?: MessageKey } | null }) {
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

function Toggle({
  action,
  on,
  onLabel,
  offLabel,
}: {
  action: (prev: NotificationsActionState, fd: FormData) => Promise<NotificationsActionState>;
  on: boolean;
  onLabel: string;
  offLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="on" value={on ? '0' : '1'} />
      <div>
        <Button type="submit" variant={on ? 'ghost' : 'primary'} size="md" disabled={pending}>
          {pending ? t('portal.detail.working') : on ? offLabel : onLabel}
        </Button>
      </div>
      <div aria-live="polite">
        <Result state={state} />
      </div>
    </form>
  );
}

export function WhatsappToggleForm({ on }: { on: boolean }) {
  return <Toggle action={setWhatsappNotificationsAction} on={on} onLabel={t('portal.notify.wa_turn_on')} offLabel={t('portal.notify.wa_turn_off')} />;
}

export function ReceiptsToggleForm({ on }: { on: boolean }) {
  return (
    <Toggle action={setEmailReceiptsAction} on={on} onLabel={t('portal.notify.receipts_turn_on')} offLabel={t('portal.notify.receipts_turn_off')} />
  );
}

export function EmailForm({ requestKey, hasEmail }: { requestKey: string; hasEmail: boolean }) {
  const [state, formAction, pending] = useActionState(updateEmailAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="requestKey" value={requestKey} />
      <Field name="email" label={t(hasEmail ? 'portal.email.change_label' : 'portal.email.add_label')} hint={t('portal.email.hint')} required>
        {({ id, describedBy, invalid }) => (
          <Input id={id} name="email" type="email" autoComplete="email" maxLength={254} required aria-describedby={describedBy} invalid={invalid} />
        )}
      </Field>
      <div>
        <Button type="submit" size="md" disabled={pending}>
          {pending ? t('portal.detail.working') : t('portal.email.send_link')}
        </Button>
      </div>
      <div aria-live="polite">
        <Result state={state} />
      </div>
    </form>
  );
}
