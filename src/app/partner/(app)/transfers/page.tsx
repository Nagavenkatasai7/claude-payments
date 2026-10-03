import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeftRight, Search } from 'lucide-react';
import { requirePartnerStaff } from '@/lib/auth';
import { getDb } from '@/db/client';
import { getPartnerTransfer, listPartnerTransfers, readSenderBadges, type SenderBadge } from '@/db/repos/partner-transfer-reads';
import { PARTNER_TRANSFERS_PAGE_SIZE, TRANSFER_STATUSES, dayBounds, parseTransferFilters, transfersListHref } from '@/lib/partner-transfers';
import { openTransferSearch, type TransferQuery } from '@/lib/partner-transfer-search';
import { assigneeView } from '@/lib/partner-transfer-ops';
import { kycStatusKey, tierView } from '@/lib/partner-customer-view';
import { sendGateActive } from '@/lib/kyc-gate';
import { tenantStaffUsernames } from '@/lib/partner-tickets';
import { getPartnerStore } from '@/lib/partner-store';
import { getAuthStore } from '@/lib/auth-store';
import { PARTNER_OPS } from '@/lib/partner-access';
import { logWarn } from '@/lib/log';
import { t, type MessageKey } from '@/lib/i18n';
import { Button, Checkbox, EmptyState, Field, Input, PageHeader, Select, buttonVariants } from '@/components/ds';
import type { Transfer } from '@/lib/types';
import { PARTNER_ROUTES } from '../../routes';
import { partnerCustomerHrefs } from '../../customer-link';
import { TransferRows, toPartnerListRow } from './transfer-rows';
import { TransfersExportForm } from '../reports/request-form';
import { searchTransfersAction } from './search-actions';

export const metadata: Metadata = {
  title: t('partner.transfers.title'),
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

/** The tier and KYC labels per sender phone, and the tenant's assignees, for one page of rows. */
async function listColumns(partnerId: string, items: Transfer[]) {
  const db = getDb();
  const phones = items.map((tr) => tr.phone);
  const assigned = items.map((tr) => tr.assignedTo).filter((u): u is string => typeof u === 'string' && u.length > 0);
  const [badges, partner, tenant] = await Promise.all([
    readSenderBadges(db, partnerId, phones).catch((err) => {
      // Fail soft: the columns read "—" rather than the list failing.
      logWarn('partner.transfers.badges', errName(err), { partnerId });
      return new Map<string, SenderBadge>();
    }),
    getPartnerStore().getPartner(partnerId),
    tenantStaffUsernames(partnerId, assigned, (u) => getAuthStore().getStaff(u)),
  ]);
  return { badges, gate: sendGateActive(partner), tenant };
}

/**
 * /partner/transfers (UI redesign M3-5; lost-features restore p1 B1 / B2): the tenant's transfers,
 * newest first. The tenant is the SESSION partner (the gate). The query string carries only
 * closed-set filters (status, mode, UTC days, mine), a transfer id search (an exact, tenant-scoped
 * lookup), an opaque keyset cursor and a SEALED search token (`s`, bound to this tenant and user,
 * 30 minutes), so no name or phone ever enters a URL in clear. Name / phone / last-4 search is for
 * admin and agent only (finance keeps the id search). A foreign or missing id is the same empty state.
 */
export default async function PartnerTransfersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.transfers.policy);
  const sp = await searchParams;
  const f = parseTransferFilters(sp);
  const db = getDb();
  const ops = PARTNER_OPS.roles.includes(ctx.role);
  const now = new Date();
  // Finance never opens a search token (an identity search); a token for anyone else is ignored.
  const search: TransferQuery | null = ops && f.s ? openTransferSearch(f.s, ctx.partnerId, ctx.username, now.getTime()) : null;
  const expired = Boolean(f.s) && !search;
  const mine = ops && f.mine === true;
  const bad = sp.bad === '1';
  const days = dayBounds(f);
  const kept = { status: f.status, environment: f.environment, from: f.from, to: f.to, ...(mine ? { mine: true as const } : {}), ...(search ? { s: f.s } : {}) };

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
      ...(search?.kind === 'text' ? { text: search.value } : {}),
      ...(search?.kind === 'digits' ? { digits: search.value } : {}),
      ...days,
      ...(mine ? { assignedTo: ctx.username } : {}),
    });
    items = page.items;
    nextCursor = page.nextCursor;
  }
  const filtered = Boolean(f.q || f.status || f.environment === 'test' || search || f.from || f.to || mine);
  const cols = await listColumns(ctx.partnerId, items);
  const links = await partnerCustomerHrefs(ctx, items.map((tr) => tr.phone), { known: new Set(cols.badges.keys()) });
  const rows = items.map((tr) => {
    const badge = cols.badges.get(tr.phone);
    return toPartnerListRow(tr, {
      ...(badge ? { tier: tierView(badge, now, cols.gate).key } : {}),
      ...(badge ? { kyc: kycStatusKey(badge.kycStatus) } : {}),
      ...(links.get(tr.phone) ? { customerHref: links.get(tr.phone) } : {}),
      assignee: assigneeView(tr.assignedTo, cols.tenant),
    });
  });
  const notice: MessageKey | null = expired ? 'partner.transfers.searchExpired' : bad ? (ops ? 'partner.transfers.searchInvalid' : 'partner.transfers.searchIdOnlyHint') : null;

  return (
    <>
      <PageHeader title={t('partner.transfers.title')} sub={t('partner.transfers.sub')} />
      <div className="flex flex-col gap-5">
        <form
          action={searchTransfersAction}
          aria-label={t('partner.transfers.filters')}
          className="grid gap-3 rounded-ds-card border border-ds-border bg-ds-surface p-4 sm:grid-cols-2 lg:grid-cols-[1fr_180px_160px] lg:items-end"
        >
          <Field
            name="q"
            label={t(ops ? 'partner.transfers.searchAnyLabel' : 'partner.transfers.searchLabel')}
            hint={t(ops ? 'partner.transfers.searchAnyHint' : 'partner.transfers.searchIdOnlyHint')}
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                name="q"
                type="search"
                maxLength={64}
                defaultValue={f.q ?? search?.value ?? ''}
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
          <Field name="from" label={t('partner.transfers.from')}>
            {({ id, describedBy }) => <Input id={id} name="from" type="date" defaultValue={f.from ?? ''} aria-describedby={describedBy} autoComplete="off" />}
          </Field>
          <Field name="to" label={t('partner.transfers.to')}>
            {({ id, describedBy }) => <Input id={id} name="to" type="date" defaultValue={f.to ?? ''} aria-describedby={describedBy} autoComplete="off" />}
          </Field>
          {ops ? <Checkbox name="mine" value="1" defaultChecked={mine} label={t('partner.transfers.mine')} /> : <span aria-hidden="true" />}
          <Button type="submit" size="md" className="sm:col-span-2 lg:col-span-1 lg:mb-[1px] lg:min-h-[46px]">
            <Search aria-hidden="true" className="size-4" />
            {t('partner.transfers.apply')}
          </Button>
        </form>
        {notice ? (
          <p role="status" className="text-[14px] font-semibold text-ds-warning-ink">
            {t(notice)}
          </p>
        ) : null}
        {search ? <p className="text-[14px] text-ds-ink-muted">{t('partner.transfers.searchActive')}</p> : null}
        {/* M3-16: an async, masked CSV of the current closed-set filters (reportPolicy('transfers')
            = this page's own policy, so every role that sees the page may export). */}
        <TransfersExportForm status={f.status} environment={f.environment} />
        {search || f.from || f.to || mine ? <p className="text-[13px] text-ds-ink-muted">{t('partner.transfers.exportNoSearch')}</p> : null}
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
              <Link href={transfersListHref(kept)} className={buttonVariants({ variant: 'ghost', size: 'md' })}>
                {t('partner.transfers.newest')}
              </Link>
            ) : (
              <span />
            )}
            {nextCursor ? (
              <Link
                href={transfersListHref({ ...kept, cursor: nextCursor })}
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
