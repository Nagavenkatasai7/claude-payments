import { getDb } from '@/db/client';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { newTransferId } from './id';
import { enqueueTriage } from './ticket-triage';
import { getPartnerStore } from './partner-store';
import { getStore } from './store';
import { auditSubjectId } from './customer-ref';
import { PORTAL_AUTH_ACTOR } from './portal-auth-audit';
import type { MessageKey } from './i18n';
import type { Tone } from './ui/transfer-status';
import type { PartnerId, Ticket, TicketStatus, Transfer } from './types';

/**
 * portal-tickets — the customer portal's Help & tickets reads and writes (UI redesign M2-12).
 *
 * The owner is ALWAYS (host partner, session phone): callers pass portalTicketOwner(ctx), never a
 * form field. Every read is tenant + customer scoped in the WHERE (ticket-repo
 * listByCustomerInTenant / getCustomerTicketInTenant / countOpenByCustomerInTenant). The thread view
 * excludes internal notes in the WHERE and never carries a staff id. Bodies are sealed by the repo.
 * Writes run in ONE transaction with their audit row (`ticket.create` / `ticket.reply`, meta
 * `{ ticketId }` only: never the subject or a body) and, for a new ticket, the triage outbox row.
 */

export interface PortalTicketOwner {
  partnerId: PartnerId;
  phone: string;
}

/** The owner from a resolved portal session: the host partner and the session phone. */
export function portalTicketOwner(ctx: { site: { partnerId: PartnerId }; session: { phone: string } }): PortalTicketOwner {
  return { partnerId: ctx.site.partnerId, phone: ctx.session.phone };
}

/** Ticket ids are `tk_` + a base64url id; anything else never reaches the DB. */
export const PORTAL_TICKET_ID_RE = /^tk_[A-Za-z0-9_-]{1,64}$/;

/** The partner's admin kill switch (supportConfig.enableSupportPortal, default on). A missing partner is off. */
export async function portalSupportEnabled(partnerId: PartnerId): Promise<boolean> {
  const partner = await getPartnerStore().getPartner(partnerId);
  return !!partner && partner.supportConfig?.enableSupportPortal !== false;
}

export async function listPortalTickets(owner: PortalTicketOwner, limit = 50): Promise<Ticket[]> {
  return createTicketRepo(getDb()).listByCustomerInTenant(owner.partnerId, owner.phone, limit);
}

/** The customer's own ticket on this partner, or null (missing, foreign and malformed alike). */
export async function getPortalTicket(owner: PortalTicketOwner, id: unknown): Promise<Ticket | null> {
  if (typeof id !== 'string' || !PORTAL_TICKET_ID_RE.test(id)) return null;
  return createTicketRepo(getDb()).getCustomerTicketInTenant(owner.partnerId, owner.phone, id);
}

/** No row id: the sequential message id would leak platform-wide message volume. */
export interface PortalTicketMessage {
  /** True for the customer's own messages; staff and system lines are shown as "Support". */
  mine: boolean;
  body: string;
  createdAt: string;
}

/** The customer view of a thread. Call only with an id from getPortalTicket (ownership is checked there). */
export async function listPortalTicketMessages(ticketId: string): Promise<PortalTicketMessage[]> {
  const rows = await createTicketRepo(getDb()).listMessages(ticketId, { includeInternal: false });
  return rows.map((m) => ({ mine: m.actorType === 'customer', body: m.body, createdAt: m.createdAt }));
}

/** The customer's OWN last 10 transfers on this partner: the only ids the ticket form offers and accepts. */
export async function portalTicketTransfers(owner: PortalTicketOwner): Promise<Transfer[]> {
  return getStore().listTransfersByPhone(owner.partnerId, owner.phone, 10);
}

export async function countOpenPortalTickets(owner: PortalTicketOwner): Promise<number> {
  return createTicketRepo(getDb()).countOpenByCustomerInTenant(owner.partnerId, owner.phone);
}

function auditRow(owner: PortalTicketOwner, action: 'ticket.create' | 'ticket.reply', ticketId: string) {
  return {
    partnerId: owner.partnerId,
    actor: PORTAL_AUTH_ACTOR,
    actorType: 'system' as const,
    action,
    subjectId: auditSubjectId(owner.partnerId, owner.phone),
    meta: { ticketId },
  };
}

/** Create the ticket + first message + audit + triage outbox row in ONE transaction. Returns the id. */
export async function createPortalTicket(
  owner: PortalTicketOwner,
  input: { subject: string; body: string; transferId?: string },
): Promise<string> {
  const id = `tk_${newTransferId()}`;
  await getDb().transaction(async (tx) => {
    await createTicketRepo(tx).createTicket({
      id,
      partnerId: owner.partnerId,
      kind: 'customer',
      customerPhone: owner.phone,
      ...(input.transferId ? { transferId: input.transferId } : {}),
      subject: input.subject,
      body: input.body,
    });
    await createAuditRepo(tx).record(auditRow(owner, 'ticket.create', id));
    // The same durable triage row as the legacy action (deduped per ticket), committed with the ticket.
    await enqueueTriage(tx, id);
  });
  return id;
}

/** Append the customer's reply (+ pending → open) and its audit row in ONE transaction. */
export async function replyToPortalTicket(owner: PortalTicketOwner, ticket: Ticket, body: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    const repo = createTicketRepo(tx);
    await repo.appendMessage({ ticketId: ticket.id, actorType: 'customer', actorId: owner.phone, body });
    // A reply on a "waiting for you" ticket puts it back in the staff queue (legacy parity).
    if (ticket.status === 'pending') await repo.updateStatus(ticket.id, 'open');
    await createAuditRepo(tx).record(auditRow(owner, 'ticket.reply', ticket.id));
  });
}

const STATUS_VIEW: Record<TicketStatus, { label: MessageKey; tone: Tone }> = {
  open: { label: 'portal.help.status.open', tone: 'info' },
  waiting_admin: { label: 'portal.help.status.waiting_admin', tone: 'info' },
  pending: { label: 'portal.help.status.pending', tone: 'warning' },
  resolved: { label: 'portal.help.status.resolved', tone: 'success' },
  closed: { label: 'portal.help.status.closed', tone: 'neutral' },
};

/** A ticket status as a label key + tone (the label always carries the meaning, never colour alone). */
export function ticketStatusView(status: TicketStatus): { label: MessageKey; tone: Tone } {
  return STATUS_VIEW[status] ?? STATUS_VIEW.open;
}
