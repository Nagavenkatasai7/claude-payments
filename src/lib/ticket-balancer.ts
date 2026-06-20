import type { PartnerId, Staff } from './types';
import { scopeOf, canSee } from './staff-scope';
import { env } from './env';

// ticket-balancer — the deterministic core of the AI-assisted ticket
// load-balancer. The AI triage (ticket-ai.triageSuggest) sets category/priority
// out-of-band in the outbox worker; THIS picks the assignee. The pick is
// deterministic so auto-assignment never stalls when the model is down — the AI
// enriches the queue, it does not gate it.

/**
 * Auto-provisioned test/smoke accounts — the e2e smoke specs self-provision
 * `e2e-smoke-*` staff on every deploy, and `env.seedPartnerUsername` is an
 * opt-in seed fixture. They must NEVER receive a real customer ticket, and they
 * clutter the Team list (Unit 2 hides them with this same predicate).
 */
export function isTestStaff(staff: Staff): boolean {
  const u = staff.username.toLowerCase();
  if (u.startsWith('e2e-smoke-')) return true;
  const seed = env.seedPartnerUsername.toLowerCase();
  return seed !== '' && u === seed;
}

/**
 * The agents eligible to receive a ticket in `ticketPartnerId`: active
 * (non-suspended) 'agent'-role staff whose scope can see that partner, excluding
 * test accounts. Reuses scopeOf/canSee — the SAME tenant rule the manual assign
 * path enforces — so a platform agent is eligible for any partner's ticket while
 * a partner-scoped agent only gets its own tenant's.
 */
export function eligibleAgents(allStaff: Staff[], ticketPartnerId: PartnerId): Staff[] {
  return allStaff.filter(
    (s) =>
      s.role === 'agent' &&
      s.status !== 'suspended' &&
      !isTestStaff(s) &&
      canSee(scopeOf(s), ticketPartnerId),
  );
}

/**
 * Pick the agent with the FEWEST open tickets (the load balancer). Deterministic
 * tie-break by username asc — combined with the worker assigning ONE ticket at a
 * time (each assignment raises that agent's count for the next pick), this yields
 * natural round-robin under equal load. Empty pool ⇒ null (leave unassigned for
 * support/admin to pick up).
 */
export function pickLeastLoaded(
  agents: Staff[],
  openCountByUsername: Map<string, number>,
): Staff | null {
  if (agents.length === 0) return null;
  return [...agents].sort((a, b) => {
    const la = openCountByUsername.get(a.username) ?? 0;
    const lb = openCountByUsername.get(b.username) ?? 0;
    return la - lb || a.username.localeCompare(b.username);
  })[0];
}
