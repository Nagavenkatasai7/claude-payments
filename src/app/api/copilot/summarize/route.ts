import { NextResponse, type NextRequest } from 'next/server';
import { getCurrentStaff } from '@/lib/auth';
import { scopeOf } from '@/lib/staff-scope';
import { getDb } from '@/db/client';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { getRedis } from '@/lib/redis';
import {
  checkCopilotRateLimit,
  summarizeCase,
  triageSuggest,
  type TriageSuggestion,
} from '@/lib/ticket-ai';

export const dynamic = 'force-dynamic';

// /api/copilot/summarize — a 5-line staff-facing case summary plus a triage
// suggestion (category/priority chips; Apply runs the audited server action).
//
// SELF-GATED like draft-reply: /api/copilot has NO middleware cover, so the
// requireSupportOrAdmin contract is enforced inline (JSON statuses, not
// redirects), then the ticket is re-resolved under the caller's scope.

export async function POST(req: NextRequest) {
  const staff = await getCurrentStaff();
  if (!staff) return NextResponse.json({ ok: false }, { status: 401 });
  if (staff.role !== 'support' && staff.role !== 'admin') {
    return NextResponse.json({ ok: false }, { status: 403 });
  }
  const scope = scopeOf(staff);

  // Shared 60/h per-staff budget with draft-reply; fail-open on limiter errors.
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

  const messages = await repo.listMessages(ticket.id, { includeInternal: true });

  try {
    // Two independent one-shot model calls — run them in parallel. Triage is
    // best-effort garnish on the summary: its failure must not take the
    // summary down with it (a failed summary still 502s the whole response).
    const first = messages.find((m) => !m.internal);
    const [summary, triage] = await Promise.all([
      summarizeCase(ticket, messages),
      triageSuggest(ticket.subject, first?.body ?? '').catch((): TriageSuggestion | null => null),
    ]);
    await createAuditRepo(getDb()).record({
      partnerId: ticket.partnerId,
      actor: staff.username,
      actorType: 'staff',
      action: 'copilot.summarize',
      subjectId: ticket.id,
      meta: triage ? { triage } : undefined,
    });
    return NextResponse.json({ ok: true, summary, triage });
  } catch {
    return NextResponse.json({ ok: false, error: 'AI unavailable' }, { status: 502 });
  }
}
