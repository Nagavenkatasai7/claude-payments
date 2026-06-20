import { NextResponse, type NextRequest } from 'next/server';
import { getCurrentStaff } from '@/lib/auth';
import { scopeOf, canSee } from '@/lib/staff-scope';
import { getDb } from '@/db/client';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { getRedis } from '@/lib/redis';
import { checkCopilotRateLimit, draftReply } from '@/lib/ticket-ai';

export const dynamic = 'force-dynamic';

// /api/copilot/draft-reply — one suggested customer reply for the panel.
//
// SELF-GATED: the middleware matcher covers /admin-dashboard and /account
// only — /api/copilot gets NO edge gate, so this route enforces the
// requireSupportOrAdmin contract itself (staff session + support|admin role),
// returning JSON statuses instead of the page-shaped redirects. The ticket is
// then re-resolved UNDER THE CALLER'S SCOPE (getOwnedTicket for partner
// staff) before a single byte reaches the model.

export async function POST(req: NextRequest) {
  const staff = await getCurrentStaff();
  if (!staff) return NextResponse.json({ ok: false }, { status: 401 });
  // Ticket-capable roles: support, admin, and agents (agents are load-balanced
  // ticket handlers). The per-ticket assignee gate below restricts agents to
  // their OWN assigned tickets.
  if (staff.role !== 'support' && staff.role !== 'admin' && staff.role !== 'agent') {
    return NextResponse.json({ ok: false }, { status: 403 });
  }
  const scope = scopeOf(staff);

  // 60 calls/hour per staff member; FAIL-OPEN on limiter errors (a Redis
  // outage must never take the copilot down — same posture as ip-rate-limit).
  try {
    const allowed = await checkCopilotRateLimit(getRedis(), staff.username);
    if (!allowed) {
      return NextResponse.json(
        { ok: false, error: 'Copilot rate limit reached — try again later.' },
        { status: 429 },
      );
    }
  } catch {
    /* fail-open */
  }

  let ticketId = '';
  try {
    const body = (await req.json()) as { ticketId?: unknown };
    if (typeof body.ticketId === 'string') ticketId = body.ticketId;
  } catch {
    /* malformed body falls through to the 404 below */
  }
  if (!ticketId) return NextResponse.json({ ok: false }, { status: 404 });

  const repo = createTicketRepo(getDb());
  const ticket =
    scope.kind === 'partner'
      ? await repo.getOwnedTicket(scope.partnerId, ticketId)
      : await repo.getTicket(ticketId);
  if (!ticket || ticket.kind !== 'customer') {
    return NextResponse.json({ ok: false }, { status: 404 });
  }
  // Agents may copilot ONLY a ticket assigned to them (same assignee gate as the
  // ticket actions) — opaque 404, no oracle over tickets they don't own.
  if (staff.role === 'agent' && ticket.assignedTo !== staff.username) {
    return NextResponse.json({ ok: false }, { status: 404 });
  }

  // Customer-facing draft: fetch ONLY the customer-visible thread (draftReply
  // re-filters internal notes as defense-in-depth, but the raw notes never
  // even enter this handler). The linked-transfer context is the MASKED
  // default ledger read — the model never sees a full payout destination.
  const [messages, linkedTransfer] = await Promise.all([
    repo.listMessages(ticket.id, { includeInternal: false }),
    ticket.transferId
      ? createTransferRepo(getDb()).getTransfer(ticket.transferId)
      : Promise.resolve(null),
  ]);
  let customerContext = '';
  if (linkedTransfer && canSee(scope, linkedTransfer.partnerId)) {
    customerContext =
      `Linked transfer ${linkedTransfer.id}: status ${linkedTransfer.status}, ` +
      `${linkedTransfer.amountSource} ${linkedTransfer.sourceCurrency} to ` +
      `${linkedTransfer.recipientName} (${linkedTransfer.payoutDestination}), ` +
      `created ${linkedTransfer.createdAt}`;
  }

  try {
    const draft = await draftReply(ticket, messages, customerContext);
    await createAuditRepo(getDb()).record({
      partnerId: ticket.partnerId,
      actor: staff.username,
      actorType: 'staff',
      action: 'copilot.draft',
      subjectId: ticket.id,
    });
    return NextResponse.json({ ok: true, draft });
  } catch {
    // Quiet degradation — the panel shows "AI unavailable"; manual work continues.
    return NextResponse.json({ ok: false, error: 'AI unavailable' }, { status: 502 });
  }
}
