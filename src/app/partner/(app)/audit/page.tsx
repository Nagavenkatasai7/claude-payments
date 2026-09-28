import Link from 'next/link';
import type { Metadata } from 'next';
import { ScrollText } from 'lucide-react';
import { requirePartnerStaff } from '@/lib/auth';
import { getAuthStore } from '@/lib/auth-store';
import { getDb } from '@/db/client';
import { listTenantAudit } from '@/db/repos/tenant-audit-repo';
import { listTenantStaff } from '@/lib/partner-staff-policy';
import { scopeOf } from '@/lib/staff-scope';
import { isValidNewStaffUsername } from '@/lib/staff-username';
import {
  AUDIT_MAX_WINDOW_DAYS,
  TENANT_AUDIT_ACTIONS,
  actionLabelKey,
  auditCursorOf,
  parseAuditCursor,
  parseAuditFilters,
  projectAuditRow,
  type ProjectedAuditRow,
} from '@/lib/partner-audit-view';
import { t } from '@/lib/i18n';
import { Button, EmptyState, Field, Input, PageHeader, Select, Table, buttonVariants, type TableColumn } from '@/components/ds';
import { PARTNER_ROUTES } from '../../routes';

export const metadata: Metadata = { title: t('partner.audit.title'), robots: { index: false, follow: false } };

// /partner/audit (UI redesign M3-4): the tenant's own audit trail, READ-ONLY. The page gates itself
// (admin only, MFA enforced; the layout's gate is chrome only). The tenant is the SESSION's
// partnerId; nothing in the query string can name another tenant: the actor must be one of this
// tenant's usernames, the action must be allowlisted, the window is clamped to 90 days, and the
// keyset cursor is only a (time, id) position inside this tenant's rows. Rows reach the page only
// through projectAuditRow (no raw meta, masked subjects, platform actors shown as "SmartRemit").
// Viewing is not itself audited: it is the tenant's own trail and renders no PII (M3 plan, M3-4 DoD).
const PAGE_SIZE = 25;
const BASE = PARTNER_ROUTES.audit.href;

type SearchParams = Record<string, string | string[] | undefined>;
type Row = ProjectedAuditRow & { key: string };

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const has = (sp: SearchParams, k: string) => (Array.isArray(sp[k]) ? sp[k].length > 0 : Boolean(sp[k]));

export default async function PartnerAuditPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.audit.policy);
  const sp = await searchParams;
  const now = new Date();

  const staff = listTenantStaff(scopeOf(ctx.staff), ctx.partnerId, await getAuthStore().listStaff());
  const tenantUsernames = new Set(staff.map((s) => s.username));
  // The actor filter travels in the URL, so only URL-safe usernames are offered (never an email-shaped legacy name).
  const selectable = [...tenantUsernames].filter(isValidNewStaffUsername).sort();

  const f = parseAuditFilters(sp, selectable, now);
  const before = parseAuditCursor(sp.before);
  const rows = await listTenantAudit(getDb(), ctx.partnerId, { ...f, before, limit: PAGE_SIZE + 1 });
  const page = rows.slice(0, PAGE_SIZE);
  const older = rows.length > PAGE_SIZE ? page[page.length - 1] : undefined;
  const shown: Row[] = page.map((r) => ({ ...projectAuditRow(r, tenantUsernames), key: String(r.id) }));

  // The query the pager keeps: only the validated filters, never the raw input.
  const action = f.actions.length === 1 ? f.actions[0] : undefined;
  const query = new URLSearchParams();
  if (action) query.set('action', action);
  if (f.actor) query.set('actor', f.actor);
  if (has(sp, 'from')) query.set('from', ymd(f.from));
  if (has(sp, 'to')) query.set('to', ymd(f.to));
  const href = (extra?: Record<string, string>) => {
    const q = new URLSearchParams(query);
    for (const [k, v] of Object.entries(extra ?? {})) q.set(k, v);
    const s = q.toString();
    return s ? `${BASE}?${s}` : BASE;
  };

  const columns: TableColumn<Row>[] = [
    {
      key: 'at',
      header: t('partner.audit.colAt'),
      cell: (r) => (
        <time dateTime={r.at} className="whitespace-nowrap tabular-nums">
          {when(r.at)}
        </time>
      ),
    },
    { key: 'actor', header: t('partner.audit.colActor'), cell: (r) => r.actor },
    { key: 'action', header: t('partner.audit.colAction'), cell: (r) => t(actionLabelKey(r.action)) },
    { key: 'subject', header: t('partner.audit.colSubject'), cell: (r) => <span className="break-all">{r.subject}</span> },
    { key: 'detail', header: t('partner.audit.colDetail'), cell: (r) => <span className="break-all text-ds-ink-muted">{r.detail ?? ''}</span> },
  ];

  return (
    <>
      <PageHeader title={t('partner.audit.title')} sub={t('partner.audit.sub')} />
      <div className="flex flex-col gap-4">
        <form
          method="get"
          action={BASE}
          aria-label={t('partner.audit.filters')}
          className="grid gap-3 rounded-ds-card border border-ds-border bg-ds-surface p-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          <Field name="actor" label={t('partner.audit.filterActor')}>
            {(ids) => (
              <Select id={ids.id} name="actor" defaultValue={f.actor ?? ''}>
                <option value="">{t('partner.audit.anyActor')}</option>
                {selectable.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field name="action" label={t('partner.audit.filterAction')}>
            {(ids) => (
              <Select id={ids.id} name="action" defaultValue={action ?? ''}>
                <option value="">{t('partner.audit.anyAction')}</option>
                {TENANT_AUDIT_ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {t(actionLabelKey(a))}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field name="from" label={t('partner.audit.filterFrom')}>
            {(ids) => <Input id={ids.id} name="from" type="date" defaultValue={ymd(f.from)} min={ymd(new Date(now.getTime() - AUDIT_MAX_WINDOW_DAYS * 86_400_000))} max={ymd(now)} />}
          </Field>
          <Field name="to" label={t('partner.audit.filterTo')}>
            {(ids) => <Input id={ids.id} name="to" type="date" defaultValue={ymd(f.to)} max={ymd(now)} />}
          </Field>
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2 lg:col-span-4">
            <Button type="submit" size="md">
              {t('partner.audit.apply')}
            </Button>
            <Link href={BASE} className={buttonVariants({ variant: 'ghost', size: 'md' })}>
              {t('partner.audit.reset')}
            </Link>
          </div>
        </form>
        <p className="text-[13.5px] text-ds-ink-muted">
          {t('partner.audit.window', { from: ymd(f.from), to: ymd(f.to), days: AUDIT_MAX_WINDOW_DAYS })}
        </p>
        {shown.length === 0 ? (
          <EmptyState
            icon={<ScrollText className="size-5" />}
            title={t('partner.audit.emptyTitle')}
            body={t('partner.audit.emptyBody')}
          />
        ) : (
          <Table
            caption={t('partner.audit.caption')}
            columns={columns}
            rows={shown}
            total={0}
            params={{ page: 1, sort: 'at', dir: 'desc', offset: 0, limit: PAGE_SIZE }}
            baseHref={BASE}
            currentQuery={query}
            empty={t('partner.audit.emptyTitle')}
            rowKey={(r) => r.key}
          />
        )}
        {before || older ? (
          <nav aria-label={t('partner.audit.pager')} className="flex flex-wrap justify-end gap-2">
            {before ? (
              <Link href={href()} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
                {t('partner.audit.newest')}
              </Link>
            ) : null}
            {older ? (
              <Link href={href({ before: auditCursorOf(older) })} rel="next" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
                {t('partner.audit.older')}
              </Link>
            ) : null}
          </nav>
        ) : null}
      </div>
    </>
  );
}
