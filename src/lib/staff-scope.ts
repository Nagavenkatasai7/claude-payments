import type { PartnerId, Staff } from './types';

export type Scope =
  | { kind: 'platform' }
  | { kind: 'partner'; partnerId: PartnerId };

export function scopeOf(staff: Staff): Scope {
  // Empty-string partnerId is rejected explicitly: it would otherwise silently
  // escalate to platform scope via the truthy check below. Any future write
  // path that fails to validate partnerId (e.g. a malformed POST to the
  // partner-staff create action) trips this guard rather than minting a
  // global-admin record.
  if (staff.partnerId === '') {
    throw new Error('Staff.partnerId must be undefined or a non-empty PartnerId');
  }
  return staff.partnerId
    ? { kind: 'partner', partnerId: staff.partnerId }
    : { kind: 'platform' };
}

export function canSee(scope: Scope, partnerId: PartnerId): boolean {
  return scope.kind === 'platform' || scope.partnerId === partnerId;
}
