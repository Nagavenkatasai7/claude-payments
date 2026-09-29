import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeftRight, Search } from 'lucide-react';
import { requirePartnerStaff } from '@/lib/auth';
import { getDb } from '@/db/client';
import { getPartnerTransfer, listPartnerTransfers } from '@/db/repos/partner-transfer-reads';
import { PARTNER_TRANSFERS_PAGE_SIZE, TRANSFER_STATUSES, parseTransferFilters, transfersListHref } from '@/lib/partner-transfers';
import { t, type MessageKey } from '@/lib/i18n';
import { Button, EmptyState, Field, Input, PageHeader, Select, buttonVariants } from '@/components/ds';
import type { Transfer } from '@/lib/types';
import { PARTNER_ROUTES } from '../../routes';
import { TransferRows, toPartnerRow } from './transfer-rows';
import { TransfersExportForm } from '../reports/request-form';

export const metadata: Metadata = {
  title: t('partner.transfers.title'),
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

/**
 * /partner/transfers (UI redesign M3-5): the tenant's transfers, newest first. The tenant is the
 * SESSION partner (the gate); the query string carries only closed-set filters, a transfer id
 * search (an exact, tenant-scoped lookup) and an opaque keyset cursor, so no name or phone ever
 * enters a URL. A foreign or missing id is the same empty state.
 */
export default async function PartnerTransfersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.transfers.policy);
  const f = parseTransferFilters(await searchParams);
  const db = getDb();

  let items: Transfer[];
  let nextCursor: string | undefined;
  if (f.q) {
    const hit = await getPartnerTransfer(db, ctx.partnerId, f.q);
    items = hit && (!f.status || hit.status === f.status) && (hit.environment ?? 'live') === f.environment ? [hit] : [];
  } else {
    const page = await listPartnerTransfers(db, ctx.partnerId, {
      limit: PARTNER_TRANSFERS_PAGE_SIZE,
      cursor: f.cursor,
      status: f.status,
      environment: f.environment,
    });
    items = page.items;
    nextCursor = page.nextCursor;
  }
  const filtered = Boolean(f.q || f.status || f.environment === 'test');
  const rows = items.map(toPartnerRow);

  return (
    <>
      <PageHeader title={t('partner.transfers.title')} sub={t('partner.transfers.sub')} />
      <div className="flex flex-col gap-5">
        <form
          method="get"
          action="/partner/transfers"
          aria-label={t('partner.transfers.filters')}
          className="grid gap-3 rounded-ds-card border border-ds-border bg-ds-surface p-4 sm:grid-cols-[1fr_180px_160px_auto] sm:items-end"
        >
          <Field name="q" label={t('partner.transfers.searchLabel')} hint={t('partner.transfers.searchHint')}>
            {({ id, describedBy }) => (
              <Input
                id={id}
                name="q"
                type="search"
                maxLength={64}
                defaultValue={f.q ?? ''}
                aria-describedby={describedBy}
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </Field>
          <Field name="status" label={t('partner.transfers.statusLabel')}>
            {({ id, describedBy }) => (
              <Select id={id} name="status" defaultValue={f.status ?? ''} aria-describedby={describedBy}>
                <option value="">{t('partner.transfers.anyStatus')}</option>
                {TRANSFER_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(`status.transfer.${s}` as MessageKey)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field name="environment" label={t('partner.transfers.envLabel')}>
            {({ id, describedBy }) => (
              <Select id={id} name="environment" defaultValue={f.environment} aria-describedby={describedBy}>
                <option value="live">{t('partner.transfers.env.live')}</option>
                <option value="test">{t('partner.transfers.env.test')}</option>
              </Select>
            )}
          </Field>
          <Button type="submit" size="md" className="sm:mb-[1px] sm:min-h-[46px]">
            <Search aria-hidden="true" className="size-4" />
            {t('partner.transfers.apply')}
          </Button>
        </form>
        {/* M3-16: an async, masked CSV of the current closed-set filters (reportPolicy('transfers')
            = this page's own policy, so every role that sees the page may export). */}
        <TransfersExportForm status={f.status} environment={f.environment} />
        {filtered ? (
          <p className="text-[14px] text-ds-ink-muted">
            <Link href="/partner/transfers" className="font-semibold text-ds-primary hover:underline">
              {t('partner.transfers.clear')}
            </Link>
          </p>
        ) : null}

        {rows.length > 0 ? (
          <TransferRows rows={rows} caption={t('partner.transfers.caption')} />
        ) : (
          <div data-empty>
            <EmptyState
              icon={<ArrowLeftRight className="size-5" />}
              title={t(filtered ? 'partner.transfers.noResultsTitle' : 'partner.transfers.emptyTitle')}
              body={t(filtered ? 'partner.transfers.noResultsBody' : 'partner.transfers.emptyBody')}
            />
          </div>
        )}

        {!f.q && (f.cursor || nextCursor) ? (
          <nav aria-label={t('partner.transfers.pager')} className="flex flex-wrap justify-between gap-3">
            {f.cursor ? (
              <Link href={transfersListHref({ status: f.status, environment: f.environment })} className={buttonVariants({ variant: 'ghost', size: 'md' })}>
                {t('partner.transfers.newest')}
              </Link>
            ) : (
              <span />
            )}
            {nextCursor ? (
              <Link
                href={transfersListHref({ status: f.status, environment: f.environment, cursor: nextCursor })}
                rel="next"
                className={buttonVariants({ variant: 'ghost', size: 'md' })}
              >
                {t('partner.transfers.older')}
              </Link>
            ) : null}
          </nav>
        ) : null}
      </div>
    </>
  );
}
