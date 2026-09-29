import { inviteMfaPending } from './partner-mfa-gate';
import type { RedisLike } from './store';
import type { Staff } from './types';

// UI redesign M3-9: where a successful password sign-in lands. An invite-accepted account that has
// not enrolled in two-step sign-in yet goes straight to enrolment; every other account keeps today's
// /admin-dashboard landing (the legacy gates also honour the marker, so this is the fast path, not
// the only guard).
export type PostLoginTarget = '/admin-dashboard' | '/partner/security?enroll=1';

export async function postLoginTarget(
  staff: Staff,
  deps: { redis?: RedisLike; isEnrolled?: (username: string) => Promise<boolean> } = {},
): Promise<PostLoginTarget> {
  return (await inviteMfaPending(staff, deps)) ? '/partner/security?enroll=1' : '/admin-dashboard';
}
