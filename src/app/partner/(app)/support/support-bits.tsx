import Link from 'next/link';
import { CheckCircle2, CircleDot, Clock, Lock, TriangleAlert } from 'lucide-react';
import { t, type MessageKey } from '@/lib/i18n';
import { Badge, type Tone } from '@/components/ds';
import type { Ticket, TicketPriority, TicketStatus } from '@/lib/types';

// Server-rendered pieces shared by the /partner/support pages (UI redesign M3-19). Status and
// priority always carry text (never colour alone). Times are shown in UTC so the server render is
// deterministic.

const STATUS_VIEW: Record<TicketStatus, { tone: Tone; Icon: typeof Clock }> = {
  open: { tone: 'info', Icon: CircleDot },
  pending: { tone: 'warning', Icon: Clock },
  waiting_admin: { tone: 'warning', Icon: TriangleAlert },
  resolved: { tone: 'success', Icon: CheckCircle2 },
  closed: { tone: 'neutral', Icon: Lock },
};

export function statusLabel(status: TicketStatus): string {
  return t(`partner.support.status.${status}` as MessageKey);
}

export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  const view = STATUS_VIEW[status] ?? STATUS_VIEW.open;
  return (
    <Badge tone={view.tone}>
      <view.Icon aria-hidden="true" className="size-3.5" />
      {statusLabel(status)}
    </Badge>
  );
}

export function priorityLabel(priority: TicketPriority): string {
  return t(`partner.support.priority.${priority === 'low' || priority === 'urgent' ? priority : 'normal'}` as MessageKey);
}

const FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
});

export function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${FMT.format(d)} UTC`;
}

const LINK = 'text-[14px] font-semibold text-ds-primary underline-offset-4 hover:underline';

/** A list of ticket rows (cards on a phone; the whole row is the link target). */
export function TicketRows({ rows, meta }: { rows: Ticket[]; meta: (row: Ticket) => string[] }) {
  return (
    <ul className="flex flex-col gap-3">
      {rows.map((row) => (
        <li key={row.id} className="rounded-ds-card border border-ds-border bg-ds-surface p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <Link href={`/partner/support/${row.id}`} className={`${LINK} min-w-0 break-words text-[15px]`}>
              {row.subject}
            </Link>
            <TicketStatusBadge status={row.status} />
          </div>
          <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[13.5px] text-ds-ink-muted">
            {meta(row).map((m, i) => (
              <span key={i}>{m}</span>
            ))}
          </p>
        </li>
      ))}
    </ul>
  );
}

export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <p className="mb-4">
      <Link href={href} className={LINK}>
        <span aria-hidden="true">← </span>
        {label}
      </Link>
    </p>
  );
}

/** A section that could not be loaded: fixed copy only (never an error message). */
export function LoadError({ message }: { message: string }) {
  return (
    <div role="alert" className="rounded-ds-card border border-ds-border bg-ds-surface p-6 text-[15px] text-ds-ink-muted">
      {message}
    </div>
  );
}
