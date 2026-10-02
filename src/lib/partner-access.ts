import { scopeOf, type Scope } from './staff-scope';
import type { PartnerId, Staff, StaffRole } from './types';

// partner-access: the PURE decision behind requirePartnerStaff (UI redesign SPEC §3). The tenant is
// the SESSION record's partnerId, never request input: this function takes no request data at all.
// Roles are a SET per surface, not a rank (auth-store.ts mergeRole: agent and support are
// incomparable). A role this file does not know fails closed to /login, never a guess.

export type PartnerRole = StaffRole;
export interface PartnerPolicy {
  readonly roles: readonly PartnerRole[];
}
export interface PartnerCtx {
  partnerId: PartnerId;
  username: string;
  role: PartnerRole;
  staff: Staff;
}
export type PartnerRedirect = '/login' | '/admin-dashboard' | '/partner' | '/partner/security?enroll=1';
export type AccessDecision = { ok: true; ctx: PartnerCtx } | { ok: false; redirectTo: PartnerRedirect };

export const KNOWN_PARTNER_ROLES: readonly PartnerRole[] = Object.freeze(['admin', 'agent', 'support', 'finance'] as const);

const policy = (...roles: PartnerRole[]): PartnerPolicy => Object.freeze({ roles: Object.freeze(roles) });

/** Every partner role. The home page and the security page use it, so a role bounce never loops. */
export const PARTNER_ANY = policy(...KNOWN_PARTNER_ROLES);
export const PARTNER_ADMIN = policy('admin');
export const PARTNER_OPS = policy('admin', 'agent');
export const PARTNER_MONEY_READ = policy('admin', 'agent', 'finance');
export const PARTNER_TICKETS = policy('admin', 'agent', 'support');
export const PARTNER_REPORTS = policy('admin', 'finance');
/** Merge plan 2e: who may (re)assign a support ticket. Agents never assign (the legacy rule). */
export const PARTNER_TICKET_LEADS = policy('admin', 'support');

export function decidePartnerAccess(
  staff: Staff | null,
  p: PartnerPolicy,
  mfa: { pending: boolean; skip?: boolean },
): AccessDecision {
  if (!staff) return { ok: false, redirectTo: '/login' };
  // Defence in depth: getCurrentStaff already returns null for a suspended record.
  if (staff.status === 'suspended') return { ok: false, redirectTo: '/login' };
  let scope: Scope;
  try {
    scope = scopeOf(staff);
  } catch {
    // An empty-string partnerId must never be read as platform scope.
    return { ok: false, redirectTo: '/login' };
  }
  // 'finance' is partner-only. A (malformed) platform-scoped finance record would loop
  // /partner → /admin-dashboard → requireStaff → /partner, so it is refused before the platform branch.
  if (staff.role === 'finance' && scope.kind === 'platform') return { ok: false, redirectTo: '/login' };
  if (scope.kind === 'platform') return { ok: false, redirectTo: '/admin-dashboard' };
  if (!KNOWN_PARTNER_ROLES.includes(staff.role)) return { ok: false, redirectTo: '/login' };
  if (mfa.pending && !mfa.skip) return { ok: false, redirectTo: '/partner/security?enroll=1' };
  if (!p.roles.includes(staff.role)) return { ok: false, redirectTo: '/partner' };
  return { ok: true, ctx: { partnerId: scope.partnerId, username: staff.username, role: staff.role, staff } };
}
