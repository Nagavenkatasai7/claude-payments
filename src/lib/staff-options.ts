import type { Staff } from './types';

/**
 * Program-Fix 20 (F56): the only staff shape a client component may receive.
 * A full `Staff` carries `passwordHash`; whatever a server component passes to a
 * `'use client'` component is serialized into the RSC flight payload, so the
 * transactions assign dropdown gets this projection and nothing else.
 * `tests/staff-hash-not-in-client.test.ts` pins that no client module imports `Staff`.
 */
// `passwordHash?: never` makes a full Staff NOT assignable (structural typing
// would otherwise accept it), so reverting a call site to the raw list fails tsc.
export type StaffOption = Pick<Staff, 'username' | 'name'> & { passwordHash?: never };

/** Explicit field pick (never a spread), so a new `Staff` field can't leak by default. */
export function toStaffOptions(staff: readonly Staff[]): StaffOption[] {
  return staff.map((s) => ({ username: s.username, name: s.name }));
}
