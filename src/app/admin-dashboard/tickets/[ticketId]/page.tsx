export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireTicketWorker } from '@/lib/auth';
import { getAuthStore } from '@/lib/auth-store';
import { scopeOf, canSee } from '@/lib/staff-scope';
import { isTestStaff } from '@/lib/ticket-balancer';
import { getDb } from '@/db/client';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { getPartnerStore } from '@/lib/partner-store';
import { Sidebar } from '../../sidebar';
import { money } from '../../format';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TicketStatusPill, TicketPriorityPill } from '../pills';
import { CopilotPanel } from '../copilot-panel';
import {
  replyAction,
  internalNoteAction,
  assignTicketAction,
  escalateAction,
  resolveAction,
  closeAction,
  applyTriageAction,
  copilotRejectAction,
} from '../actions';
import type { TicketMessage, Transfer } from '@/lib/types';

// Ticket detail (B3). Scope is enforced at the READ: partner staff resolve the
// ticket via getOwnedTicket (404-never-403), platform staff via getTicket.
// Internal notes render visually distinct and are clearly staff-only; the
// linked transfer summary uses the DEFAULT masked ledger read.

function MessageBubble({ m }: { m: TicketMessage }) {
  const who =
    m.actorType === 'customer' ? `Customer ${m.actorId}`
    : m.actorType === 'system' ? 'System'
    : m.actorId;
  return (
    <div
      className={`rounded-lg border px-3.5 py-2.5 ${
        m.internal
          ? 'border-dashed border-border bg-muted'
          : m.actorType === 'customer'
            ? 'border-border bg-background'
            : 'border-primary/20 bg-primary/5'
      }`}
    >
      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">{who}</span>
        <span>{new Date(m.createdAt).toLocaleString()}</span>
        {m.internal && <Badge variant="outline" className="text-[10px] uppercase">Internal</Badge>}
      </div>
      <div className="text-sm whitespace-pre-wrap">{m.body}</div>
    </div>
  );
}

export default async function TicketDetailPage({
  params,
}: {
  params: Promise<{ ticketId: string }>;
}) {
  const { staff, scope } = await requireTicketWorker();
  const { ticketId } = await params;
  const isAgent = staff.role === 'agent';

  const repo = createTicketRepo(getDb());
  const ticket =
    scope.kind === 'partner'
      ? await repo.getOwnedTicket(scope.partnerId, ticketId)
      : await repo.getTicket(ticketId);
  // Out-of-scope, missing, or internal-kind ids all collapse to the same 404 —
  // and an agent may only open a ticket assigned to THEM (assignee-scoped, same
  // opaque 404 so it's no oracle over which tickets exist).
  if (!ticket || ticket.kind !== 'customer') notFound();
  if (isAgent && ticket.assignedTo !== staff.username) notFound();

  // The four reads below are independent once the ticket is in hand — fetch in parallel.
  const [messages, linkedTransfer, allStaff, partner] = await Promise.all([
    repo.listMessages(ticket.id, { includeInternal: true }),
    ticket.transferId
      ? createTransferRepo(getDb()).getTransfer(ticket.transferId)
      : Promise.resolve(null),
    getAuthStore().listStaff(),
    scope.kind === 'platform'
      ? getPartnerStore().getPartner(ticket.partnerId)
      : Promise.resolve(null),
  ]);

  // Linked transfer summary — MASKED default read, double-scoped (the ticket
  // is already in scope; the transfer must be too before we show anything).
  const transfer: Transfer | null =
    linkedTransfer && canSee(scope, linkedTransfer.partnerId) ? linkedTransfer : null;

  // Assign dropdown (support/admin only — agents can't reassign): active, real
  // (non-test) staff of any ticket-capable role — support, admin, AND agents,
  // who are now first-class ticket handlers — whose scope can see this ticket's
  // tenant. Same rule the action re-validates. Skipped entirely for agents.
  const assignable = isAgent
    ? []
    : allStaff.filter(
        (s) =>
          s.status !== 'suspended' &&
          !isTestStaff(s) &&
          canSee(scopeOf(s), ticket.partnerId),
      );
  const closed = ticket.status === 'closed';

  return (
    <>
      <Sidebar active="tickets" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">{ticket.subject}</div>
            <div className="sh-page-sub">
              Ticket {ticket.id} · opened {new Date(ticket.createdAt).toLocaleString()}
            </div>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/admin-dashboard/tickets">← Back to queue</Link>
          </Button>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Conversation</CardTitle>
                <CardDescription>
                  Internal notes are staff-only — the customer never sees them.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {messages.map((m) => (
                  <MessageBubble key={m.id} m={m} />
                ))}
              </CardContent>
            </Card>

            <CopilotPanel
              ticketId={ticket.id}
              closed={closed}
              replyAction={replyAction}
              applyTriageAction={applyTriageAction}
              copilotRejectAction={copilotRejectAction}
            />

            {!closed && (
              <Card>
                <CardHeader>
                  <CardTitle>Internal note</CardTitle>
                  <CardDescription>Visible to staff only. No customer notification.</CardDescription>
                </CardHeader>
                <CardContent>
                  <form action={internalNoteAction} className="space-y-3">
                    <input type="hidden" name="ticketId" value={ticket.id} />
                    <textarea
                      name="body"
                      required
                      rows={3}
                      placeholder="Add an internal note…"
                      className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-[3px] focus:ring-ring/30"
                    />
                    <Button type="submit" size="sm" variant="outline">Add note</Button>
                  </form>
                </CardContent>
              </Card>
            )}
          </div>

          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2.5 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Status</span>
                  <TicketStatusPill status={ticket.status} />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Priority</span>
                  <TicketPriorityPill priority={ticket.priority} />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Category</span>
                  <span>{ticket.category ?? '—'}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Assignee</span>
                  <span>{ticket.assignedTo ?? 'Unassigned'}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Customer</span>
                  <span className="text-xs">{ticket.customerPhone || '—'}</span>
                </div>
                {partner && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">Partner</span>
                    <span>{partner.name}</span>
                  </div>
                )}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Created</span>
                  <span className="text-xs">{new Date(ticket.createdAt).toLocaleString()}</span>
                </div>
                {ticket.closedAt && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">Closed</span>
                    <span className="text-xs">{new Date(ticket.closedAt).toLocaleString()}</span>
                  </div>
                )}
              </CardContent>
            </Card>

            {!closed && (
              <Card>
                <CardHeader>
                  <CardTitle>Actions</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {!isAgent && (
                    <form action={assignTicketAction} className="space-y-2">
                      <input type="hidden" name="ticketId" value={ticket.id} />
                      <label className="text-xs font-semibold text-muted-foreground uppercase">Assign to</label>
                      <div className="flex gap-2">
                        <select
                          name="assignee"
                          defaultValue={ticket.assignedTo ?? ''}
                          className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
                        >
                          <option value="">Unassigned</option>
                          {/* Keep the current assignee selectable even if they
                              fall out of the eligible list (e.g. later suspended),
                              so submitting unchanged never silently unassigns. */}
                          {ticket.assignedTo &&
                            !assignable.some((s) => s.username === ticket.assignedTo) && (
                              <option value={ticket.assignedTo}>{ticket.assignedTo} (current)</option>
                            )}
                          {assignable.map((s) => (
                            <option key={s.username} value={s.username}>
                              {s.name} ({s.role})
                            </option>
                          ))}
                        </select>
                        <Button type="submit" size="sm" variant="outline">Assign</Button>
                      </div>
                    </form>
                  )}

                  <form action={escalateAction} className="space-y-2">
                    <input type="hidden" name="ticketId" value={ticket.id} />
                    <label className="text-xs font-semibold text-muted-foreground uppercase">Escalate to admins</label>
                    <div className="flex gap-2">
                      <input
                        name="reason"
                        required
                        placeholder="Reason…"
                        className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
                      />
                      <Button type="submit" size="sm" variant="outline">Escalate</Button>
                    </div>
                  </form>

                  <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                    {ticket.status !== 'resolved' && (
                      <form action={resolveAction}>
                        <input type="hidden" name="ticketId" value={ticket.id} />
                        <Button type="submit" size="sm">Resolve</Button>
                      </form>
                    )}
                    <form action={closeAction}>
                      <input type="hidden" name="ticketId" value={ticket.id} />
                      <Button type="submit" size="sm" variant="outline" className="text-destructive">
                        Close ticket
                      </Button>
                    </form>
                  </div>
                </CardContent>
              </Card>
            )}

            {transfer && (
              <Card>
                <CardHeader>
                  <CardTitle>Linked transfer</CardTitle>
                  <CardDescription>Masked ledger read.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2.5 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">Transfer</span>
                    <span className="text-xs font-mono">{transfer.id}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">Status</span>
                    <span className="font-semibold capitalize">{transfer.status.replace(/_/g, ' ')}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">Amount</span>
                    <span className="tabular-nums">{money(transfer.amountSource, transfer.sourceCurrency)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">Recipient</span>
                    <span>{transfer.recipientName}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">Destination</span>
                    <span className="text-xs">{transfer.payoutDestination}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">Created</span>
                    <span className="text-xs">{new Date(transfer.createdAt).toLocaleString()}</span>
                  </div>
                  {staff.role === 'admin' && (
                    <Button asChild size="sm" variant="outline" className="mt-1 w-full">
                      <Link href={`/admin-dashboard/transactions?phone=${encodeURIComponent(transfer.phone)}`}>
                        Open in transactions
                      </Link>
                    </Button>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </main>
    </>
  );
}
