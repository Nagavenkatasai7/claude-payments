import { getAuthStore } from './auth-store';
import { getAuditLogStore } from './audit-log-store';
import { getStaffMfaStore } from './staff-mfa-store';
import { MFA_PENDING_PREFIX } from './partner-mfa-gate';
import { getRedis } from './redis';
import { isLastTenantAdmin, removeDecision } from './partner-staff-policy';
import { scopeOf } from './staff-scope';
import type { PartnerId, Staff } from './types';

// partner-staff-ops — UI redesign M3-8. The ONE remove-a-tenant-member core, MOVED out of the
// legacy removePartnerStaffAction (admin-dashboard/partners/actions.ts), which is now a caller,
// and shared with the /partner/staff action. Same behaviour, pinned by
// tests/partner-staff-actions.test.ts:
//   - 'noop': the name is missing, not in `tenant`, a platform account, yourself, or not
//     removable by this actor (removeDecision): 404-never-403, nothing written;
//   - 'suspended': a partner admin and a member SmartRemit suspended (platform governance);
//   - 'last_admin': the tenant's only active admin (never orphan a tenant);
//   - 'removed': the record, its sessions, its MFA keys (Program-Fix 17b) and its invite MFA
//     marker are gone, and one audit row is written.

export type RemoveTenantStaffResult = 'removed' | 'noop' | 'suspended' | 'last_admin';

export async function removeTenantStaff(actor: Staff, tenant: PartnerId, username: string): Promise<RemoveTenantStaffResult> {
  if (!tenant || !username) return 'noop';
  const authStore = getAuthStore();
  const target = await authStore.getStaff(username);
  if (!target || target.partnerId !== tenant) return 'noop';
  const decision = removeDecision(actor, target);
  if (decision === 'noop') return 'noop';
  if (decision === 'suspended') return 'suspended';
  if (isLastTenantAdmin(target, await authStore.listStaff())) return 'last_admin';

  await authStore.deleteStaff(username);
  await authStore.deleteAllSessionsFor(username);
  await getStaffMfaStore().reset(username); // Program-Fix 17b
  // M3-9's forced-enrolment marker: a re-created name must never inherit it.
  await getRedis().del(`${MFA_PENDING_PREFIX}${username}`);
  // Save, then audit (as the Team actions): the record is Redis + a ledger row, not one transaction.
  await getAuditLogStore().record({
    at: new Date().toISOString(),
    actor: actor.username,
    action: 'removed',
    target: username,
    detail: `was ${target.role}, partner staff`,
    partnerId: tenant,
    actorScope: scopeOf(actor).kind,
  });
  return 'removed';
}
