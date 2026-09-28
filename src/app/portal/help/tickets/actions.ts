'use server';

import { notFound, redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requirePortalSite } from '@/lib/portal-site';
import { requirePortalCustomer } from '@/lib/portal-auth';
import {
  countOpenPortalTickets,
  createPortalTicket,
  getPortalTicket,
  portalSupportEnabled,
  portalTicketOwner,
  portalTicketTransfers,
  replyToPortalTicket,
} from '@/lib/portal-tickets';
import { MAX_OPEN_TICKETS, validateNewTicket, validateTicketReply } from '@/lib/ticket-input';
import { BadRequestKeyError, RequestInFlightError, runOnce } from '@/lib/portal-request-key';
import { getRedis } from '@/lib/redis';
import { logWarn } from '@/lib/log';
import type { MessageKey } from '@/lib/i18n';

/**
 * The customer portal's Help & tickets actions (UI redesign M2-12, Task 12.2). PUBLIC POST endpoints
 * (Next's Origin-vs-Host check applies), each in this order:
 *  1. requirePortalSite() FIRST (the dark-by-default host gate; the scanner pins it);
 *  2. requirePortalCustomer(): the session bound to THIS host (another partner's cookie is signed out);
 *  3. the partner's support kill switch (hiding a page never gates a POST);
 *  4. validation (the legacy rules, src/lib/ticket-input.ts); the optional transfer is re-validated
 *     against the customer's OWN last 10 transfers on this partner;
 *  5. ownership for a reply: getPortalTicket(host partner, session phone, id) or notFound(), the
 *     same 404 for a missing, foreign or malformed id;
 *  6. runOnce on the server-minted request key: a double submit makes one ticket or one message;
 *  7. the write + audit (+ triage) in one transaction, then redirect OUTSIDE any try (redirect throws).
 * Results are fixed copy keys; the identity never comes from the form.
 */

export type PortalTicketState = { error: MessageKey } | null;

const field = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === 'string' ? v : '';
};

function failed(err: unknown, label: string): PortalTicketState {
  if (err instanceof BadRequestKeyError) return { error: 'portal.help.error.expired' };
  if (err instanceof RequestInFlightError) return { error: 'portal.help.error.in_flight' };
  logWarn(label, err);
  return { error: 'portal.help.error.failed' };
}

/** Start a support request. On success it redirects to the new ticket. */
export async function createPortalTicketAction(_prev: PortalTicketState, formData: FormData): Promise<PortalTicketState> {
  await requirePortalSite();
  const ctx = await requirePortalCustomer();
  const owner = portalTicketOwner(ctx);
  if (!(await portalSupportEnabled(owner.partnerId))) return { error: 'portal.help.error.support_off' };

  const input = validateNewTicket({ subject: field(formData, 'subject'), message: field(formData, 'message') });
  if (!input.ok) return { error: input.error === 'subject' ? 'portal.help.error.subject' : 'portal.help.error.message' };

  const transferId = field(formData, 'transferId').trim();
  if (transferId) {
    const own = await portalTicketTransfers(owner);
    if (!own.some((t) => t.id === transferId)) return { error: 'portal.help.error.transfer' };
  }

  let result: { code: string; ticketId: string };
  try {
    ({ value: result } = await runOnce(getRedis(), 'portal-ticket', owner.partnerId, owner.phone, field(formData, 'requestKey'), async () => {
      // The cap runs inside the claim, so a replay returns the first answer, never a late "cap".
      if ((await countOpenPortalTickets(owner)) >= MAX_OPEN_TICKETS) return { code: 'cap', ticketId: '' };
      const ticketId = await createPortalTicket(owner, { subject: input.subject, body: input.body, ...(transferId ? { transferId } : {}) });
      return { code: 'created', ticketId };
    }));
  } catch (err) {
    return failed(err, 'portal.ticket.create');
  }
  if (result.code !== 'created' || !result.ticketId) return { error: result.code === 'cap' ? 'portal.help.error.cap' : 'portal.help.error.failed' };
  revalidatePath('/portal/help/tickets');
  redirect(`/portal/help/tickets/${result.ticketId}`);
}

/** Reply on the customer's own ticket. The bound route id is re-scoped here; any body id is ignored. */
export async function replyPortalTicketAction(ticketId: string, _prev: PortalTicketState, formData: FormData): Promise<PortalTicketState> {
  await requirePortalSite();
  const ctx = await requirePortalCustomer();
  const owner = portalTicketOwner(ctx);
  if (!(await portalSupportEnabled(owner.partnerId))) return { error: 'portal.help.error.support_off' };

  const ticket = await getPortalTicket(owner, ticketId);
  if (!ticket) notFound();
  if (ticket.status === 'closed') return { error: 'portal.help.error.closed' };

  const reply = validateTicketReply(field(formData, 'message'));
  if (!reply.ok) return { error: 'portal.help.error.reply' };

  try {
    await runOnce(getRedis(), 'portal-ticket-reply', owner.partnerId, owner.phone, field(formData, 'requestKey'), async () => {
      await replyToPortalTicket(owner, ticket, reply.body);
      return { ticketId: ticket.id };
    });
  } catch (err) {
    return failed(err, 'portal.ticket.reply');
  }
  revalidatePath(`/portal/help/tickets/${ticket.id}`);
  revalidatePath('/portal/help/tickets');
  redirect(`/portal/help/tickets/${ticket.id}`);
}
