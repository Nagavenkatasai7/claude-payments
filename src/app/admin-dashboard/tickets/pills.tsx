import type { ReactNode } from 'react';
import type { TicketPriority, TicketStatus } from '@/lib/types';
import { formatSlaDuration, type SlaInfo } from '@/lib/ticket-sla';

// Ticket status/priority pills — same Radix-ramp recipe as the transactions
// pills (transactions-tabs.tsx); server-safe (no hooks, no client directive).

const PILL_BASE =
  'inline-flex items-center gap-[5px] whitespace-nowrap rounded-full border px-[9px] py-[2px] text-[11.5px] font-semibold';
const PILL = {
  success: 'border-[#adddc0] bg-[#effaf2] text-[#1a7049]',
  warning: 'border-[#f3d673] bg-[#fdfbe7] text-[#9a5b00]',
  danger: 'border-[#fdbdbe] bg-[#feebec] text-[#ce2c31]',
  info: 'border-[#acd8fc] bg-[#eff6ff] text-[#0a5fa8]',
  neutral: 'border-[#d9d9e0] bg-[#f0f0f3] text-[#60646c]',
} as const;
const PILL_DOT = {
  success: 'bg-[#30a46c]',
  warning: 'bg-[#ffc53d]',
  danger: 'bg-[#e5484d]',
  info: 'bg-[#0090ff]',
  neutral: 'bg-[#8b8d98]',
} as const;
type PillTone = keyof typeof PILL;

function Pill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return (
    <span className={`${PILL_BASE} ${PILL[tone]}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${PILL_DOT[tone]}`}></span>
      {children}
    </span>
  );
}

export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  open: 'Open',
  pending: 'Waiting on customer',
  waiting_admin: 'Escalated',
  resolved: 'Resolved',
  closed: 'Closed',
};

export function TicketStatusPill({ status }: { status: TicketStatus }) {
  const tone: PillTone =
    status === 'open' ? 'info'
    : status === 'pending' ? 'warning'
    : status === 'waiting_admin' ? 'danger'
    : status === 'resolved' ? 'success'
    : 'neutral';
  return <Pill tone={tone}>{TICKET_STATUS_LABEL[status]}</Pill>;
}

export function TicketPriorityPill({ priority }: { priority: TicketPriority }) {
  const tone: PillTone =
    priority === 'urgent' ? 'danger' : priority === 'low' ? 'neutral' : 'info';
  return <Pill tone={tone}>{priority === 'urgent' ? 'Urgent' : priority === 'low' ? 'Low' : 'Normal'}</Pill>;
}

/**
 * Program-Fix 49C: the STAFF-ONLY "Age / SLA" pill (internal first-response
 * target — never shown to customers). Age since the ticket opened, then the
 * first-response state: time left, overdue by, or replied (on time / late).
 */
export function TicketSlaPill({ sla, now }: { sla: SlaInfo; now: Date }) {
  const age = formatSlaDuration(sla.ageMs);
  const left = sla.dueAt.getTime() - now.getTime();
  const [tone, text]: [PillTone, string] =
    sla.state === 'breached' ? ['danger', `${age} · no reply, ${formatSlaDuration(-left)} over`]
    : sla.state === 'due_soon' ? ['warning', `${age} · reply due in ${formatSlaDuration(left)}`]
    : sla.state === 'ok' ? ['info', `${age} · reply due in ${formatSlaDuration(left)}`]
    : sla.state === 'met' ? ['success', `${age} · replied on time`]
    : sla.state === 'late' ? ['neutral', `${age} · replied late`]
    : ['neutral', age];
  return <Pill tone={tone}>{text}</Pill>;
}
