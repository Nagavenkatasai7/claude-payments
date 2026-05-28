import type { PartnerId, Staff } from './types';

export type Scope =
  | { kind: 'platform' }
  | { kind: 'partner'; partnerId: PartnerId };

export function scopeOf(staff: Staff): Scope {
  return staff.partnerId
    ? { kind: 'partner', partnerId: staff.partnerId }
    : { kind: 'platform' };
}

export function canSee(scope: Scope, partnerId: PartnerId): boolean {
  return scope.kind === 'platform' || scope.partnerId === partnerId;
}
