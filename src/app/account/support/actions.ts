'use server';

import { notFound, redirect } from 'next/navigation';
import { getDb } from '@/db/client';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { requireCustomer } from '@/lib/customer-auth';
import { newTransferId } from '@/lib/id';
import { getPartnerStore } from '@/lib/partner-store';
import { getStore } from '@/lib/store';
import type { Customer, Partner } from '@/lib/types';

/**
 * /account/support server actions (customer support center, B2).
 *
 * Server actions are PUBLIC POST endpoints — no page gates them. Each action:
 *  - re-derives identity from the session (requireCustomer); the form is never
 *    trusted for partnerId or phone,
 *  - re-reads the partner's admin kill switch (enableSupportPortal),
 *  - re-validates ownership/scope server-side (404-never-403 for tickets),
 *  - re-validates the optional transfer link against the customer's OWN rows.
 *
 * Failure UX is redirect-with-code: the support pages are plain server
 * components (no client islands), so refusals bounce back to the form with
 * ?error=<code> and the page renders the friendly message.
 */

const MAX_OPEN_TICKETS = 5;
/** Statuses that count against the per-customer open-ticket cap. */
const OPEN_STATUSES = new Set<string>(['open', 'pending', 'waiting_admin']);

/** The customer's partner row (the admin-controlled support kill switch lives on it). */
async function customerPartner(customer: Customer): Promise<Partner> {
  return (
    (await getPartnerStore().getPartner(customer.partnerId)) ??
    (await getPartnerStore().ensureDefaultPartner())
  );
}

/** enableSupportPortal defaults to TRUE when supportConfig is absent. */
function portalDisabled(partner: Partner): boolean {
  return partner.supportConfig?.enableSupportPortal === false;
}

export async function createTicketAction(formData: FormData): Promise<void> {
  const customer = await requireCustomer();

  // Admin kill switch — the pages hide themselves when it's off, but hiding a
  // page never gates a POST endpoint. Off ⇒ bounce to the support landing
  // (which renders the "handled in WhatsApp" note); nothing is created.
  if (portalDisabled(await customerPartner(customer))) redirect('/account/support');

  const subject = String(formData.get('subject') ?? '').trim();
  const body = String(formData.get('message') ?? '').trim();
  const transferId = String(formData.get('transferId') ?? '').trim();

  if (subject.length < 3 || subject.length > 120) redirect('/account/support/new?error=subject');
  if (body.length < 10 || body.length > 2000) redirect('/account/support/new?error=message');

  const repo = createTicketRepo(getDb());

  // Polite cap: at most 5 concurrently-open requests per customer. Resolved
  // and closed tickets don't count.
  const mine = await repo.listByCustomer(customer.senderPhone);
  if (mine.filter((t) => OPEN_STATUSES.has(t.status)).length >= MAX_OPEN_TICKETS) {
    redirect('/account/support/new?error=cap');
  }

  // Optional transfer link — RE-VALIDATED against the customer's OWN last 10
  // transfers (the exact set the form offered). A forged id belonging to
  // another customer is refused and never persisted.
  if (transferId) {
    const own = await getStore().listTransfersByPhone(customer.senderPhone, 10);
    if (!own.some((t) => t.id === transferId)) redirect('/account/support/new?error=transfer');
  }

  // partnerId + customerPhone come from the SESSION — hostile form fields with
  // the same names are ignored.
  const ticket = await repo.createTicket({
    id: `tk_${newTransferId()}`,
    partnerId: customer.partnerId,
    kind: 'customer',
    customerPhone: customer.senderPhone,
    ...(transferId ? { transferId } : {}),
    subject,
    body,
  });

  redirect(`/account/support/${ticket.id}`);
}

export async function replyToTicketAction(ticketId: string, formData: FormData): Promise<void> {
  const customer = await requireCustomer();

  if (portalDisabled(await customerPartner(customer))) redirect('/account/support');

  const repo = createTicketRepo(getDb());

  // Ownership re-check INSIDE the action (the thread page's check gates
  // nothing). 404-never-403: someone else's ticket — or an internal one — is
  // indistinguishable from a ticket that doesn't exist. The bound route param
  // is authoritative; any ticket id in the form body is ignored.
  const ticket = await repo.getTicket(ticketId);
  if (!ticket || ticket.kind !== 'customer' || ticket.customerPhone !== customer.senderPhone) {
    notFound();
  }

  // Closed is terminal and read-only — the page hides the reply box, and the
  // action refuses independently.
  if (ticket.status === 'closed') redirect(`/account/support/${ticket.id}?error=closed`);

  const body = String(formData.get('message') ?? '').trim();
  if (body.length < 1 || body.length > 2000) redirect(`/account/support/${ticket.id}?error=message`);

  await repo.appendMessage({
    ticketId: ticket.id,
    actorType: 'customer',
    actorId: customer.senderPhone,
    body,
  });

  // A reply on a "waiting for you" ticket puts it back in the staff queue.
  if (ticket.status === 'pending') await repo.updateStatus(ticket.id, 'open');

  redirect(`/account/support/${ticket.id}`);
}
