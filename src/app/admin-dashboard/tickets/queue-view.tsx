import Link from 'next/link';
import { getDb } from '@/db/client';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { getPartnerStore } from '@/lib/partner-store';
import type { Scope } from '@/lib/staff-scope';
import type { Staff, Ticket, TicketPriority, TicketStatus } from '@/lib/types';
import { ExpandableTable, type ExpandableColumn } from '../expandable-table';
import { Card } from '@/components/ui/card';
import { TicketStatusPill, TicketPriorityPill, TICKET_STATUS_LABEL } from './pills';

// Shared queue view for /tickets (all customer tickets in scope) and
// /tickets/my-queue (pinned to assignedTo = the viewer). Scope is decided by
// the CALLER's requireSupportOrAdmin result: partner staff are pinned to their
// tenant at the repo WHERE; platform staff see every partner + a Partner
// column. Only kind:'customer' tickets appear — internal (employee-question)
// tickets live on the admin employee-questions surface.

export interface QueueParams {
  status?: string;
  priority?: string;
  assigned?: string;
}

const STATUSES: readonly TicketStatus[] = ['open', 'pending', 'waiting_admin', 'resolved', 'closed'];
const PRIORITIES: readonly TicketPriority[] = ['urgent', 'normal', 'low'];

const CHIP_BASE =
  'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-colors';
const CHIP_IDLE = 'border-border bg-card text-muted-foreground hover:bg-background hover:text-foreground';
const CHIP_ACTIVE = 'border-primary/40 bg-primary/10 text-primary';

function chipHref(basePath: string, params: QueueParams, patch: Partial<QueueParams>): string {
  const next = { ...params, ...patch };
  const qs = new URLSearchParams();
  if (next.status) qs.set('status', next.status);
  if (next.priority) qs.set('priority', next.priority);
  if (next.assigned) qs.set('assigned', next.assigned);
  const s = qs.toString();
  return s ? `${basePath}?${s}` : basePath;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export async function TicketQueueView({
  staff,
  scope,
  basePath,
  params,
  pinAssignee,
}: {
  staff: Staff;
  scope: Scope;
  basePath: string;
  params: QueueParams;
  /** my-queue: force assignedTo = this username (the assigned filter is ignored). */
  pinAssignee?: string;
}) {
  const isPlatform = scope.kind === 'platform';
  const repo = createTicketRepo(getDb());
  // One scoped fetch (tenant pinning + kind in the repo WHERE); status/
  // priority/assignee narrowing happens in memory so the filter chips can
  // show accurate counts from the same window. The partner-name map (platform
  // staff's Partner column) is independent — fetched in parallel.
  const [all, partners] = await Promise.all([
    repo.listTickets({
      ...(scope.kind === 'partner' ? { partnerId: scope.partnerId } : {}),
      kind: 'customer',
      limit: 500,
    }),
    isPlatform ? getPartnerStore().listPartners() : Promise.resolve([]),
  ]);

  const statusFilter = (STATUSES as readonly string[]).includes(params.status ?? '')
    ? (params.status as TicketStatus)
    : undefined;
  const priorityFilter = (PRIORITIES as readonly string[]).includes(params.priority ?? '')
    ? (params.priority as TicketPriority)
    : undefined;
  const assignedToMe = pinAssignee !== undefined || params.assigned === 'me';
  const assignee = pinAssignee ?? staff.username;

  const counts: Record<string, number> = {};
  for (const t of all) counts[t.status] = (counts[t.status] ?? 0) + 1;

  const tickets = all.filter(
    (t) =>
      (!statusFilter || t.status === statusFilter) &&
      (!priorityFilter || t.priority === priorityFilter) &&
      (!assignedToMe || t.assignedTo === assignee),
  );

  const partnerName: Record<string, string> = {};
  for (const p of partners) partnerName[p.id] = p.name;

  const columns: ExpandableColumn[] = [
    { label: 'Subject', primary: true },
    { label: 'Status', primary: true },
    { label: 'Priority' },
    { label: 'Category' },
    { label: 'Customer' },
    ...(isPlatform ? [{ label: 'Partner' }] : []),
    { label: 'Assigned' },
    { label: 'Updated' },
  ];

  function cells(t: Ticket) {
    return [
      <Link
        key="subject"
        href={`/admin-dashboard/tickets/${t.id}`}
        className="font-semibold text-primary hover:underline"
      >
        {t.subject}
      </Link>,
      <TicketStatusPill key="status" status={t.status} />,
      <TicketPriorityPill key="priority" priority={t.priority} />,
      <span key="category" className="text-muted-foreground">{t.category ?? '—'}</span>,
      <span key="customer" className="text-xs text-muted-foreground">{t.customerPhone || '—'}</span>,
      ...(isPlatform
        ? [<span key="partner" className="text-xs">{partnerName[t.partnerId] ?? t.partnerId}</span>]
        : []),
      <span key="assigned" className="text-xs">{t.assignedTo ?? '—'}</span>,
      <span key="updated" className="text-xs text-muted-foreground" title={new Date(t.updatedAt).toLocaleString()}>
        {timeAgo(t.updatedAt)}
      </span>,
    ];
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Link
          href={chipHref(basePath, params, { status: undefined })}
          className={`${CHIP_BASE} ${statusFilter ? CHIP_IDLE : CHIP_ACTIVE}`}
        >
          All <span className="opacity-70">{all.length}</span>
        </Link>
        {STATUSES.map((s) => (
          <Link
            key={s}
            href={chipHref(basePath, params, { status: statusFilter === s ? undefined : s })}
            className={`${CHIP_BASE} ${statusFilter === s ? CHIP_ACTIVE : CHIP_IDLE}`}
          >
            {TICKET_STATUS_LABEL[s]} <span className="opacity-70">{counts[s] ?? 0}</span>
          </Link>
        ))}
        <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
        {PRIORITIES.map((p) => (
          <Link
            key={p}
            href={chipHref(basePath, params, { priority: priorityFilter === p ? undefined : p })}
            className={`${CHIP_BASE} ${priorityFilter === p ? CHIP_ACTIVE : CHIP_IDLE}`}
          >
            {p === 'urgent' ? 'Urgent' : p === 'normal' ? 'Normal' : 'Low'}
          </Link>
        ))}
        {pinAssignee === undefined && (
          <>
            <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
            <Link
              href={chipHref(basePath, params, { assigned: assignedToMe ? undefined : 'me' })}
              className={`${CHIP_BASE} ${assignedToMe ? CHIP_ACTIVE : CHIP_IDLE}`}
            >
              Assigned to me
            </Link>
          </>
        )}
      </div>
      <Card className="overflow-hidden py-0">
        <ExpandableTable
          columns={columns}
          empty={<>No tickets in this view.</>}
          rows={tickets.map((t) => ({ key: t.id, label: t.subject, cells: cells(t) }))}
        />
        <div className="border-t border-border px-4 py-3 text-sm text-muted-foreground">
          {tickets.length} {tickets.length === 1 ? 'ticket' : 'tickets'} in view
        </div>
      </Card>
    </>
  );
}
