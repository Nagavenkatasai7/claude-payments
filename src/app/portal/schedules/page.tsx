import type { Metadata } from 'next';
import Link from 'next/link';
import { CalendarClock } from 'lucide-react';
import { getDb } from '@/db/client';
import { createScheduleRepo } from '@/db/repos/schedule-repo';
import { requirePortalSite } from '@/lib/portal-site';
import { requirePortalCustomer } from '@/lib/portal-auth';
import { describeSchedule, visibleSchedules } from '@/lib/portal-schedules';
import { formatSourceAmount, maskAccount } from '@/lib/tools';
import { boundUntrustedText, NAME_MAX } from '@/lib/untrusted-text';
import { t, type MessageKey } from '@/lib/i18n';
import { Badge, Button, buttonVariants, Card, ConfirmDialog, EmptyState, PageHeader } from '@/components/ds';
import { cancelScheduleAction, pauseScheduleAction, resumeScheduleAction } from './actions';

export const metadata: Metadata = { title: t('portal.schedules.title') };

// The flash copy is a fixed allow-list keyed by a fixed query value: nothing from the URL is echoed.
const DONE: Record<string, MessageKey> = {
  created: 'portal.schedules.done_created',
  paused: 'portal.schedules.done_paused',
  resumed: 'portal.schedules.done_resumed',
  cancelled: 'portal.schedules.done_cancelled',
};
const ERROR: Record<string, MessageKey> = {
  not_found: 'portal.schedules.not_found',
  changed: 'portal.schedules.changed',
  already_paused: 'portal.schedules.already_paused',
  not_paused: 'portal.schedules.not_paused',
  cancelled: 'portal.schedules.cancelled',
  too_many: 'portal.schedules.too_many',
  failed: 'portal.schedules.failed',
};

const DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const fmtDate = (iso: string | undefined) => {
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(at) ? DATE.format(at) : null;
};
const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

/**
 * The customer's scheduled payments (UI redesign M2-10): active and paused, newest first, with the
 * amount, recipient, cadence and the masked account (****last4), plus Pause / Resume / Cancel.
 * Keyed by the host partner and the session phone only; the URL carries nothing but fixed flash
 * values. A cancelled schedule is history and is not listed.
 */
export default async function PortalSchedulesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const site = await requirePortalSite();
  const ctx = await requirePortalCustomer();
  const sp = await searchParams;
  const rows = visibleSchedules(await createScheduleRepo(getDb()).listForCustomer(site.partnerId, ctx.session.phone)).map((s) => {
    const cadence = describeSchedule(s);
    return {
      id: s.id,
      name: boundUntrustedText(s.recipientName, NAME_MAX),
      amount: formatSourceAmount(s.amountSource, s.sourceCurrency),
      cadence: t(cadence.key, cadence.vars),
      account: s.payoutDestination ? t('portal.schedules.account', { masked: maskAccount(s.payoutMethod, s.payoutDestination) }) : t('portal.schedules.accountOnPayPage'),
      paused: s.status === 'paused',
      endsOn: fmtDate(s.endDate),
      lastRun: fmtDate(s.lastRunAt),
    };
  });
  const done = DONE[one(sp.done) ?? ''];
  const error = ERROR[one(sp.error) ?? ''];
  const addLink = (
    <Link href="/portal/schedules/new" className={buttonVariants({ variant: 'primary', size: 'md' })}>
      {t('portal.schedules.add')}
    </Link>
  );

  return (
    <>
      <PageHeader title={t('portal.schedules.title')} sub={t('portal.schedules.sub')} actions={rows.length > 0 ? addLink : undefined} />
      {done ? (
        <p role="status" className="mb-4 rounded-ds-inner border border-ds-border bg-ds-surface px-4 py-3 text-[14px] font-semibold text-ds-ink">
          {t(done)}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mb-4 rounded-ds-inner border border-ds-danger-ink/30 bg-ds-danger-bg px-4 py-3 text-[14px] font-semibold text-ds-danger-ink">
          {t(error)}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState icon={<CalendarClock className="size-5" />} title={t('portal.schedules.emptyTitle')} body={t('portal.schedules.emptyBody')} action={addLink} />
      ) : (
        <ul aria-label={t('portal.schedules.listLabel')} className="flex flex-col gap-3">
          {rows.map((r) => (
            <Card as="li" key={r.id} className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-[16px] font-semibold text-ds-ink">{t('portal.schedules.amountTo', { amount: r.amount, name: r.name })}</p>
                  <Badge tone={r.paused ? 'warning' : 'success'}>{r.paused ? t('portal.schedules.statusPaused') : t('portal.schedules.statusActive')}</Badge>
                </div>
                <p className="text-[14px] text-ds-ink-muted">{r.cadence}</p>
                <p className="text-[14px] text-ds-ink-muted">{r.account}</p>
                {r.endsOn ? <p className="text-[13px] text-ds-ink-muted">{t('portal.schedules.endsOn', { date: r.endsOn })}</p> : null}
                {r.lastRun ? <p className="text-[13px] text-ds-ink-muted">{t('portal.schedules.lastRun', { date: r.lastRun })}</p> : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {r.paused ? (
                  <form action={resumeScheduleAction.bind(null, r.id)}>
                    <Button type="submit" variant="primary" size="sm" aria-label={t('portal.schedules.resumeName', { name: r.name })}>
                      {t('portal.schedules.resume')}
                    </Button>
                  </form>
                ) : (
                  <form action={pauseScheduleAction.bind(null, r.id)}>
                    <Button type="submit" variant="ghost" size="sm" aria-label={t('portal.schedules.pauseName', { name: r.name })}>
                      {t('portal.schedules.pause')}
                    </Button>
                  </form>
                )}
                <ConfirmDialog
                  trigger={
                    <Button type="button" variant="ghost" size="sm" aria-label={t('portal.schedules.cancelName', { name: r.name })}>
                      {t('portal.schedules.cancel')}
                    </Button>
                  }
                  title={t('portal.schedules.cancelTitle', { name: r.name })}
                  body={<p>{t('portal.schedules.cancelBody')}</p>}
                  confirmLabel={t('portal.schedules.cancelConfirm')}
                  action={cancelScheduleAction.bind(null, r.id)}
                  destructive
                  requireReason={false}
                />
              </div>
            </Card>
          ))}
        </ul>
      )}
    </>
  );
}
