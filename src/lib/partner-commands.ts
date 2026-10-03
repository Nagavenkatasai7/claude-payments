import { t } from '@/lib/i18n';
import type { PartnerRole } from '@/lib/partner-access';
import { PARTNER_ROUTES, routeAllows, type PartnerRouteKey } from '@/app/partner/routes';
import type { MatchableCommand } from './command-match';

// partner-commands (lost-features A16): the items of the /partner command palette. Pure and
// client-safe. "Go to" items come from the ONE route table (routes.ts), filtered by the same
// routeAllows the pages enforce, so the palette never offers a page the role cannot open. Hiding is
// never the guard: every target page re-gates. "Open" items are built on the client from what the
// user types: a transfer or ticket id, for a role that may open that page. The detail pages re-gate
// and 404 a missing or foreign id, so an id here grants nothing.
// No "Review flagged & blocked" item (D6: screening lists are not partner surfaces).

export interface PartnerCommand extends MatchableCommand {
  id: string;
  href: string;
}

/** The bare conversation path only sends back to Customers (a log needs a customer), so it is skipped. */
const SKIPPED: ReadonlySet<PartnerRouteKey> = new Set<PartnerRouteKey>(['customerConversation']);

/** The "Go to" items for a role, in route-table order. An unknown role gets none. */
export function buildPartnerCommands(role: PartnerRole): PartnerCommand[] {
  const group = t('partner.palette.groupGo');
  return (Object.keys(PARTNER_ROUTES) as PartnerRouteKey[])
    .filter((key) => !SKIPPED.has(key) && routeAllows(key, role))
    .map((key) => {
      const r = PARTNER_ROUTES[key];
      // The path words help a search for "webhooks" or "api keys" find the integrations pages.
      const keywords = r.href.split('/').slice(2).join(' ').replace(/-/g, ' ');
      return { id: `go-${key}`, href: r.href, label: t(r.labelKey), group, ...(keywords ? { keywords } : {}) };
    });
}

/** Which "Open <id>" items this role may get (the same rule as the detail pages' gates). */
export interface OpenCommandScope {
  transfers: boolean;
  tickets: boolean;
}

export function openCommandScope(role: PartnerRole): OpenCommandScope {
  return { transfers: routeAllows('transfers', role), tickets: routeAllows('support', role) };
}

export interface OpenCommand {
  kind: 'transfer' | 'ticket';
  id: string;
  href: string;
}

// The same shapes as isTransferId (partner-transfers.ts) and isTicketId (partner-tickets.ts); those
// modules are server-side, so the shapes are restated here and test-pinned against them. Ticket ids
// are `tk_` + an id. A transfer id must look like one (a digit, or the 22-character id length), so
// typing a page name never offers "Open transfer refunds".
const TICKET_RE = /^tk_[A-Za-z0-9_-]{1,77}$/;
const TRANSFER_RE = /^[A-Za-z0-9_-]{1,64}$/;
const looksLikeTransferId = (q: string) => TRANSFER_RE.test(q) && (/\d/.test(q) || q.length >= 16);

/** The "Open" items for what the user typed (none, or one). */
export function openCommands(query: string, scope: OpenCommandScope): OpenCommand[] {
  const q = query.trim();
  if (q.startsWith('tk_')) {
    return scope.tickets && TICKET_RE.test(q) ? [{ kind: 'ticket', id: q, href: `${PARTNER_ROUTES.support.href}/${q}` }] : [];
  }
  return scope.transfers && looksLikeTransferId(q) ? [{ kind: 'transfer', id: q, href: `${PARTNER_ROUTES.transfers.href}/${q}` }] : [];
}
