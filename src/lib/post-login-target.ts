import { inviteMfaPending } from './partner-mfa-gate';
import type { RedisLike } from './store';
import type { Staff } from './types';

// UI redesign M3-9: where a successful password sign-in lands. An invite-accepted account that has
// not enrolled in two-step sign-in yet goes straight to enrolment (the legacy gates also honour the
// marker, so this is the fast path, not the only guard). UI M5: every other partner-scoped account
// lands on /partner; only platform staff land on /admin-dashboard. `!== undefined` is the
// requirePlatformAdmin rule: a malformed '' partnerId is never platform scope, and /partner's gate
// refuses it to /login.
export type PostLoginTarget = '/admin-dashboard' | '/partner' | '/partner/security?enroll=1';

export async function postLoginTarget(
  staff: Staff,
  deps: { redis?: RedisLike; isEnrolled?: (username: string) => Promise<boolean> } = {},
): Promise<PostLoginTarget> {
  if (await inviteMfaPending(staff, deps)) return '/partner/security?enroll=1';
  return staff.partnerId !== undefined ? '/partner' : '/admin-dashboard';
}
