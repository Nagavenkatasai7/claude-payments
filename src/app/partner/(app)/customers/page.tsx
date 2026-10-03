import Link from 'next/link';
import type { Metadata } from 'next';
import { Users } from 'lucide-react';
import { requirePartnerStaff } from '@/lib/auth';
import { getDb } from '@/db/client';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { getPartnerStore } from '@/lib/partner-store';
import { sendGateActive } from '@/lib/kyc-gate';
import { partnerCustomerTotals } from '@/db/repos/partner-customer-reads';
import {
  DIRECTORY_TIERS,
  KYC_STATUS_VALUES,
  PARTNER_CUSTOMERS_PAGE_SIZE,
  customerDirectoryRow,
  directorySummary,
  filterDirectory,
  kycStatusKey,
  pageDirectory,
  parseCustomerFilters,
  type CustomerDirectoryRow,
} from '@/lib/partner-customer-view';
import { clampPage, parseTableParams, tableSorts } from '@/lib/ui/table-params';
import { formatMoney } from '@/lib/ui/money';
import { t, type MessageKey } from '@/lib/i18n';
import { Badge, Button, EmptyState, Field, Input, PageHeader, Select, Table, buttonVariants, type TableColumn, type Tone } from '@/components/ds';
import { PARTNER_ROUTES, routeAllows } from '../../routes';
import { FindCustomerForm } from './find-form';

export const metadata: Metadata = {
  title: t('partner.customers.title'),
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

const WHEN = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
const when = (iso: string) => (Number.isFinite(Date.parse(iso)) ? WHEN.format(new Date(iso)) : '—');
const BASE = PARTNER_ROUTES.customers.href;

const KYC_TONE: Record<CustomerDirectoryRow['kycStatus'], Tone> = {
  verified: 'success',
  grandfathered: 'success',
  pending: 'warning',
  not_started: 'neutral',
  rejected: 'danger',
  unknown: 'neutral',
};
const TIER_FILTER_KEY: Record<(typeof DIRECTORY_TIERS)[number], MessageKey> = {
  T0: 'partner.customers.tier.T0',
  T1: 'partner.customers.tier.T1',
  Suspended: 'partner.customers.tier.Suspended',
};

const COLUMNS: TableColumn<CustomerDirectoryRow>[] = [
  {
    key: 'phone',
    header: t('partner.customers.col.phone'),
    cell: (r) => <span className="font-mono tabular-nums">{r.phone}</span>,
  },
  { key: 'country', header: t('partner.customers.col.country'), cell: (r) => r.country ?? '—' },
  {
    key: 'tier',
    header: t('partner.customers.col.tier'),
    cell: (r) => (
      <span data-tier={r.tier}>
        {t(r.tierKey)}
        {r.dayOfWindow !== null ? (
          <span className="block text-[12.5px] text-ds-ink-muted">{t('partner.customers.tier.day', { day: r.dayOfWindow })}</span>
        ) : null}
      </span>
    ),
  },
  {
    key: 'kyc',
    header: t('partner.customers.col.kyc'),
    cell: (r) => <Badge tone={KYC_TONE[r.kycStatus]}>{t(kycStatusKey(r.kycStatus))}</Badge>,
  },
  {
    key: 'transfers',
    header: t('partner.customers.col.transfers'),
    cell: (r) => <span className="tabular-nums" data-col="transfers">{r.transfers}</span>,
  },
  {
    key: 'sent',
    header: t('partner.customers.col.sent'),
    cell: (r) => <span className="tabular-nums" data-col="sent">{formatMoney(r.sentCents / 100)}</span>,
  },
  { key: 'lastActivity', header: t('partner.customers.col.lastActivity'), sortable: true, cell: (r) => when(r.lastActivityAt) },
  { key: 'created', header: t('partner.customers.col.created'), sortable: true, cell: (r) => when(r.createdAt) },
  {
    key: 'open',
    header: t('partner.customers.col.open'),
    cell: (r) => (
      <Link
        href={`${BASE}/${r.ref}`}
        prefetch={false}
        aria-label={t('partner.customers.openLabel', { phone: r.phone })}
        className="rounded-ds-focus font-semibold text-ds-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring"
      >
        {t('partner.customers.open')}
      </Link>
    ),
  },
];

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * /partner/customers (UI redesign M3-11; lost-features p2 B4). The SESSION tenant's customers only
 * (the tenant is in the WHERE), 50 per page. Rows are masked (phone last 4, closed labels) with NO
 * name column; each links to an opaque sealed ref with prefetch off. Columns add country, tier (with
 * the day of the first-days window), live transfer count, amount sent and last activity from one
 * grouped ledger read. Filters are closed values (KYC status, tier) plus `?last4=`: four digits the
 * list already prints, so no more of a phone reaches a URL than the page shows. The full-phone
 * search is the POST "find by phone" form. No identity is rendered, so no audit row is written here;
 * the detail page writes `pii.view`. Any tenant parameter is ignored. Admins also get a "New
 * customer" link (p2 A5).
 */
export default async function PartnerCustomersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.customers.policy);
  const sp = await searchParams;
  const parsed = parseTableParams(sp, { sorts: tableSorts(COLUMNS), defaultSort: 'created', pageSize: PARTNER_CUSTOMERS_PAGE_SIZE });
  const filters = parseCustomerFilters(sp);
  const [all, totals, partner] = await Promise.all([
    getCustomerStore(getStore()).listCustomers(ctx.partnerId),
    partnerCustomerTotals(getDb(), ctx.partnerId),
    getPartnerStore().getPartner(ctx.partnerId),
  ]);
  const now = new Date();
  const gate = sendGateActive(partner);
  // Defence in depth: the repo already filters by tenant; a foreign row can never render.
  const directory = all
    .filter((c) => c.partnerId === ctx.partnerId)
    .map((c) => customerDirectoryRow(c, totals.get(c.senderPhone), now, gate));
  const summary = directorySummary(directory);
  const shown = filterDirectory(directory, filters);
  const params = clampPage(parsed, shown.length);
  const { rows, total } = pageDirectory(shown, params);
  const current = new URLSearchParams();
  if (params.page > 1) current.set('page', String(params.page));
  if (params.sort !== 'created') current.set('sort', params.sort);
  if (params.dir === 'asc') current.set('dir', 'asc');
  if (filters.kyc) current.set('kyc', filters.kyc);
  if (filters.tier) current.set('tier', filters.tier);
  if (filters.last4) current.set('last4', filters.last4);
  const filtered = Object.keys(filters).length > 0;

  return (
    <>
      <PageHeader
        title={t('partner.customers.title')}
        sub={t('partner.customers.sub')}
        actions={
          routeAllows('customersNew', ctx.role) ? (
            <Link
              href={PARTNER_ROUTES.customersNew.href}
              prefetch={false}
              data-new-customer=""
              className={buttonVariants({ variant: 'primary', size: 'md' })}
            >
              {t('partner.customers.new')}
            </Link>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-4">
        <FindCustomerForm />
        <p className="text-[14px] text-ds-ink-muted" data-customers-summary="">
          {t('partner.customers.subCount', { total: summary.total, t0: summary.t0 })}
        </p>
        <form
          method="get"
          action={BASE}
          aria-label={t('partner.customers.filter.label')}
          className="grid gap-3 rounded-ds-card border border-ds-border bg-ds-surface p-4 sm:grid-cols-3"
        >
          <Field name="kyc" label={t('partner.customers.filter.kyc')}>
            {(ids) => (
              <Select id={ids.id} name="kyc" defaultValue={filters.kyc ?? ''}>
                <option value="">{t('partner.customers.filter.any')}</option>
                {KYC_STATUS_VALUES.map((k) => (
                  <option key={k} value={k}>
                    {t(kycStatusKey(k))}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field name="tier" label={t('partner.customers.filter.tier')}>
            {(ids) => (
              <Select id={ids.id} name="tier" defaultValue={filters.tier ?? ''}>
                <option value="">{t('partner.customers.filter.any')}</option>
                {DIRECTORY_TIERS.map((k) => (
                  <option key={k} value={k}>
                    {t(TIER_FILTER_KEY[k])}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field name="last4" label={t('partner.customers.filter.last4')} hint={t('partner.customers.filter.last4Hint')}>
            {(ids) => (
              <Input
                id={ids.id}
                name="last4"
                inputMode="numeric"
                pattern="[0-9]{4}"
                maxLength={4}
                autoComplete="off"
                defaultValue={filters.last4 ?? ''}
                aria-describedby={ids.describedBy}
              />
            )}
          </Field>
          <div className="flex flex-wrap items-center gap-2 sm:col-span-3">
            <Button type="submit" size="md">
              {t('partner.customers.filter.apply')}
            </Button>
            {filtered ? (
              <Link href={BASE} className={buttonVariants({ variant: 'ghost', size: 'md' })}>
                {t('partner.customers.filter.clear')}
              </Link>
            ) : null}
          </div>
        </form>
        <Table
          caption={t('partner.customers.caption')}
          columns={COLUMNS}
          rows={rows}
          rowKey={(_, i) => String(params.offset + i)}
          total={total}
          params={params}
          baseHref={BASE}
          currentQuery={current}
          empty={
            <EmptyState
              icon={<Users aria-hidden="true" className="size-6" />}
              title={filtered ? t('partner.customers.filter.none') : t('partner.customers.empty')}
            />
          }
        />
        <p className="text-[13px] text-ds-ink-subtle">{t('partner.customers.totalsNote')}</p>
      </div>
    </>
  );
}
