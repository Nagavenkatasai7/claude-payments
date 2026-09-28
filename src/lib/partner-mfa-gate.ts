import { getRedis } from './redis';
import type { RedisLike } from './store';
import { getStaffMfaStore } from './staff-mfa-store';
import { mfaEnrolmentRequired } from './staff-mfa-policy';
import type { Staff } from './types';

// UI redesign SPEC §6b: the UI loop builds ONLY the partner-app enrolment redirect. WHO must enrol
// globally is staff-mfa-policy.ts (owned by the compliance loop); this file reads it and never
// edits it. The extra per-account signal is the invite marker set by invite acceptance ("first
// login forces MFA enrolment", SPEC §3.1). The marker is cleared lazily once the account is
// enrolled, so the enrolment action itself is never edited.
export const MFA_PENDING_PREFIX = 'staffmfa:pending:';

export async function partnerMfaEnrolmentPending(
  staff: Staff,
  deps: {
    redis?: RedisLike;
    isEnrolled?: (username: string) => Promise<boolean>;
    policyRequired?: (s: Staff) => boolean;
  } = {},
): Promise<boolean> {
  const redis = deps.redis ?? getRedis();
  const isEnrolled = deps.isEnrolled ?? ((u: string) => getStaffMfaStore().isEnrolled(u));
  const policyRequired = deps.policyRequired ?? ((s: Staff) => mfaEnrolmentRequired(s, { partnerAdmins: true }));
  const key = `${MFA_PENDING_PREFIX}${staff.username}`;
  const marked = (await redis.exists(key)) === 1;
  const required = marked || policyRequired(staff);
  if (!required) return false;
  if (await isEnrolled(staff.username)) {
    if (marked) await redis.del(key);
    return false;
  }
  return true;
}
