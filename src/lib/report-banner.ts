import { caseOpenedReply } from './legal/error-notice-drafts';
import type { PartnerId, Ticket } from './types';

/**
 * Fix pack 8 (R44, P11, T14): the case text a page shows after a report (`?case=<ticketId>`).
 * Pure: it reads nothing. The ticket id comes from the URL, so the text renders ONLY for the
 * viewer's own classed case on THIS transfer (partner, phone and transfer all match, a class and a
 * parseable due date are set); anything else is null, so a forged `?case=` shows nothing (no leak).
 * T15 extends it for the ticket page.
 */
export function caseBannerFor(
  ticket: Ticket | null,
  viewer: { partnerId: PartnerId; phone: string },
  o: { transferId: string; reused: boolean; providerLine: string | null },
): string | null {
  if (!ticket) return null;
  if (ticket.partnerId !== viewer.partnerId || ticket.customerPhone !== viewer.phone) return null;
  if (!ticket.transferId || ticket.transferId !== o.transferId) return null;
  if (!ticket.regClass || !ticket.dueAt || !Number.isFinite(Date.parse(ticket.dueAt))) return null;
  return caseOpenedReply({ caseId: ticket.id, dueAt: ticket.dueAt, providerLine: o.providerLine, reused: o.reused, surface: 'page' });
}
