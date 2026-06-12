import { Badge } from '@/components/ui/badge';
import type { TicketStatus } from '@/lib/types';

// Internal-facing status labels (this surface is staff-only, so waiting_admin
// is shown as-is — the customer-facing "In progress" euphemism lives elsewhere).
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
