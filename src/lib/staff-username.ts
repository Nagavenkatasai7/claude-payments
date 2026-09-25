/**
 * staff-username — partner-demo R5 fix round 1. The format a NEW staff
 * username must have: 3–64 of [a-z0-9._-], and not a reserved word. Enforced
 * on create only (partner staff + the Team page), never on sign-in or lookup,
 * so an account whose name predates the rule keeps working.
 *   - `index`: `staff:<username>` would collide with the `staff:index` set;
 *   - `smartremit`, `system`: would read as the platform in audit feeds;
 *   - `null`, `undefined`: stringified-missing-value lookalikes.
 */
const STAFF_USERNAME_RE = /^[a-z0-9._-]{3,64}$/;
const RESERVED = new Set(['index', 'smartremit', 'system', 'null', 'undefined']);

export const STAFF_USERNAME_RULE =
  'Username must be 3–64 characters: lowercase letters, digits, dot, dash or underscore (and not a reserved word).';

export function isValidNewStaffUsername(username: string): boolean {
  return STAFF_USERNAME_RE.test(username) && !RESERVED.has(username);
}

export function assertNewStaffUsername(username: string): void {
  if (!isValidNewStaffUsername(username)) throw new Error(STAFF_USERNAME_RULE);
}
