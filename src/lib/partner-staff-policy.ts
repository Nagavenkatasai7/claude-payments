import { canSee, scopeOf, type Scope } from './staff-scope';
import { SUPPORT_DEFAULT_PERMISSIONS, type PartnerId, type Staff, type StaffRole } from './types';

/**
 * partner-staff-policy — partner-demo R5 (owner decision 8). The pure rules for
 * partner-managed staff: a partner admin adds and removes staff in THEIR OWN
 * tenant only; a platform admin manages any tenant's staff. The tenant always
 * comes from the session. A client-supplied partner id (a bound action arg, a
 * form field) is a selector that must match it, never a source of scope.
 * Suspend, password/MFA reset, permissions and role edits stay platform-only
 * (the Team page); nothing here widens them.
 */

/**
 * The tenant a staff-management action may act on, or null. Platform admin →
 * the selector; partner admin → their own tenant, only when the selector names
 * it; anyone else (agent, support, a malformed record) → null. Callers turn
 * null into the same "Partner not found." as a missing partner.
 */
export function resolveStaffTenant(actor: Staff, selector: string): PartnerId | null {
  if (actor.role !== 'admin') return null;
  const wanted = selector.trim();
  if (!wanted) return null;
  let scope: Scope;
  try {
    scope = scopeOf(actor); // throws on partnerId === '' (never platform by accident)
  } catch {
    return null;
  }
  if (scope.kind === 'platform') return wanted;
  return wanted === scope.partnerId ? scope.partnerId : null;
}

export type RemoveDecision = 'ok' | 'noop' | 'suspended';

/**
 * May `actor` remove `target` through the partner-staff endpoint?
 *   - 'noop': not an admin, a platform account, yourself, or a tenant the
 *     actor cannot see. The caller returns the same silent no-op as for a
 *     missing name (404-never-403).
 *   - 'suspended' (fix round 1): a PARTNER admin and a member of their own
 *     tenant that SmartRemit suspended. Suspension is platform governance:
 *     removing the member would let the tenant re-create the name active with
 *     a new password. Only reachable inside the actor's own tenant, so it
 *     reveals nothing about other tenants.
 *   - 'ok': otherwise. A platform admin may remove a suspended member.
 */
export function removeDecision(actor: Staff, target: Staff): RemoveDecision {
  if (actor.role !== 'admin') return 'noop';
  if (!target.partnerId) return 'noop';
  if (target.username === actor.username) return 'noop';
  let scope: Scope;
  try {
    scope = scopeOf(actor);
  } catch {
    return 'noop';
  }
  if (!canSee(scope, target.partnerId)) return 'noop';
  if (scope.kind === 'partner' && target.status === 'suspended') return 'suspended';
  return 'ok';
}

/** True only when removeDecision is 'ok'. */
export function mayRemove(actor: Staff, target: Staff): boolean {
  return removeDecision(actor, target) === 'ok';
}

function isActiveTenantAdmin(s: Staff, partnerId: PartnerId): boolean {
  return s.role === 'admin' && s.partnerId === partnerId && s.status !== 'suspended';
}

/** True when `target` is its tenant's only active admin (removing it would orphan the tenant). */
export function isLastTenantAdmin(target: Staff, all: readonly Staff[]): boolean {
  const tenant = target.partnerId;
  if (!tenant || !isActiveTenantAdmin(target, tenant)) return false;
  return all.filter((s) => isActiveTenantAdmin(s, tenant)).length <= 1;
}

export interface NewStaffInput {
  username: string;
  name: string;
  role: StaffRole;
  passwordHash: string;
  createdAt: string;
}

/**
 * The record a partner-staff create writes. partnerId is ALWAYS the resolved
 * tenant (so this path can never mint a platform account); permissions are
 * forced to no-money in every role; status is never taken from a form.
 */
export function newStaffRecord(tenant: PartnerId, input: NewStaffInput): Staff {
  if (!tenant) throw new Error('A tenant is required.');
  const { role } = input;
  if (role !== 'admin' && role !== 'agent' && role !== 'support') throw new Error('Invalid role.');
  return {
    username: input.username,
    name: input.name,
    role,
    permissions:
      role === 'support'
        ? { ...SUPPORT_DEFAULT_PERMISSIONS }
        : { canCancel: false, canResend: false, canAssign: false, canRevealPii: false },
    passwordHash: input.passwordHash,
    createdAt: input.createdAt,
    partnerId: tenant,
  };
}

/** The members of `partnerId` the scope may see: [] for another tenant; never platform accounts. */
export function listTenantStaff(scope: Scope, partnerId: PartnerId, all: readonly Staff[]): Staff[] {
  if (!partnerId || !canSee(scope, partnerId)) return [];
  return all.filter((s) => s.partnerId === partnerId);
}

/** The seed (owner) admin's name is never available to the partner-staff create. */
export function isReservedStaffUsername(username: string, seedName: string): boolean {
  return seedName !== '' && username === seedName;
}

/**
 * Who a tenant's staff feed shows as the actor: a partner-scoped actor by
 * name; any other (a SmartRemit platform account, or an older row without the
 * marker) as "SmartRemit", so platform usernames never reach a tenant.
 */
export function feedActorLabel(row: { actor: string; actorScope?: 'platform' | 'partner' }): string {
  return row.actorScope === 'partner' ? row.actor : 'SmartRemit';
}
