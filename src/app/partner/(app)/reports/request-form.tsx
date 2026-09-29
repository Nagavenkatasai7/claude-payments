'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { t, type MessageKey } from '@/lib/i18n';
import { Button, Field, Input, Select } from '@/components/ds';
import type { ReportKind } from '@/lib/partner-reports';
import type { ActionResult } from '../../action-result';
import { requestReportAction } from './actions';

// The report request forms (UI redesign M3-16). Plain <form action>s: nothing here is trusted. The
// server action re-gates (page policy, then the kind's own policy), takes the tenant from the
// session and validates every value; the kind list below is a convenience, never the guard.

async function submit(_prev: ActionResult | null, formData: FormData): Promise<ActionResult | null> {
  return requestReportAction(formData);
}

function Status({ state, okKey, link }: { state: ActionResult | null; okKey: MessageKey; link?: boolean }) {
  return (
    <div aria-live="polite">
      {state?.ok === true ? (
        <p role="status" className="text-[14px] font-semibold text-ds-success-ink">
          {t(okKey)}{' '}
          {link ? (
            <Link href="/partner/reports" className="text-ds-primary underline">
              {t('partner.reports.goToReports')}
            </Link>
          ) : null}
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

/** The Reports page form: kind, a date window (settlements / transfers) or a month (fees). */
export function ReportRequestForm({ kinds }: { kinds: readonly ReportKind[] }) {
  const [state, formAction, pending] = useActionState(submit, null);
  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-2" data-testid="partner-report-request">
      <Field name="kind" label={t('partner.reports.kindLabel')}>
        {({ id, describedBy }) => (
          <Select id={id} name="kind" defaultValue={kinds[0]} aria-describedby={describedBy} required>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {t(`partner.reports.kind.${k}` as MessageKey)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field name="month" label={t('partner.reports.monthLabel')} hint={t('partner.reports.monthHint')}>
        {({ id, describedBy }) => <Input id={id} name="month" type="month" aria-describedby={describedBy} autoComplete="off" />}
      </Field>
      <Field name="from" label={t('partner.reports.fromLabel')} hint={t('partner.reports.windowHint')}>
        {({ id, describedBy }) => <Input id={id} name="from" type="date" aria-describedby={describedBy} autoComplete="off" />}
      </Field>
      <Field name="to" label={t('partner.reports.toLabel')}>
        {({ id, describedBy }) => <Input id={id} name="to" type="date" aria-describedby={describedBy} autoComplete="off" />}
      </Field>
      <div className="flex flex-col gap-3 sm:col-span-2">
        <div>
          <Button type="submit" size="md" disabled={pending}>
            {pending ? t('partner.reports.submitting') : t('partner.reports.submit')}
          </Button>
        </div>
        <Status state={state} okKey="partner.reports.requested" />
      </div>
    </form>
  );
}

/** The Transfers page "Export CSV": the current closed-set filters, the last 31 days. */
export function TransfersExportForm({ status, environment }: { status?: string; environment: 'live' | 'test' }) {
  const [state, formAction, pending] = useActionState(submit, null);
  return (
    <form action={formAction} className="flex flex-col gap-2" data-testid="partner-transfers-export">
      <input type="hidden" name="kind" value="transfers" />
      {status ? <input type="hidden" name="status" value={status} /> : null}
      <input type="hidden" name="environment" value={environment} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="md" variant="ghost" disabled={pending}>
          {pending ? t('partner.reports.submitting') : t('partner.reports.exportCsv')}
        </Button>
        <span className="text-[13px] text-ds-ink-muted">{t('partner.reports.exportHint')}</span>
      </div>
      <Status state={state} okKey="partner.reports.requestedTransfers" link />
    </form>
  );
}
