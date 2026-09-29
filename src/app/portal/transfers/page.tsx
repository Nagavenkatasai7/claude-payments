import Link from 'next/link';
import { ArrowLeftRight, Search } from 'lucide-react';
import { requirePortalSite } from '@/lib/portal-site';
import { requirePortalCustomer } from '@/lib/portal-auth';
import { decodePortalCursor, encodePortalCursor, listPortalTransfers, portalOwner, PORTAL_STATUS_GROUP_VALUES } from '@/lib/portal-transfers';
import { loadTransferFilter, type PortalTransferFilter } from '@/lib/portal-transfer-filter';
import { getRedis } from '@/lib/redis';
import { logWarn } from '@/lib/log';
import { t, type MessageKey } from '@/lib/i18n';
import { Button, EmptyState, Field, Input, PageHeader, Select } from '@/components/ds';
import { TransferRows } from './transfer-rows';
import { filterTransfersAction } from './actions';
import { portalMetadata } from '@/lib/portal-metadata';

export const generateMetadata = () => portalMetadata('portal.transfers.title');

const PAGE_SIZE = 20;
const GROUP_LABEL: Record<string, MessageKey> = {
  in_progress: 'portal.transfers.group.in_progress',
  completed: 'portal.transfers.group.completed',
  cancelled: 'portal.transfers.group.cancelled',
  refunded: 'portal.transfers.group.refunded',
};

/**
 * The customer's transfers (UI redesign M2-7, Task 7.2): keyset pages (`?cursor=`, an opaque token
 * over `createdAt|id`), a status filter and a search. The search form POSTs to
 * filterTransfersAction, which stores the filter under a customer-bound key and redirects with an
 * opaque `?f=`: a recipient name never enters a URL.
 */
export default async function TransfersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePortalSite();
  const ctx = await requirePortalCustomer();
  const owner = portalOwner(ctx);
  const sp = await searchParams;
  const f = typeof sp.f === 'string' ? sp.f : undefined;
  const cursor = decodePortalCursor(sp.cursor);

  let filter: PortalTransferFilter = {};
  if (f) {
    try {
      filter = (await loadTransferFilter(getRedis(), owner, f)) ?? {};
    } catch (err) {
      logWarn('portal.transfer.filter', err);
    }
  }
  const page = await listPortalTransfers(owner, { limit: PAGE_SIZE, cursor, status: filter.status, q: filter.q });
  const filtered = Boolean(filter.status || filter.q);
  const keep = filtered && f ? `f=${f}&` : '';

  return (
    <>
      <PageHeader title={t('portal.transfers.title')} sub={t('portal.transfers.sub')} />
      <div className="flex flex-col gap-5">
        <form action={filterTransfersAction} className="grid gap-3 rounded-ds-card border border-ds-border bg-ds-surface p-4 sm:grid-cols-[1fr_200px_auto] sm:items-end">
          <Field name="q" label={t('portal.transfers.searchLabel')} hint={t('portal.transfers.searchHint')}>
            {({ id, describedBy }) => (
              <Input id={id} name="q" type="search" maxLength={64} defaultValue={filter.q ?? ''} aria-describedby={describedBy} autoComplete="off" />
            )}
          </Field>
          <Field name="status" label={t('portal.transfers.statusLabel')}>
            {({ id, describedBy }) => (
              <Select id={id} name="status" defaultValue={filter.status ?? ''} aria-describedby={describedBy}>
                <option value="">{t('portal.transfers.group.all')}</option>
                {PORTAL_STATUS_GROUP_VALUES.map((g) => (
                  <option key={g} value={g}>
                    {t(GROUP_LABEL[g])}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button type="submit" size="md" className="sm:mb-[1px] sm:min-h-[46px]">
            <Search aria-hidden="true" className="size-4" />
            {t('portal.transfers.apply')}
          </Button>
        </form>
        {filtered ? (
          <p className="text-[14px] text-ds-ink-muted">
            <Link href="/portal/transfers" className="font-semibold text-ds-primary hover:underline">
              {t('portal.transfers.clear')}
            </Link>
          </p>
        ) : null}

        {page.items.length > 0 ? (
          <TransferRows rows={page.items} caption={t('portal.transfers.title')} />
        ) : (
          <div data-empty>
            <EmptyState
              icon={<ArrowLeftRight className="size-5" />}
              title={t(filtered ? 'portal.transfers.noResultsTitle' : 'portal.transfers.emptyTitle')}
              body={t(filtered ? 'portal.transfers.noResultsBody' : 'portal.transfers.emptyBody')}
            />
          </div>
        )}

        {cursor || page.nextCursor ? (
          <nav aria-label={t('portal.transfers.pager')} className="flex flex-wrap justify-between gap-3">
            {cursor ? (
              <Button asChild variant="ghost" size="md">
                <Link href={`/portal/transfers${keep ? `?${keep.slice(0, -1)}` : ''}`}>{t('portal.transfers.newest')}</Link>
              </Button>
            ) : (
              <span />
            )}
            {page.nextCursor ? (
              <Button asChild variant="ghost" size="md">
                <Link href={`/portal/transfers?${keep}cursor=${encodePortalCursor(page.nextCursor)}`} rel="next">
                  {t('portal.transfers.older')}
                </Link>
              </Button>
            ) : null}
          </nav>
        ) : null}
      </div>
    </>
  );
}
