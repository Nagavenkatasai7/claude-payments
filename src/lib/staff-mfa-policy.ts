import { env } from './env';
import { isSeedAdminRecord } from './staff-login-guard';
import type { Staff } from './types';

/**
 * staff-mfa-policy — Program-Fix 17b. WHO must enrol in TOTP before using the
 * platform-admin surfaces. MFA is opt-in: with STAFF_MFA_REQUIRED unset
 * (default) nobody is ever required. When it is 'true', only PLATFORM admins
 * (role admin, no partnerId) are in scope (partner staff follow in fix 49),
 * and two groups are never required:
 *   - the seed admin (isSeedAdminRecord: the configured name AND a platform
 *     admin record), so the owner can never be locked out by enforcement;
 *   - every name in STAFF_MFA_EXEMPT (e.g. the e2e smoke account).
 * Enforcement only. Someone who HAS enrolled always gets the code step at
 * sign-in, whatever this says.
 */
export function mfaEnrolmentRequired(staff: Staff): boolean {
  if (!env.staffMfaRequired) return false;
  if (staff.role !== 'admin' || staff.partnerId !== undefined) return false;
  if (isSeedAdminRecord(staff)) return false;
  return !env.staffMfaExempt.includes(staff.username);
}
