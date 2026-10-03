'use client';

import { useActionState } from 'react';
import { t } from '@/lib/i18n';
import { Button, Field, Input } from '@/components/ds';
import type { ActionResult } from '../../../action-result';
import type { ContactAudience } from '@/lib/partner-tickets';
import { contactSmartRemitAction } from './actions';

// "Contact SmartRemit" new-thread form (UI redesign M3-19). The action takes the tenant and the
// opener from the session; the request key (server-minted) makes a double submit open one thread.
// On success the action redirects to the new thread. Lost-features A12: the sender picks who should
// answer, their own admins (a team question) or SmartRemit; the action re-validates the choice.

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring';
const TEXTAREA = `min-h-[140px] w-full rounded-ds-inner border border-ds-border-input bg-ds-surface px-4 py-3 text-[15px] text-ds-ink placeholder:text-ds-ink-subtle ${FOCUS}`;

async function submit(_prev: ActionResult | null, fd: FormData): Promise<ActionResult | null> {
  return contactSmartRemitAction(fd);
}

const RADIO = 'mt-1 size-4 shrink-0 accent-ds-primary';
const AUDIENCES: readonly ContactAudience[] = ['team', 'smartremit'];

export function ContactForm({ requestKey, defaultAudience }: { requestKey: string; defaultAudience: ContactAudience }) {
  const [state, formAction, pending] = useActionState(submit, null);
  return (
    <form action={formAction} className="flex flex-col gap-4" data-testid="partner-contact-form">
      <input type="hidden" name="requestKey" value={requestKey} />
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-[14px] font-semibold text-ds-ink">{t('partner.contact.audienceLabel')}</legend>
        {AUDIENCES.map((a) => (
          <label key={a} className="flex min-h-11 items-center gap-3 text-[15px] text-ds-ink">
            <input type="radio" name="audience" value={a} defaultChecked={a === defaultAudience} required className={RADIO} />
            <span>{t(a === 'team' ? 'partner.contact.audience.team' : 'partner.contact.audience.smartremit')}</span>
          </label>
        ))}
      </fieldset>
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
          {pending ? t('partner.support.saving') : t('partner.contact.send')}
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
