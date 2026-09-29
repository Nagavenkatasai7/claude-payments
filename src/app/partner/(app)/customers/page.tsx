import Link from 'next/link';
import type { Metadata } from 'next';
import { Users } from 'lucide-react';
import { requirePartnerStaff } from '@/lib/auth';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import {
  PARTNER_CUSTOMERS_PAGE_SIZE,
  customerListRow,
  kycStatusKey,
  pageCustomers,
  type CustomerListRow,
} from '@/lib/partner-customer-view';
import { clampPage, parseTableParams, tableSorts } from '@/lib/ui/table-params';
import { t } from '@/lib/i18n';
import { Badge, EmptyState, PageHeader, Table, type TableColumn, type Tone } from '@/components/ds';
import { PARTNER_ROUTES } from '../../routes';

export const metadata: Metadata = {
  title: t('partner.customers.title'),
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

const WHEN = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
const when = (iso: string) => (Number.isFinite(Date.parse(iso)) ? WHEN.format(new Date(iso)) : '—');

const KYC_TONE: Record<CustomerListRow['kycStatus'], Tone> = {
  verified: 'success',
  grandfathered: 'success',
  pending: 'warning',
  not_started: 'neutral',
  rejected: 'danger',
  unknown: 'neutral',
};

const COLUMNS: TableColumn<CustomerListRow>[] = [
  {
    key: 'phone',
    header: t('partner.customers.col.phone'),
    cell: (r) => <span className="font-mono tabular-nums">{r.phone}</span>,
  },
  {
    key: 'kyc',
    header: t('partner.customers.col.kyc'),
    cell: (r) => <Badge tone={KYC_TONE[r.kycStatus]}>{t(kycStatusKey(r.kycStatus))}</Badge>,
  },
  { key: 'created', header: t('partner.customers.col.created'), sortable: true, cell: (r) => when(r.createdAt) },
  {
    key: 'open',
    header: t('partner.customers.col.open'),
    cell: (r) => (
      <Link
        href={`${PARTNER_ROUTES.customers.href}/${r.ref}`}
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
 * /partner/customers (UI redesign M3-11). The SESSION tenant's customers only (the tenant is in the
 * WHERE), 50 per page. Rows are masked (phone last 4, a closed KYC label) with NO name column; each
 * links to an opaque sealed ref, so no phone ever reaches a URL. No identity is rendered, so no
 * audit row is written here; the detail page writes `pii.view`. The query carries only page / sort
 * / dir: any tenant parameter is ignored.
 */
export default async function PartnerCustomersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.customers.policy);
  const sp = await searchParams;
  const parsed = parseTableParams(sp, { sorts: tableSorts(COLUMNS), defaultSort: 'created', pageSize: PARTNER_CUSTOMERS_PAGE_SIZE });
  const all = await getCustomerStore(getStore()).listCustomers(ctx.partnerId);
  // Defence in depth: the repo already filters by tenant; a foreign row can never render.
  const mine = all.filter((c) => c.partnerId === ctx.partnerId);
  const params = clampPage(parsed, mine.length);
  const { rows, total } = pageCustomers(mine, params);
  const current = new URLSearchParams();
  if (params.page > 1) current.set('page', String(params.page));
  if (params.dir === 'asc') current.set('dir', 'asc');

  return (
    <>
      <PageHeader title={t('partner.customers.title')} sub={t('partner.customers.sub')} />
      <Table
        caption={t('partner.customers.caption')}
        columns={COLUMNS}
        rows={rows.map(customerListRow)}
        rowKey={(_, i) => String(params.offset + i)}
        total={total}
        params={params}
        baseHref={PARTNER_ROUTES.customers.href}
        currentQuery={current}
        empty={<EmptyState icon={<Users aria-hidden="true" className="size-6" />} title={t('partner.customers.empty')} />}
      />
    </>
  );
}
