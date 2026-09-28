'use client';

import { useActionState } from 'react';
import { t } from '@/lib/i18n';
import { Button, Field, Input, Select } from '@/components/ds';
import { dsCn } from '@/lib/ui/ds-cn';
import type { PortalTicketState } from './actions';

// The Help & tickets forms (UI redesign M2-12). Plain <form action> (progressive enhancement) carrying
// the server-minted request key; results are fixed copy keys. Nothing here is trusted: the actions
// re-derive the partner and phone from the host and the session and re-scope every id.

type Action = (prev: PortalTicketState, formData: FormData) => Promise<PortalTicketState>;

const TEXTAREA =
  'min-h-[140px] w-full rounded-ds-inner border border-ds-border-input bg-ds-surface px-4 py-3 text-[15px] text-ds-ink placeholder:text-ds-ink-subtle aria-[invalid=true]:border-ds-danger-ink focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring';

function FormError({ state }: { state: PortalTicketState }) {
  return (
    <div aria-live="polite">
      {state?.error ? (
        <p role="alert" className="text-[14px] font-semibold text-ds-danger-ink">
          {t(state.error)}
        </p>
      ) : null}
    </div>
  );
}

export interface TransferChoice {
  id: string;
  label: string;
}

export function NewTicketForm({ action, requestKey, transfers }: { action: Action; requestKey: string; transfers: TransferChoice[] }) {
  const [state, formAction, pending] = useActionState(action, null);
  const err = state?.error;
  return (
    <form action={formAction} className="flex flex-col gap-5">
      <input type="hidden" name="requestKey" value={requestKey} />
      <Field name="subject" label={t('portal.help.new.subjectLabel')} hint={t('portal.help.new.subjectHint')} error={err === 'portal.help.error.subject' ? t(err) : undefined} required>
        {({ id, describedBy, invalid }) => (
          <Input id={id} name="subject" required minLength={3} maxLength={120} autoComplete="off" aria-describedby={describedBy} invalid={invalid} />
        )}
      </Field>
      <Field name="message" label={t('portal.help.new.messageLabel')} hint={t('portal.help.new.messageHint')} error={err === 'portal.help.error.message' ? t(err) : undefined} required>
        {({ id, describedBy, invalid }) => (
          <textarea
            id={id}
            name="message"
            required
            minLength={10}
            maxLength={2000}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            className={TEXTAREA}
          />
        )}
      </Field>
      {transfers.length > 0 ? (
        <Field name="transferId" label={t('portal.help.new.transferLabel')} error={err === 'portal.help.error.transfer' ? t(err) : undefined}>
          {({ id, describedBy, invalid }) => (
            <Select id={id} name="transferId" defaultValue="" aria-describedby={describedBy} invalid={invalid}>
              <option value="">{t('portal.help.new.transferNone')}</option>
              {transfers.map((tr) => (
                <option key={tr.id} value={tr.id}>
                  {tr.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}
      <p className="rounded-ds-inner border border-ds-warning-border bg-ds-warning-bg px-4 py-3 text-[14px] text-ds-warning-ink">{t('portal.help.new.warning')}</p>
      {err && !['portal.help.error.subject', 'portal.help.error.message', 'portal.help.error.transfer'].includes(err) ? <FormError state={state} /> : null}
      <div>
        <Button type="submit" size="md" disabled={pending}>
          {pending ? t('portal.help.working') : t('portal.help.new.submit')}
        </Button>
      </div>
    </form>
  );
}

export function ReplyForm({ action, requestKey }: { action: Action; requestKey: string }) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="requestKey" value={requestKey} />
      <Field name="message" label={t('portal.help.thread.replyLabel')}>
        {({ id, describedBy }) => (
          <textarea id={id} name="message" required maxLength={2000} aria-describedby={describedBy} className={dsCn(TEXTAREA, 'min-h-[110px]')} />
        )}
      </Field>
      <FormError state={state} />
      <div>
        <Button type="submit" size="md" disabled={pending}>
          {pending ? t('portal.help.working') : t('portal.help.thread.replySubmit')}
        </Button>
      </div>
    </form>
  );
}
