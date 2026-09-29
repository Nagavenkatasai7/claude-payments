'use client';

import { useActionState } from 'react';
import { t } from '@/lib/i18n';
import { Button, Field, Input } from '@/components/ds';
import type { ActionResult } from '../../../action-result';
import { contactSmartRemitAction } from './actions';

// "Contact SmartRemit" new-thread form (UI redesign M3-19). The action takes the tenant and the
// opener from the session; the request key (server-minted) makes a double submit open one thread.
// On success the action redirects to the new thread.

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring';
const TEXTAREA = `min-h-[140px] w-full rounded-ds-inner border border-ds-border-input bg-ds-surface px-4 py-3 text-[15px] text-ds-ink placeholder:text-ds-ink-subtle ${FOCUS}`;

async function submit(_prev: ActionResult | null, fd: FormData): Promise<ActionResult | null> {
  return contactSmartRemitAction(fd);
}

export function ContactForm({ requestKey }: { requestKey: string }) {
  const [state, formAction, pending] = useActionState(submit, null);
  return (
    <form action={formAction} className="flex flex-col gap-4" data-testid="partner-contact-form">
      <input type="hidden" name="requestKey" value={requestKey} />
      <Field name="subject" label={t('partner.contact.subjectLabel')} required>
        {({ id, describedBy }) => (
          <Input id={id} name="subject" required minLength={3} maxLength={120} aria-describedby={describedBy} />
        )}
      </Field>
      <Field name="message" label={t('partner.contact.messageLabel')} hint={t('partner.contact.messageHint')} required>
        {({ id, describedBy }) => (
          <textarea
            id={id}
            name="message"
            required
            minLength={10}
            maxLength={2000}
            rows={5}
            aria-describedby={describedBy}
            className={TEXTAREA}
          />
        )}
      </Field>
      <div>
        <Button type="submit" size="md" disabled={pending}>
          {pending ? t('partner.support.saving') : t('partner.contact.submit')}
        </Button>
      </div>
      <div aria-live="polite">
        {state && state.ok === false ? (
          <p role="alert" className="text-[14px] font-semibold text-ds-danger-ink">
            {state.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
