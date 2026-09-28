import type { Metadata } from 'next';
import Link from 'next/link';
import { Users } from 'lucide-react';
import { getDb } from '@/db/client';
import { createRecipientRepo } from '@/db/repos/aux-repos';
import { createScheduleRepo } from '@/db/repos/schedule-repo';
import { requirePortalSite } from '@/lib/portal-site';
import { requirePortalCustomer } from '@/lib/portal-auth';
import { PORTAL_RECIPIENTS_PAGE_SIZE, recipientRid, scheduleCountsByRecipient } from '@/lib/portal-recipients';
import { maskAccount } from '@/lib/tools';
import { normalizePhone } from '@/lib/phone';
import { t, type MessageKey } from '@/lib/i18n';
import { Button, buttonVariants, Card, ConfirmDialog, EmptyState, PageHeader } from '@/components/ds';
import { deleteRecipientAction } from './actions';

export const metadata: Metadata = { title: t('portal.recipients.title') };

// The flash copy is a fixed allow-list keyed by a fixed query value: nothing from the URL is echoed.
const DONE: Record<string, MessageKey> = {
  added: 'portal.recipients.done_added',
  updated: 'portal.recipients.done_updated',
  deleted: 'portal.recipients.done_deleted',
};
const ERROR: Record<string, MessageKey> = {
  not_found: 'portal.recipients.not_found',
  too_many: 'portal.recipients.too_many',
  failed: 'portal.recipients.failed',
};

const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

/**
 * The customer's saved recipients (UI redesign M2-8): name, the masked account (****last4), how many
 * scheduled payments go to them, and Send / Edit / Delete. Keyed by the host partner and the
 * session phone only; the URL carries the opaque rid, never a phone. 50 per page.
 */
export default async function PortalRecipientsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const site = await requirePortalSite();
  const ctx = await requirePortalCustomer();
  const pid = site.partnerId;
  const phone = ctx.session.phone;
  const sp = await searchParams;
  const db = getDb();
  const [all, schedules] = await Promise.all([
    createRecipientRepo(db).listAllForSender(pid, phone),
    createScheduleRepo(db).listForCustomer(pid, phone),
  ]);
  const counts = scheduleCountsByRecipient(schedules);
  const pages = Math.max(1, Math.ceil(all.length / PORTAL_RECIPIENTS_PAGE_SIZE));
  const asked = Number.parseInt(one(sp.page) ?? '1', 10);
  const page = Number.isInteger(asked) && asked >= 1 ? Math.min(asked, pages) : 1;
  const rows = all.slice((page - 1) * PORTAL_RECIPIENTS_PAGE_SIZE, page * PORTAL_RECIPIENTS_PAGE_SIZE).map((r) => ({
    rid: recipientRid(pid, phone, r.recipientPhone),
    name: r.name,
    masked: maskAccount(r.payoutMethod, r.payoutDestination),
    schedules: counts.get(normalizePhone(r.recipientPhone)) ?? 0,
  }));
  const done = DONE[one(sp.done) ?? ''];
  const error = ERROR[one(sp.error) ?? ''];
  const addLink = (
    <Link href="/portal/recipients/new" className={buttonVariants({ variant: 'primary', size: 'md' })}>
      {t('portal.recipients.add')}
    </Link>
  );

  return (
    <>
      <PageHeader title={t('portal.recipients.title')} sub={t('portal.recipients.sub')} actions={rows.length > 0 ? addLink : undefined} />
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
        <EmptyState icon={<Users className="size-5" />} title={t('portal.recipients.emptyTitle')} body={t('portal.recipients.emptyBody')} action={addLink} />
      ) : (
        <ul aria-label={t('portal.recipients.listLabel')} className="flex flex-col gap-3">
          {rows.map((r) => (
            <Card as="li" key={r.rid} className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
              <div className="min-w-0">
                <p className="truncate text-[16px] font-semibold text-ds-ink">{r.name}</p>
                <p className="text-[14px] text-ds-ink-muted">{t('portal.recipients.account', { masked: r.masked })}</p>
                {r.schedules > 0 ? (
                  <p className="text-[13px] text-ds-ink-muted">{r.schedules === 1 ? t('portal.recipients.schedulesOne') : t('portal.recipients.schedules', { count: r.schedules })}</p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/portal/send?r=${r.rid}`} className={buttonVariants({ variant: 'primary', size: 'sm' })}>
                  {t('portal.recipients.send')}
                </Link>
                <Link href={`/portal/recipients/${r.rid}/edit`} aria-label={t('portal.recipients.editName', { name: r.name })}
                  className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
                  {t('portal.recipients.edit')}
                </Link>
                <ConfirmDialog
                  trigger={
                    <Button type="button" variant="ghost" size="sm" aria-label={t('portal.recipients.deleteName', { name: r.name })}>
                      {t('portal.recipients.delete')}
                    </Button>
                  }
                  title={t('portal.recipients.deleteTitle', { name: r.name })}
                  body={
                    <>
                      <p>{t('portal.recipients.deleteBody')}</p>
                      {r.schedules > 0 ? (
                        <p className="mt-2 font-semibold text-ds-ink">{r.schedules === 1
                            ? t('portal.recipients.deleteSchedulesOne')
                            : t('portal.recipients.deleteSchedules', { count: r.schedules })}</p>
                      ) : null}
                    </>
                  }
                  confirmLabel={t('portal.recipients.deleteConfirm')}
                  action={deleteRecipientAction.bind(null, r.rid)}
                  destructive
                  requireReason={false}
                />
              </div>
            </Card>
          ))}
        </ul>
      )}
      {pages > 1 ? (
        <nav aria-label={t('portal.recipients.pageOf', { page, pages })} className="mt-6 flex items-center justify-between gap-3 text-[14px] text-ds-ink-muted">
          {page > 1 ? (
            <Link href={`/portal/recipients?page=${page - 1}`} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
              {t('portal.recipients.prev')}
            </Link>
          ) : <span />}
          <span>{t('portal.recipients.pageOf', { page, pages })}</span>
          {page < pages ? (
            <Link href={`/portal/recipients?page=${page + 1}`} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
              {t('portal.recipients.next')}
            </Link>
          ) : <span />}
        </nav>
      ) : null}
    </>
  );
}
