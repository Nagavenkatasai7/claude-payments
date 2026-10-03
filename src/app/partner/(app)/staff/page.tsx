import type { Metadata } from 'next';
import { MailPlus, ShieldCheck, ShieldOff, Users } from 'lucide-react';
import { requirePartnerStaff } from '@/lib/auth';
import { getAuthStore } from '@/lib/auth-store';
import { getStaffMfaStore } from '@/lib/staff-mfa-store';
import { getStaffInviteStore, type StaffInvite } from '@/lib/staff-invite-store';
import { listTenantStaff } from '@/lib/partner-staff-policy';
import { lastLoginLabel, permissionFlags, rosterRows, type RosterRow } from '@/lib/partner-staff-view';
import { scopeOf } from '@/lib/staff-scope';
import { t } from '@/lib/i18n';
import type { Staff } from '@/lib/types';
import { Badge, Card, EmptyState, PageHeader, Table, type TableColumn } from '@/components/ds';
import { PARTNER_ROUTES } from '../../routes';
import { InviteForm } from './invite-form';
import { RemoveMember, RevokeInvite } from './row-actions';

export const metadata: Metadata = { title: t('partner.staff.title'), robots: { index: false, follow: false } };

// /partner/staff (UI redesign M3-8): the tenant's members, their MFA state, pending invites, the
// invite form and per-row remove / revoke. The page gates itself (admin only, MFA enforced; the
// layout's gate is chrome only). The tenant is the SESSION's partnerId: members come from
// listTenantStaff (never another tenant's, never platform accounts) and invites from the tenant's
// own index. An invite shows its username, role and expiry only: never the email, never the token.
// There is no MFA-reset control (plan O3: MFA reset stays platform-only).
// Lost-features A13: an agent gets a read-only roster (active members: name, username, role). Its
// branch returns before the MFA and invite reads, so none of that is even loaded for an agent.

const BASE = PARTNER_ROUTES.staff.href;
const TABLE_PARAMS = { page: 1, sort: 'name', dir: 'asc' as const, offset: 0, limit: 500 };
const ymdhm = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

type MemberRow = Staff & { mfaOn: boolean; self: boolean };
type InviteRow = StaffInvite & { id: string };

export default async function PartnerStaffPage() {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.staff.policy);
  const now = new Date();

  const members = listTenantStaff(scopeOf(ctx.staff), ctx.partnerId, await getAuthStore().listStaff()).sort((a, b) =>
    a.username.localeCompare(b.username),
  );
  if (ctx.role !== 'admin') return <AgentRoster rows={rosterRows(members, ctx.role)} self={ctx.username} />;
  const enrolled = await getStaffMfaStore().enrolledAmong(members.map((m) => m.username));
  const rows: MemberRow[] = members.map((m) => ({ ...m, mfaOn: enrolled.has(m.username), self: m.username === ctx.username }));
  const invites: InviteRow[] = await getStaffInviteStore().listForPartner(ctx.partnerId);

  const memberColumns: TableColumn<MemberRow>[] = [
    {
      key: 'name',
      header: t('partner.staff.colName'),
      cell: (r) => (
        <span className="flex flex-col">
          <span className="font-semibold">
            {r.name}
            {r.self ? <span className="ml-2 text-[12.5px] font-normal text-ds-ink-muted">({t('partner.staff.you')})</span> : null}
          </span>
          <span className="break-all text-[13px] text-ds-ink-muted">{r.username}</span>
        </span>
      ),
    },
    { key: 'role', header: t('partner.staff.colRole'), cell: (r) => t(`partner.staff.role.${r.role}`) },
    {
      key: 'status',
      header: t('partner.staff.colStatus'),
      cell: (r) =>
        r.status === 'suspended' ? (
          <Badge tone="danger">{t('partner.staff.statusSuspended')}</Badge>
        ) : (
          <Badge tone="success">{t('partner.staff.statusActive')}</Badge>
        ),
    },
    {
      key: 'mfa',
      header: t('partner.staff.colMfa'),
      cell: (r) =>
        r.mfaOn ? (
          <Badge tone="success">
            <ShieldCheck aria-hidden="true" className="size-3.5" />
            {t('partner.staff.mfaOn')}
          </Badge>
        ) : (
          <Badge tone="warning">
            <ShieldOff aria-hidden="true" className="size-3.5" />
            {t('partner.staff.mfaOff')}
          </Badge>
        ),
    },
    {
      key: 'lastLogin',
      header: t('partner.staff.colLastLogin'),
      cell: (r) => {
        const l = lastLoginLabel(r.lastLoginAt, now);
        const text = t(l.key, l.vars);
        return r.lastLoginAt && Number.isFinite(Date.parse(r.lastLoginAt)) ? (
          <time dateTime={r.lastLoginAt} title={ymdhm(r.lastLoginAt)} className="whitespace-nowrap">
            {text}
          </time>
        ) : (
          <span className="text-ds-ink-muted">{text}</span>
        );
      },
    },
    {
      // Lost-features A13 (review 2.4): read only. SmartRemit sets the per-staff permissions.
      key: 'permissions',
      header: t('partner.staff.colPermissions'),
      cell: (r) => {
        const p = permissionFlags(r);
        if (p.byRole) return t('partner.staff.perm.all');
        if (p.keys.length === 0) return <span className="text-ds-ink-muted">{t('partner.staff.perm.none')}</span>;
        return <span data-permissions="">{p.keys.map((k) => t(k)).join(', ')}</span>;
      },
    },
    {
      key: 'actions',
      header: t('partner.staff.colActions'),
      cell: (r) => (r.self ? null : <RemoveMember username={r.username} name={r.name} />),
    },
  ];

  const inviteColumns: TableColumn<InviteRow>[] = [
    { key: 'username', header: t('partner.staff.colUsername'), cell: (r) => <span className="break-all">{r.username}</span> },
    { key: 'role', header: t('partner.staff.colRole'), cell: (r) => t(`partner.staff.role.${r.role}`) },
    {
      key: 'expires',
      header: t('partner.staff.colExpires'),
      cell: (r) => (
        <time dateTime={r.expiresAt} className="whitespace-nowrap tabular-nums">
          {ymdhm(r.expiresAt)}
        </time>
      ),
    },
    { key: 'actions', header: t('partner.staff.colActions'), cell: (r) => <RevokeInvite id={r.id} username={r.username} /> },
  ];

  return (
    <>
      <PageHeader title={t('partner.staff.title')} sub={t('partner.staff.sub')} />
      <div className="flex flex-col gap-8">
        <section aria-labelledby="staff-members" className="flex flex-col gap-3">
          <h2 id="staff-members" className="text-[18px] font-bold text-ds-ink">
            {t('partner.staff.membersTitle')}
          </h2>
          {rows.length === 0 ? (
            <EmptyState icon={<Users className="size-5" />} title={t('partner.staff.emptyTitle')} body={t('partner.staff.emptyBody')} />
          ) : (
            <Table
              caption={t('partner.staff.membersCaption')}
              columns={memberColumns}
              rows={rows}
              total={0}
              params={TABLE_PARAMS}
              baseHref={BASE}
              currentQuery={new URLSearchParams()}
              empty={t('partner.staff.emptyTitle')}
              rowKey={(r) => r.username}
            />
          )}
          <p className="text-[13px] text-ds-ink-muted">{t('partner.staff.permNote')}</p>
        </section>

        <section aria-labelledby="staff-invites" className="flex flex-col gap-3">
          <h2 id="staff-invites" className="text-[18px] font-bold text-ds-ink">
            {t('partner.staff.invitesTitle')}
          </h2>
          {invites.length === 0 ? (
            <EmptyState icon={<MailPlus className="size-5" />} title={t('partner.staff.invitesEmpty')} />
          ) : (
            <Table
              caption={t('partner.staff.invitesCaption')}
              columns={inviteColumns}
              rows={invites}
              total={0}
              params={TABLE_PARAMS}
              baseHref={BASE}
              currentQuery={new URLSearchParams()}
              empty={t('partner.staff.invitesEmpty')}
              rowKey={(r) => r.id}
            />
          )}
        </section>

        <section aria-labelledby="staff-invite" className="flex flex-col gap-3">
          <Card>
            <div className="flex flex-col gap-4">
              <div>
                <h2 id="staff-invite" className="text-[18px] font-bold text-ds-ink">
                  {t('partner.staff.inviteTitle')}
                </h2>
                <p className="text-[14px] text-ds-ink-muted">{t('partner.staff.inviteSub')}</p>
              </div>
              <InviteForm />
            </div>
          </Card>
        </section>
      </div>
    </>
  );
}

function AgentRoster({ rows, self }: { rows: RosterRow[]; self: string }) {
  const columns: TableColumn<RosterRow>[] = [
    {
      key: 'name',
      header: t('partner.staff.colName'),
      cell: (r) => (
        <span className="flex flex-col">
          <span className="font-semibold">
            {r.name}
            {r.username === self ? <span className="ml-2 text-[12.5px] font-normal text-ds-ink-muted">({t('partner.staff.you')})</span> : null}
          </span>
          <span className="break-all text-[13px] text-ds-ink-muted">{r.username}</span>
        </span>
      ),
    },
    { key: 'role', header: t('partner.staff.colRole'), cell: (r) => t(`partner.staff.role.${r.role}`) },
  ];
  return (
    <>
      <PageHeader title={t('partner.staff.title')} sub={t('partner.staff.subAgent')} />
      <section aria-labelledby="staff-members" className="flex flex-col gap-3">
        <h2 id="staff-members" className="text-[18px] font-bold text-ds-ink">
          {t('partner.staff.membersTitle')}
        </h2>
        {rows.length === 0 ? (
          <EmptyState icon={<Users className="size-5" />} title={t('partner.staff.emptyTitle')} />
        ) : (
          <Table
            caption={t('partner.staff.membersCaption')}
            columns={columns}
            rows={rows}
            total={0}
            params={TABLE_PARAMS}
            baseHref={BASE}
            currentQuery={new URLSearchParams()}
            empty={t('partner.staff.emptyTitle')}
            rowKey={(r) => r.username}
          />
        )}
      </section>
    </>
  );
}
