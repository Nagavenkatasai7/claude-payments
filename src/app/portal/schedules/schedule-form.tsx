'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import { t, type MessageKey } from '@/lib/i18n';
import { Button, Field, Input, Select } from '@/components/ds';
import type { ScheduleFormState } from './actions';
import { PurposeFields } from '../send/purpose-fields';
import { ScamWarning } from '../send/scam-warning';

// The new-schedule form (UI redesign M2-10). The recipient is picked by its opaque rid; the server
// re-resolves it and takes the number, name and account from the stored row. Nothing typed here is
// a secret, so the inputs are echoed back after an error. Batch B follow-up A3/A4: Other asks for the
// customer's reason (their own words, echoed back to them only), and a reason that matches a scam
// pattern brings back the warning with the required "I have read this warning" tick.

const WEEKDAYS: MessageKey[] = [
  'portal.schedules.weekday0',
  'portal.schedules.weekday1',
  'portal.schedules.weekday2',
  'portal.schedules.weekday3',
  'portal.schedules.weekday4',
  'portal.schedules.weekday5',
  'portal.schedules.weekday6',
];

export function ScheduleForm(props: {
  action: (prev: ScheduleFormState, fd: FormData) => Promise<ScheduleFormState>;
  initial: ScheduleFormState;
  recipients: Array<{ rid: string; label: string }>;
  limits: { min: string; max: string };
}) {
  const [state, action, busy] = useActionState(props.action, props.initial);
  const v = state.values ?? {};
  const [frequency, setFrequency] = useState<'monthly' | 'weekly'>(v.frequency === 'weekly' ? 'weekly' : 'monthly');
  const e = state.errors ?? {};
  const msg = (k: MessageKey | undefined) => (k ? t(k, props.limits) : undefined);
  const ackError = state.error === 'portal.send.scam_ack_required' ? t(state.error) : undefined;

  return (
    <form action={action} className="flex flex-col gap-5" noValidate>
      <input type="hidden" name="requestKey" value={state.requestKey} />
      {state.error && !ackError ? (
        <p role="alert" className="rounded-ds-inner border border-ds-danger-ink/30 bg-ds-danger-bg px-4 py-3 text-[14px] font-semibold text-ds-danger-ink">
          {msg(state.error)}
        </p>
      ) : null}
      <Field name="rid" label={t('portal.schedules.recipientLabel')} hint={t('portal.schedules.recipientHint')} error={msg(e.recipient)} required>
        {({ id, describedBy, invalid }) => (
          <Select id={id} name="rid" key={`rid-${state.requestKey}`} defaultValue={v.rid ?? props.recipients[0]?.rid} aria-describedby={describedBy} invalid={invalid}>
            {props.recipients.map((r) => (
              <option key={r.rid} value={r.rid}>{r.label}</option>
            ))}
          </Select>
        )}
      </Field>
      {/* Required purpose (owner decision 2026-10-08): one of the 8, none chosen up front. */}
      <PurposeFields key={`purpose-${state.requestKey}`} purpose={v.purpose} purposeDetail={v.purpose_detail}
        purposeError={msg(e.purpose)} detailError={msg(e.purposeDetail)}
        label={t('portal.schedules.purposeLabel')} placeholder={t('portal.schedules.purposePlaceholder')} />
      <Field name="amount" label={t('portal.schedules.amountLabel')} hint={t('portal.schedules.amountHint', props.limits)} error={msg(e.amount)} required>
        {({ id, describedBy, invalid }) => (
          <Input id={id} name="amount" key={`amount-${state.requestKey}`} inputMode="decimal" autoComplete="off" maxLength={9}
            defaultValue={v.amount ?? ''} required aria-describedby={describedBy} invalid={invalid} />
        )}
      </Field>
      <Field name="frequency" label={t('portal.schedules.frequencyLabel')} error={msg(e.frequency)} required>
        {({ id, describedBy, invalid }) => (
          <Select id={id} name="frequency" value={frequency} onChange={(ev) => setFrequency(ev.target.value === 'weekly' ? 'weekly' : 'monthly')}
            aria-describedby={describedBy} invalid={invalid}>
            <option value="monthly">{t('portal.schedules.monthly')}</option>
            <option value="weekly">{t('portal.schedules.weekly')}</option>
          </Select>
        )}
      </Field>
      {frequency === 'monthly' ? (
        <Field name="dayOfMonth" label={t('portal.schedules.dayOfMonthLabel')} hint={t('portal.schedules.dayOfMonthHint')} error={msg(e.day)} required>
          {({ id, describedBy, invalid }) => (
            <Select id={id} name="dayOfMonth" key={`dom-${state.requestKey}`} defaultValue={v.dayOfMonth || '1'} aria-describedby={describedBy} invalid={invalid}>
              {Array.from({ length: 28 }, (_, i) => String(i + 1)).map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </Select>
          )}
        </Field>
      ) : (
        <Field name="dayOfWeek" label={t('portal.schedules.dayOfWeekLabel')} error={msg(e.day)} required>
          {({ id, describedBy, invalid }) => (
            <Select id={id} name="dayOfWeek" key={`dow-${state.requestKey}`} defaultValue={v.dayOfWeek || '1'} aria-describedby={describedBy} invalid={invalid}>
              {WEEKDAYS.map((k, i) => (
                <option key={k} value={String(i)}>{t(k)}</option>
              ))}
            </Select>
          )}
        </Field>
      )}
      <Field name="endDate" label={t('portal.schedules.endDateLabel')} hint={t('portal.schedules.endDateHint')} error={msg(e.endDate)}>
        {({ id, describedBy, invalid }) => (
          <Input id={id} name="endDate" key={`end-${state.requestKey}`} type="date" defaultValue={v.endDate ?? ''} aria-describedby={describedBy} invalid={invalid} />
        )}
      </Field>
      {state.scamWarning ? <ScamWarning key={`ack-${state.requestKey}`} error={ackError} /> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? t('portal.schedules.saving') : t('portal.schedules.save')}
        </Button>
        <Link href="/portal/schedules" className="text-[14px] font-semibold text-ds-primary">
          {t('portal.schedules.back')}
        </Link>
      </div>
    </form>
  );
}
