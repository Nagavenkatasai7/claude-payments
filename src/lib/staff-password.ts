import { logWarn } from './log';
import { pwnedPasswordStatus, type PwnedStatus } from './pwned';

/**
 * staff-password — Program-Fix 17a. The policy for a NEW staff password
 * (create, admin reset, change-own). It never runs at login, so an existing
 * password that predates the policy keeps working until it is changed.
 *
 *  - 12 to 128 characters (NIST 800-63B: length, no composition rules);
 *  - not in the Have I Been Pwned corpus (k-anonymity, pwned.ts).
 *
 * Breach-check outage (brief B1): `failClosed: true` (create, reset) refuses,
 * so an outage never lets a breached password onto a staff account; `false`
 * (self-change) allows with a warning, so an HIBP outage never blocks a staff
 * member from rotating a leaked password.
 */

export const STAFF_PASSWORD_MIN = 12;
export const STAFF_PASSWORD_MAX = 128;

/** A policy refusal whose message is safe to show the staff member. */
export class StaffPasswordPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaffPasswordPolicyError';
  }
}

export interface StaffPasswordPolicyOptions {
  /** Injectable breach check (default: the real HIBP range call). */
  pwnedCheck?: (password: string) => Promise<PwnedStatus>;
  failClosed: boolean;
  /** Injectable warning sink for the fail-open path (default logWarn). */
  warn?: (message: string) => void;
}

export async function assertStaffPasswordPolicy(
  password: string,
  opts: StaffPasswordPolicyOptions,
): Promise<void> {
  if (password.length < STAFF_PASSWORD_MIN) {
    throw new StaffPasswordPolicyError(`Password must be at least ${STAFF_PASSWORD_MIN} characters.`);
  }
  if (password.length > STAFF_PASSWORD_MAX) {
    throw new StaffPasswordPolicyError(`Password must be at most ${STAFF_PASSWORD_MAX} characters.`);
  }
  const check = opts.pwnedCheck ?? ((pw: string) => pwnedPasswordStatus(pw));
  let status: PwnedStatus;
  try {
    status = await check(password);
  } catch {
    status = 'unavailable';
  }
  if (status === 'pwned') {
    throw new StaffPasswordPolicyError('This password has appeared in a data breach. Choose another.');
  }
  if (status === 'unavailable') {
    if (opts.failClosed) {
      throw new StaffPasswordPolicyError(
        'The password breach check is unavailable right now. Try again in a few minutes.',
      );
    }
    (opts.warn ?? ((m: string) => logWarn('staff.password', m)))(
      'breach check unavailable; allowing a self-service password change (fail-open)',
    );
  }
}

/** Result of the password server actions (team/actions.ts), rendered by their client forms. */
export type StaffPasswordFormState = { ok: boolean; message: string } | null;

/** Shown when a compare-and-set lost to a concurrent write: never a silent failure. */
export const PASSWORD_CHANGED_CONCURRENTLY = 'Password changed concurrently; reload and retry.';
