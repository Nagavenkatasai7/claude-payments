'use client';

import { useActionState, useId } from 'react';
import { t, type MessageKey } from '@/lib/i18n';
import { Button, Checkbox, Field, Select } from '@/components/ds';
import type { ActionResult } from '../../../action-result';
import type { TicketStatus } from '@/lib/types';
import { assignAction, escalateAction, internalNoteAction, replyAction, setStatusAction } from './actions';
import { contactFollowUpAction } from '../contact/actions';

// The /partner/support/[ticketId] forms (UI redesign M3-19). Plain <form action>s carrying the
// ticket id and a server-minted request key in hidden fields; every action re-gates, re-scopes the
// id to the session tenant and validates the input, so nothing here is trusted. A saved form
// resets (React form actions) and the page re-renders with a fresh request key.

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring';
const TEXTAREA = `min-h-[112px] w-full rounded-ds-inner border border-ds-border-input bg-ds-surface px-4 py-3 text-[15px] text-ds-ink placeholder:text-ds-ink-subtle ${FOCUS}`;

type Act = (fd: FormData) => Promise<ActionResult>;
const wrap = (action: Act) => async (_prev: ActionResult | null, fd: FormData) => action(fd);

const replySubmit = wrap(replyAction);
const noteSubmit = wrap(internalNoteAction);
const statusSubmit = wrap(setStatusAction);
const followUpSubmit = wrap(contactFollowUpAction);
const assignSubmit = wrap(assignAction);
const escalateSubmit = wrap(escalateAction);

function Result({ state, savedKey }: { state: ActionResult | null; savedKey: MessageKey }) {
  return (
    <div aria-live="polite">
      {state?.ok === true ? (
        <p role="status" className="text-[14px] font-semibold text-ds-success-ink">
          {t(savedKey)}
        </p>
      ) : null}
      {state && state.ok === false ? (
        <p role="alert" className="text-[14px] font-semibold text-ds-danger-ink">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}

function TextForm({
  submit,
  id,
  requestKey,
  label,
  hint,
  submitLabel,
  savedKey,
  testId,
  withWaiting,
}: {
  submit: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  id: string;
  requestKey: string;
  label: string;
  hint?: string;
  submitLabel: string;
  savedKey: MessageKey;
  testId: string;
  withWaiting?: boolean;
}) {
  const [state, formAction, pending] = useActionState(submit, null);
  const fieldId = useId();
  return (
    <form action={formAction} className="flex flex-col gap-3" data-testid={testId}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="requestKey" value={requestKey} />
      <label htmlFor={fieldId} className="text-[14px] font-semibold text-ds-ink">
        {label}
      </label>
      <textarea
        id={fieldId}
        name="body"
        required
        maxLength={4000}
        rows={4}
        aria-describedby={hint ? `${fieldId}-hint` : undefined}
        className={TEXTAREA}
      />
      {hint ? (
        <p id={`${fieldId}-hint`} className="text-[13px] text-ds-ink-muted">
          {hint}
        </p>
      ) : null}
      {withWaiting ? <Checkbox name="waiting" label={t('partner.support.waiting')} /> : null}
      <div>
        <Button type="submit" size="md" disabled={pending}>
          {pending ? t('partner.support.saving') : submitLabel}
        </Button>
      </div>
      <Result state={state} savedKey={savedKey} />
    </form>
  );
}

export function ReplyForm({ id, requestKey, withWaiting = true }: { id: string; requestKey: string; withWaiting?: boolean }) {
  return (
    <TextForm
      submit={replySubmit}
      id={id}
      requestKey={requestKey}
      label={t('partner.support.replyLabel')}
      hint={t('partner.support.replyHint')}
      submitLabel={t('partner.support.replySubmit')}
      savedKey="partner.support.replySent"
      testId="partner-support-reply"
      withWaiting={withWaiting}
    />
  );
}

export function NoteForm({ id, requestKey }: { id: string; requestKey: string }) {
  return (
    <TextForm
      submit={noteSubmit}
      id={id}
      requestKey={requestKey}
      label={t('partner.support.noteLabel')}
      hint={t('partner.support.internalHint')}
      submitLabel={t('partner.support.noteSubmit')}
      savedKey="partner.support.noteSaved"
      testId="partner-support-note"
    />
  );
}

export function FollowUpForm({ id, requestKey }: { id: string; requestKey: string }) {
  return (
    <TextForm
      submit={followUpSubmit}
      id={id}
      requestKey={requestKey}
      label={t('partner.contact.followUpLabel')}
      submitLabel={t('partner.contact.followUpSubmit')}
      savedKey="partner.contact.followUpSent"
      testId="partner-contact-follow-up"
    />
  );
}

/** Merge plan 2e: (re)assign. Shown to admin and support only; the action re-gates and re-checks. */
export function AssignForm({
  id,
  current,
  options,
}: {
  id: string;
  current: string;
  options: { value: string; label: string }[];
}) {
  const [state, formAction, pending] = useActionState(assignSubmit, null);
  return (
    <form action={formAction} className="flex flex-col gap-3" data-testid="partner-support-assign">
      <input type="hidden" name="id" value={id} />
      <Field name="assignee" label={t('partner.support.assignLabel')} hint={t('partner.support.assignHint')}>
        {({ id: controlId, describedBy }) => (
          <Select id={controlId} name="assignee" aria-describedby={describedBy} defaultValue={current}>
            <option value="">{t('partner.support.assignNone')}</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div>
        <Button type="submit" size="md" variant="ghost" disabled={pending}>
          {pending ? t('partner.support.saving') : t('partner.support.assignSubmit')}
        </Button>
      </div>
      <Result state={state} savedKey="partner.support.assignSaved" />
    </form>
  );
}

/** Merge plan 2e: escalate to SmartRemit with a typed reason (validated again on the server). */
export function EscalateForm({ id }: { id: string }) {
  const [state, formAction, pending] = useActionState(escalateSubmit, null);
  const fieldId = useId();
  return (
    <form action={formAction} className="flex flex-col gap-3" data-testid="partner-support-escalate">
      <input type="hidden" name="id" value={id} />
      <label htmlFor={fieldId} className="text-[14px] font-semibold text-ds-ink">
        {t('partner.support.escalateLabel')}
      </label>
      <textarea
        id={fieldId}
        name="reason"
        required
        minLength={10}
        maxLength={500}
        rows={3}
        aria-describedby={`${fieldId}-hint`}
        className={TEXTAREA}
      />
      <p id={`${fieldId}-hint`} className="text-[13px] text-ds-ink-muted">
        {t('partner.support.escalateHint')}
      </p>
      <div>
        <Button type="submit" size="md" variant="ghost" disabled={pending}>
          {pending ? t('partner.support.saving') : t('partner.support.escalateSubmit')}
        </Button>
      </div>
      <Result state={state} savedKey="partner.support.escalateSaved" />
    </form>
  );
}

export function StatusForm({ id, options }: { id: string; options: { value: TicketStatus; label: string }[] }) {
  const [state, formAction, pending] = useActionState(statusSubmit, null);
  return (
    <form action={formAction} className="flex flex-col gap-3" data-testid="partner-support-status">
      <input type="hidden" name="id" value={id} />
      <Field name="status" label={t('partner.support.statusLabel')} hint={t('partner.support.statusHint')}>
        {({ id: controlId, describedBy }) => (
          <Select id={controlId} name="status" required aria-describedby={describedBy} defaultValue="">
            <option value="" disabled>
              {t('partner.support.statusLabel')}
            </option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div>
        <Button type="submit" size="md" variant="ghost" disabled={pending}>
          {pending ? t('partner.support.saving') : t('partner.support.statusSubmit')}
        </Button>
      </div>
      <Result state={state} savedKey="partner.support.statusSaved" />
    </form>
  );
}
