'use client';

import { useActionState } from 'react';
import { t } from '@/lib/i18n';
import { Button, Card, Field, Input } from '@/components/ds';
import { setSenderNameAction, type NameFormState } from '../send/actions';

// Scheduled-send name nudge (2026-10-02): a customer with no legal name on file sees this card on the
// Schedules pages, because a scheduled run cannot mint (or be set up) without it. It posts to the send
// review's own set-once action; `back` is one of that action's allow-listed pages.

export function ScheduleNameCard({ back }: { back: '/portal/schedules' | '/portal/schedules/new' }) {
  const [state, action, busy] = useActionState(setSenderNameAction, {} satisfies NameFormState);
  return (
    <Card className="mb-4 flex flex-col gap-4 p-4 sm:p-5">
      <div>
        <h2 className="text-[16px] font-semibold text-ds-ink">{t('portal.schedules.nameTitle')}</h2>
        <p className="text-[14px] text-ds-ink-muted">{t('portal.schedules.nameBody')}</p>
      </div>
      <form action={action} className="flex flex-col gap-4">
        <input type="hidden" name="back" value={back} />
        <Field name="fullName" label={t('portal.send.legalNameLabel')} error={state.error ? t(state.error) : undefined} required>
          {({ id, describedBy, invalid }) => (
            <Input id={id} name="fullName" autoComplete="name" maxLength={80} required aria-describedby={describedBy} invalid={invalid} />
          )}
        </Field>
        <div>
          <Button type="submit" disabled={busy}>
            {busy ? t('portal.send.nameSaving') : t('portal.schedules.nameSave')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
