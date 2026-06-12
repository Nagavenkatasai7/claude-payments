export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { getAuthStore } from '@/lib/auth-store';
import { getPartnerStore } from '@/lib/partner-store';
import { getAuditLogStore } from '@/lib/audit-log-store';
import { requirePlatformAdmin } from '@/lib/auth';
import type { Partner, Staff } from '@/lib/types';
import { Sidebar } from '../sidebar';
import { Icon } from '../icons';
import { ExpandableTable, type ExpandableColumn } from '../expandable-table';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import {
  updateStaffAction,
  setStaffStatusAction,
  removeStaffAction,
} from './actions';

const STAFF_COLUMNS: ExpandableColumn[] = [
  { label: 'Member', primary: true },
  { label: 'Role', primary: true },
  { label: 'Scope' },
  { label: 'Status', primary: true },
  { label: 'Last active' },
  { label: 'Role & access' },
  { label: 'Actions' },
];

function shortDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  // date + HH:MM (UTC) so two same-day logins are distinguishable, matching the
  // audit row's granularity.
  return Number.isNaN(d.getTime()) ? '—' : iso.replace('T', ' ').slice(0, 16);
}

function PartnerOptions({ partners }: { partners: Partner[] }) {
  return (
    <>
      <option value="">Platform (no partner)</option>
      {partners.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </>
  );
}

function staffRow(s: Staff, opts: { isSelf: boolean; partners: Partner[]; partnerName: (id?: string) => string }) {
  const status = s.status === 'suspended' ? 'suspended' : 'active';
  const initial = s.name.charAt(0).toUpperCase();

  return {
    key: s.username,
    label: s.name,
    cells: [
      <span key="m" className="flex items-center gap-3">
        <span
          className={`flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
            status === 'suspended' ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary'
          }`}
        >
          {initial}
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 text-sm font-medium">
            {s.name}
            {opts.isSelf ? <Badge variant="outline">You</Badge> : null}
          </span>
          <span className="block text-xs text-muted-foreground">{s.username}</span>
        </span>
      </span>,
      <Badge key="r" variant={s.role === 'admin' ? 'default' : 'secondary'}>
        {s.role}
      </Badge>,
      <Badge key="sc" variant="outline" className="gap-1">
        <Icon name={s.partnerId ? 'building' : 'shield'} />
        {opts.partnerName(s.partnerId)}
      </Badge>,
      <Badge key="st" variant={status === 'active' ? 'secondary' : 'destructive'}>
        {status}
      </Badge>,
      <span key="la" className="text-sm tabular-nums">{shortDate(s.lastLoginAt)}</span>,
      <form key="ed" action={updateStaffAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="username" value={s.username} />
        <select
          name="role"
          className="h-8 rounded-md border border-input bg-card px-2 text-xs"
          defaultValue={s.role}
          aria-label={`Role for ${s.name}`}
        >
          <option value="agent">agent</option>
          <option value="admin">admin</option>
          <option value="support">support</option>
        </select>
        <select
          name="partnerId"
          className="h-8 rounded-md border border-input bg-card px-2 text-xs"
          defaultValue={s.partnerId ?? ''}
          aria-label={`Scope for ${s.name}`}
        >
          <PartnerOptions partners={opts.partners} />
        </select>
        <label className="flex items-center gap-1.5 text-xs">
          <input type="checkbox" name="canCancel" defaultChecked={s.permissions.canCancel} /> Cancel
        </label>
        <label className="flex items-center gap-1.5 text-xs">
          <input type="checkbox" name="canResend" defaultChecked={s.permissions.canResend} /> Resend
        </label>
        <label className="flex items-center gap-1.5 text-xs">
          <input type="checkbox" name="canAssign" defaultChecked={s.permissions.canAssign} /> Assign
        </label>
        <Button type="submit" size="sm" variant="outline">Save</Button>
      </form>,
      opts.isSelf ? (
        <span key="ac" className="text-xs text-muted-foreground">—</span>
      ) : (
        <span key="ac" className="flex flex-wrap items-center gap-2">
          <form action={setStaffStatusAction}>
            <input type="hidden" name="username" value={s.username} />
            <input type="hidden" name="status" value={status === 'active' ? 'suspended' : 'active'} />
            <Button type="submit" size="sm" variant="outline">
              {status === 'active' ? 'Suspend' : 'Reactivate'}
            </Button>
          </form>
          <form action={removeStaffAction}>
            <input type="hidden" name="username" value={s.username} />
            <Button type="submit" size="sm" variant="outline" className="text-destructive">Remove</Button>
          </form>
        </span>
      ),
    ],
  };
}

export default async function TeamPage() {
  const me = await requirePlatformAdmin();
  const [allStaff, partners, audit] = await Promise.all([
    getAuthStore().listStaff(),
    getPartnerStore().listPartners(),
    getAuditLogStore().list(20),
  ]);

  const partnerName = (id?: string) =>
    !id ? 'Platform' : partners.find((p) => p.id === id)?.name ?? id;
  const platformAdmins = allStaff.filter(
    (s) => s.role === 'admin' && !s.partnerId && s.status !== 'suspended',
  ).length;

  return (
    <>
      <Sidebar active="team" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Team</div>
            <div className="sh-page-sub">
              Manage who can access SmartRemit, their role, scope, and permissions
            </div>
          </div>
          <Button asChild>
            <Link href="/admin-dashboard/team/new">
              <Icon name="plus" />
              Add teammate
            </Link>
          </Button>
        </div>

        {platformAdmins <= 1 && (
          <Alert role="status" className="mb-6 border-warning/50">
            <Icon name="warning" />
            <AlertTitle>Only one platform admin.</AlertTitle>
            <AlertDescription>
              Add a second platform admin so the account can always be managed if one is locked
              out.
            </AlertDescription>
          </Alert>
        )}

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Members</CardTitle>
            <CardDescription>
              {allStaff.length} member{allStaff.length === 1 ? '' : 's'} across platform and partners
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ExpandableTable
              columns={STAFF_COLUMNS}
              rows={allStaff.map((s) =>
                staffRow(s, { isSelf: s.username === me.username, partners, partnerName }),
              )}
              empty={<>No teammates yet — add your first.</>}
            />
          </CardContent>
        </Card>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
            <CardDescription>Audit trail of team changes</CardDescription>
          </CardHeader>
          <CardContent>
            {audit.length === 0 ? (
              <p className="text-sm text-muted-foreground">No team changes recorded yet.</p>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {audit.map((e, i) => (
                  <li key={i} className="flex flex-wrap gap-x-3 gap-y-0.5 py-2">
                    <span className="shrink-0 text-xs leading-5 tabular-nums text-muted-foreground">
                      {e.at.replace('T', ' ').slice(0, 16)}
                    </span>
                    <span>
                      <span className="font-medium">{e.actor}</span> {e.action}{' '}
                      <span className="font-medium">{e.target}</span>
                      {e.detail ? ` — ${e.detail}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </main>
    </>
  );
}
