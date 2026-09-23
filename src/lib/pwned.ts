import { createHash } from 'node:crypto';

/**
 * pwned — Have I Been Pwned (HIBP) "Pwned Passwords" k-anonymity breach check.
 *
 * OWASP ASVS v5 / NIST 800-63B: reject passwords that appear in a known breach
 * corpus on set/change/reset. We use the **k-anonymity** range API so the full
 * password hash NEVER leaves this process:
 *   1. SHA-1 the password, uppercase hex.
 *   2. Send ONLY the first 5 hex chars (the "prefix") to
 *      `GET https://api.pwnedpasswords.com/range/<prefix>`.
 *   3. The response body is ~800 lines of `SUFFIX:count` (the 35-char hash
 *      suffix + a breach count). The password is pwned iff our 35-char suffix
 *      is one of them.
 *
 * **Fail-open:** any network/HTTP error returns `false` (treat as not-pwned).
 * Availability beats this single advisory control — a breach check outage must
 * not wall off all registrations. The hard AML/identity gate is elsewhere.
 *
 * `fetchImpl` is injectable so tests never hit the network.
 */
export async function isPwnedPassword(
  password: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  try {
    const sha1 = createHash('sha1').update(password).digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5); // 35 chars

    const res = await fetchImpl(`https://api.pwnedpasswords.com/range/${prefix}`);
    if (!res.ok) {
      console.warn(`[pwned] HIBP range returned HTTP ${res.status}; failing open`);
      return false;
    }
    const body = await res.text();

    for (const line of body.split('\n')) {
      // Each line is `SUFFIX:count`; compare only the suffix, case-insensitively.
      const lineSuffix = line.split(':')[0]?.trim();
      if (lineSuffix && lineSuffix.toUpperCase() === suffix) {
        return true;
      }
    }
    return false;
  } catch (err) {
    console.warn('[pwned] HIBP check failed; failing open', err);
    return false;
  }
}

/** Deadline for one HIBP range call on the tri-state path (staff create/reset). */
export const PWNED_TIMEOUT_MS = 3000;

export type PwnedStatus = 'pwned' | 'clean' | 'unavailable';

/**
 * Program-Fix 17a: the TRI-STATE breach check for callers that must tell an
 * outage apart from "not breached" (staff create/reset refuse on an outage;
 * self-change allows with a warning — see staff-password.ts). Same k-anonymity
 * request as isPwnedPassword (only the 5-char prefix leaves the process), plus
 * an AbortSignal deadline so a hung HIBP call is an outage, not a hang.
 * isPwnedPassword above is deliberately left as it was (customer paths).
 */
export async function pwnedPasswordStatus(
  password: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs: number = PWNED_TIMEOUT_MS,
): Promise<PwnedStatus> {
  // One retry on an outage (a transient 5xx, a reset socket, a slow answer), so
  // a single blip does not refuse a fail-closed staff create or reset.
  const first = await pwnedStatusOnce(password, fetchImpl, timeoutMs);
  return first === 'unavailable' ? pwnedStatusOnce(password, fetchImpl, timeoutMs) : first;
}

async function pwnedStatusOnce(
  password: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<PwnedStatus> {
  try {
    const sha1 = createHash('sha1').update(password).digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);
    const res = await fetchImpl(`https://api.pwnedpasswords.com/range/${prefix}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return 'unavailable';
    const body = await res.text();
    for (const line of body.split('\n')) {
      const lineSuffix = line.split(':')[0]?.trim();
      if (lineSuffix && lineSuffix.toUpperCase() === suffix) return 'pwned';
    }
    return 'clean';
  } catch {
    return 'unavailable';
  }
}
