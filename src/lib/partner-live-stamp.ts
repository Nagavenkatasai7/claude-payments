import { createHash } from 'node:crypto';
import { PARTNER_MONEY_READ, PARTNER_TICKETS, type PartnerRole } from '@/lib/partner-access';

// partner-live-stamp (lost-features A15): the opaque change stamp GET /partner/live answers. Server
// only (node:crypto). The stamp covers only what the role may see: support never gets a money part,
// finance never a ticket part, and no figure leaves the server (the client only compares strings).

export interface LiveStampParts {
  money?: string;
  tickets?: string;
}

/** The parts a role's stamp covers (money: admin, agent, finance; tickets: admin, agent, support). */
export function liveStampParts(role: PartnerRole, parts: LiveStampParts): LiveStampParts {
  const out: LiveStampParts = {};
  if (PARTNER_MONEY_READ.roles.includes(role) && parts.money !== undefined) out.money = parts.money;
  if (PARTNER_TICKETS.roles.includes(role) && parts.tickets !== undefined) out.tickets = parts.tickets;
  return out;
}

/** Which parts a role needs (so the route reads nothing else). */
export function liveNeeds(role: PartnerRole): { money: boolean; tickets: boolean } {
  return { money: PARTNER_MONEY_READ.roles.includes(role), tickets: PARTNER_TICKETS.roles.includes(role) };
}

/** The opaque stamp: sha256 hex of the parts. */
export function liveStamp(parts: LiveStampParts): string {
  return createHash('sha256').update(JSON.stringify([parts.money ?? null, parts.tickets ?? null])).digest('hex');
}
