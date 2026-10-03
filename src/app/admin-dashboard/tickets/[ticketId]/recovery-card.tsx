import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getCustomerMfaStore } from '@/lib/customer-mfa';
import { RECOVERY_COOL_OFF_MS, isRecoveryTicket, recoveryTimeLabel } from '@/lib/customer-mfa-recovery-rules';
import { logWarn } from '@/lib/log';
import type { Staff, Ticket } from '@/lib/types';
import { PlatformRecoveryForms } from './recovery-forms';

// The two-step recovery card on /admin-dashboard/tickets/[ticketId] (lost-features p4 B4). The page
// mounts it for every ticket it shows; it renders only for a recovery request. Every ticket worker
// who can open the ticket sees the request time, whether two-step verification is on now and when
// the 24-hour wait ends (support and agents read only). The decision forms are for PLATFORM admins
// (role admin, no tenant) on an open request, including one a partner escalated. UX only: the
// actions re-gate everything.

export async function PlatformRecoveryCard({ ticket, staff }: { ticket: Ticket; staff: Staff }) {
  if (!isRecoveryTicket(ticket)) return null;
  let on: boolean | null = null;
  try {
    on = await getCustomerMfaStore().isEnrolled({ partnerId: ticket.partnerId, phone: ticket.customerPhone });
  } catch (err) {
    logWarn('tickets.mfaRecovery.card', err instanceof Error ? err.name : 'error', { ticketId: ticket.id });
  }
  const requestedAt = Date.parse(ticket.createdAt);
  const open = ticket.status !== 'resolved' && ticket.status !== 'closed';
  const canDecide = staff.role === 'admin' && staff.partnerId === undefined;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Two-step recovery</CardTitle>
        <CardDescription>
          The customer asked to turn off two-step verification because they lost their authenticator app. Check it is
          them before you approve.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Requested</span>
          <span className="text-xs">{recoveryTimeLabel(requestedAt)}</span>
        </div>
        {on !== null && (
          <p role="status" className="font-semibold">
            {on ? 'Two-step verification is on' : 'Two-step verification is already off'}
          </p>
        )}
        {!open ? (
          <p className="text-muted-foreground">This request was handled.</p>
        ) : canDecide ? (
          <PlatformRecoveryForms ticketId={ticket.id} waitUntil={recoveryTimeLabel(requestedAt + RECOVERY_COOL_OFF_MS)} />
        ) : (
          <p className="text-muted-foreground">Only a SmartRemit admin can approve or decline this request.</p>
        )}
      </CardContent>
    </Card>
  );
}
