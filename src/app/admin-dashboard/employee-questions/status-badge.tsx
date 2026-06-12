import { Badge } from '@/components/ui/badge';
import type { TicketStatus } from '@/lib/types';

// Small shared UI bits for the employee-questions surface.

// One textarea recipe for the ask / reply / answer forms (no shadcn Textarea
// component in the kit — mirrors the SELECT_CLASS idiom on sibling pages).
export const TEXTAREA_CLASS =
  'min-h-24 w-full rounded-md border border-input bg-card px-3 py-2 text-sm';

// Internal-facing status labels (this surface is staff-only, so waiting_admin
// is shown as-is — the customer-facing "In progress" euphemism lives elsewhere).
// Exhaustive over TicketStatus — the queue page derives its filter row from
// these keys, so a new status can't silently miss the filter.
export const STATUS_LABEL: Record<TicketStatus, string> = {
  open: 'open',
  pending: 'pending',
  waiting_admin: 'waiting admin',
  resolved: 'resolved',
  closed: 'closed',
};

export function QuestionStatusBadge({ status }: { status: TicketStatus }) {
  switch (status) {
    case 'open':
      return <Badge variant="secondary">{STATUS_LABEL.open}</Badge>;
    case 'pending':
      return <Badge variant="outline">{STATUS_LABEL.pending}</Badge>;
    case 'waiting_admin':
      return <Badge variant="default">{STATUS_LABEL.waiting_admin}</Badge>;
    case 'resolved':
      return (
        <Badge variant="outline" className="border-success/50 text-success">
          {STATUS_LABEL.resolved}
        </Badge>
      );
    case 'closed':
      return (
        <Badge variant="outline" className="text-muted-foreground">
          {STATUS_LABEL.closed}
        </Badge>
      );
  }
}
