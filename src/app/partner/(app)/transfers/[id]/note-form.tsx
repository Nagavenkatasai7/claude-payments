'use client';

import { useActionState } from 'react';
import { t } from '@/lib/i18n';
import { Button } from '@/components/ds';
import type { ActionResult } from '../../../action-result';
import { addHoldNoteAction } from './actions';

// The hold-note form (UI redesign M3-5). A plain <form action> carrying the transfer id and a
// server-minted request key in hidden fields; the server action re-gates, re-scopes the id to the
// session tenant and validates the note, so nothing here is trusted. The page re-renders after a
// save with a fresh request key (so a second note is a new request) and the note in the timeline.

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring';

async function submit(_prev: ActionResult | null, formData: FormData): Promise<ActionResult | null> {
  return addHoldNoteAction(formData);
}

export function NoteForm({ id, requestKey }: { id: string; requestKey: string }) {
  const [state, formAction, pending] = useActionState(submit, null);
  return (
    <form action={formAction} className="flex flex-col gap-3" data-testid="partner-hold-note-form">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="requestKey" value={requestKey} />
      <label htmlFor="hold-note" className="text-[14px] font-semibold text-ds-ink">
        {t('partner.transfers.noteLabel')}
      </label>
      <textarea
        id="hold-note"
        name="note"
        required
        maxLength={500}
        rows={3}
        aria-describedby="hold-note-hint"
        className={`min-h-[96px] w-full rounded-ds-inner border border-ds-border-input bg-ds-surface px-4 py-3 text-[15px] text-ds-ink placeholder:text-ds-ink-subtle ${FOCUS}`}
      />
      <p id="hold-note-hint" className="text-[13px] text-ds-ink-muted">
        {t('partner.transfers.noteHint')}
      </p>
      <div>
        <Button type="submit" size="md" disabled={pending}>
          {pending ? t('partner.transfers.noteSaving') : t('partner.transfers.noteSubmit')}
        </Button>
      </div>
      <div aria-live="polite">
        {state?.ok === true ? (
          <p role="status" className="text-[14px] font-semibold text-ds-success-ink">
            {t('partner.transfers.noteSaved')}
          </p>
        ) : null}
        {state && state.ok === false ? (
          <p role="alert" className="text-[14px] font-semibold text-ds-danger-ink">
            {state.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
