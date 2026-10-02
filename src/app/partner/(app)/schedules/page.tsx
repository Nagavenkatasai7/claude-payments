import type { Metadata } from 'next';
import Link from 'next/link';
import { CalendarClock, Repeat } from 'lucide-react';
import { requirePartnerStaff } from '@/lib/auth';
import { getDb } from '@/db/client';
import { listPartnerSchedules, PARTNER_SCHEDULES_LIMIT } from '@/db/repos/partner-schedule-reads';
import {
  parseScheduleFilter,
  partnerSchedulesDueSoon,
  toPartnerScheduleRow,
  visiblePartnerSchedules,
  type PartnerScheduleRow,
} from '@/lib/partner-schedules';
import { t, type MessageKey } from '@/lib/i18n';
import { Badge, Card, EmptyState, Money, PageHeader } from '@/components/ds';
import { dsCn } from '@/lib/ui/ds-cn';
import type { Tone } from '@/lib/ui/transfer-status';
import type { ScheduleStatus } from '@/lib/types';
import { PARTNER_ROUTES } from '../../routes';
import { ScheduleControls } from './schedule-controls';

export const metadata: Metadata = {
  title: t('partner.schedules.title'),
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

// /partner/schedules (merge plan 2a): the SESSION tenant's recurring transfers. The read
// (partner-schedule-reads) selects no destination ciphertext, so nothing is decrypted; rows carry
// masked values only (lib/partner-schedules). Every role on the money-read policy may view; the
// pause / resume / cancel dialogs render for admins only (D1), and the server action re-gates.

const DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const when = (iso: string | null) => (iso && Number.isFinite(Date.parse(iso)) ? DATE.format(new Date(iso)) : null);
const FOCUS = 'rounded-ds-focus focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring';
const STATUS_TONE: Record<ScheduleStatus, Tone> = { active: 'success', paused: 'warning', cancelled: 'neutral' };

function StatusBadge({ status }: { status: ScheduleStatus }) {
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{t(`partner.schedules.status.${status}` as MessageKey)}</Badge>;
}

/** An active schedule whose runs are skipped until the owner gives their legal name (2026-10-02). */
function NeedsNameBadge({ r }: { r: PartnerScheduleRow }) {
  return r.needsSenderName ? (
    <span className="mt-1 block" title={t('partner.schedules.needsNameHint')}>
      <Badge tone="warning">{t('partner.schedules.needsName')}</Badge>
    </span>
  ) : null;
}

function Cadence({ r }: { r: PartnerScheduleRow }) {
  const ends = when(r.endDate);
  return (
    <>
      <span className="block">{t(r.cadence.key, r.cadence.vars)}</span>
      {ends ? <span className="block text-[12.5px] text-ds-ink-muted">{t('partner.schedules.endsOn', { date: ends })}</span> : null}
    </>
  );
}

function Actions({ r, isAdmin }: { r: PartnerScheduleRow; isAdmin: boolean }) {
  if (r.controls.pause || r.controls.resume || r.controls.cancel) return <ScheduleControls id={r.id} controls={r.controls} />;
  if (!isAdmin && r.status !== 'cancelled') return <span className="text-[13px] text-ds-ink-muted">{t('partner.schedules.adminOnly')}</span>;
  return <span className="text-ds-ink-muted">—</span>;
}

export default async function PartnerSchedulesPage({ searchParams }: { searchParams: Promise<{ show?: string | string[] }> }) {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.schedules.policy);
  const filter = parseScheduleFilter((await searchParams).show);
  const all = await listPartnerSchedules(getDb(), ctx.partnerId, { limit: PARTNER_SCHEDULES_LIMIT });
  const now = Date.now();
  const dueSoon = partnerSchedulesDueSoon(all, now, 7).map((s) => toPartnerScheduleRow(s, ctx.role));
  const rows = visiblePartnerSchedules(all, filter).map((s) => toPartnerScheduleRow(s, ctx.role));
  const isAdmin = ctx.role === 'admin';
  const href = PARTNER_ROUTES.schedules.href;

  return (
    <>
      <PageHeader title={t('partner.schedules.title')} sub={t('partner.schedules.sub')} />
      <div className="flex flex-col gap-5">
        <Card as="section" className="p-4 sm:p-6">
          <h2 className="flex items-center gap-2 text-[17px] font-semibold text-ds-ink">
            <CalendarClock aria-hidden="true" className="size-4" />
            {t('partner.schedules.dueTitle')}
          </h2>
          {dueSoon.length === 0 ? (
            <p className="mt-2 text-[14px] text-ds-ink-muted">{t('partner.schedules.dueEmpty')}</p>
          ) : (
            <ul className="mt-3 divide-y divide-ds-border" data-due-soon>
              {dueSoon.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
                  <span className="min-w-0">
                    <span className="block font-semibold text-ds-ink">{r.recipient}</span>
                    <span className="block text-[13px] text-ds-ink-muted">{t(r.cadence.key, r.cadence.vars)}</span>
                  </span>
                  <Money amount={r.amount} currency={r.currency} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <nav aria-label={t('partner.schedules.filterLabel')} className="flex flex-wrap gap-2">
          {(['open', 'all'] as const).map((f) => (
            <Link
              key={f}
              href={f === 'all' ? `${href}?show=all` : href}
              aria-current={filter === f ? 'page' : undefined}
              className={dsCn(
                'rounded-full border px-3.5 py-1.5 text-[13px] font-semibold',
                filter === f ? 'border-ds-primary bg-ds-tint text-ds-primary' : 'border-ds-border bg-ds-surface text-ds-ink-muted hover:text-ds-ink',
                FOCUS,
              )}
            >
              {t(f === 'all' ? 'partner.schedules.filterAll' : 'partner.schedules.filterOpen')}
            </Link>
          ))}
        </nav>

        {all.length >= PARTNER_SCHEDULES_LIMIT ? (
          <p className="text-[14px] text-ds-ink-muted">{t('partner.schedules.truncated', { count: PARTNER_SCHEDULES_LIMIT })}</p>
        ) : null}

        {rows.length === 0 ? (
          <div data-empty>
            <EmptyState icon={<Repeat className="size-5" />} title={t('partner.schedules.emptyTitle')} body={t('partner.schedules.emptyBody')} />
          </div>
        ) : (
          <>
            <div className="hidden overflow-x-auto rounded-ds-card border border-ds-border bg-ds-surface lg:block">
              <table className="w-full border-collapse text-left text-[14px] text-ds-ink">
                <caption className="sr-only">{t('partner.schedules.caption')}</caption>
                <thead className="bg-ds-ground text-[12.5px] font-semibold uppercase tracking-[0.04em] text-ds-ink-muted">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-semibold">{t('partner.schedules.col.recipient')}</th>
                    <th scope="col" className="px-4 py-3 font-semibold">{t('partner.schedules.col.sender')}</th>
                    <th scope="col" className="px-4 py-3 font-semibold">{t('partner.schedules.col.amount')}</th>
                    <th scope="col" className="px-4 py-3 font-semibold">{t('partner.schedules.col.cadence')}</th>
                    <th scope="col" className="px-4 py-3 font-semibold">{t('partner.schedules.col.lastRun')}</th>
                    <th scope="col" className="px-4 py-3 font-semibold">{t('partner.schedules.col.status')}</th>
                    <th scope="col" className="px-4 py-3 font-semibold">{t('partner.schedules.col.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-t border-ds-border align-top" data-row={r.id}>
                      <td className="px-4 py-3">
                        <span className="block font-semibold">{r.recipient}</span>
                        <span className="block font-mono text-[12.5px] text-ds-ink-muted">{r.destination}</span>
                      </td>
                      <td className="px-4 py-3 font-mono text-[13px]">{r.sender}</td>
                      <td className="px-4 py-3">
                        <Money amount={r.amount} currency={r.currency} />
                      </td>
                      <td className="px-4 py-3">
                        <Cadence r={r} />
                      </td>
                      <td className="px-4 py-3 text-ds-ink-muted">{when(r.lastRunAt) ?? t('partner.schedules.notYet')}</td>
                      <td className="px-4 py-3">
                        <StatusBadge status={r.status} />
                        <NeedsNameBadge r={r} />
                      </td>
                      <td className="px-4 py-3">
                        <Actions r={r} isAdmin={isAdmin} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul data-cards className="flex flex-col gap-3 lg:hidden" aria-label={t('partner.schedules.caption')}>
              {rows.map((r) => (
                <li key={r.id} className="flex flex-col gap-2 rounded-ds-card border border-ds-border bg-ds-surface p-4">
                  <span className="flex items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block truncate font-semibold text-ds-ink">{r.recipient}</span>
                      <span className="block truncate font-mono text-[12.5px] text-ds-ink-muted">
                        {r.sender} · {r.destination}
                      </span>
                    </span>
                    <span className="shrink-0 font-semibold text-ds-ink">
                      <Money amount={r.amount} currency={r.currency} />
                    </span>
                  </span>
                  <span className="text-[13.5px] text-ds-ink">
                    <Cadence r={r} />
                  </span>
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={r.status} />
                      <NeedsNameBadge r={r} />
                    </span>
                    <span className="text-[13px] text-ds-ink-muted">
                      {t('partner.schedules.col.lastRun')}: {when(r.lastRunAt) ?? t('partner.schedules.notYet')}
                    </span>
                  </span>
                  <Actions r={r} isAdmin={isAdmin} />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </>
  );
}
