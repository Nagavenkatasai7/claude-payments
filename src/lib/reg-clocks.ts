/**
 * Fix pack 8 (R44, P4): the regulatory case classes and their clocks from the
 * FIRST notice. Draft lengths until counsel confirms (REG_CLOCKS_VERSION).
 * Business days = Mon-Fri in UTC, no holidays (equal or earlier due date: the
 * safe side). Pure, client-safe: no runtime import.
 *
 * Do not merge with remittance-disclosure's addBusinessDays: that helper rolls a
 * weekend start forward to Monday first and then counts (Sat + 1 = Tue), and is
 * pinned by the disclosure tests. This helper counts the next business day from
 * the next calendar day (Sat + 1 = Mon), the earlier, safer due date.
 */

export const REG_CLASSES = Object.freeze(['error_notice', 'cancellation', 'complaint', 'fraud_report'] as const);
export type RegClass = (typeof REG_CLASSES)[number];

/** Closed check: strings of the tuple only ('__proto__', 'toString' and non-strings -> false). */
export function isRegClass(v: unknown): v is RegClass {
  return typeof v === 'string' && (REG_CLASSES as readonly string[]).includes(v);
}

/** Counsel confirms the lengths (R19); the suffix marks them as a draft. */
export const REG_CLOCKS_VERSION = 'reg-clocks-2026-11-draft';

export const REG_CLOCKS: Readonly<Record<RegClass, Readonly<{ unit: 'calendar' | 'business'; days: number }>>> =
  Object.freeze({
    error_notice: Object.freeze({ unit: 'calendar', days: 90 }),
    cancellation: Object.freeze({ unit: 'business', days: 3 }),
    complaint: Object.freeze({ unit: 'calendar', days: 15 }),
    fraud_report: Object.freeze({ unit: 'business', days: 10 }),
  } as const);

const DAY_MS = 86_400_000;

/**
 * Add n business days (Mon-Fri, UTC), keeping the time of day of `fromMs`.
 * Counting starts on the next calendar day: each step adds one UTC day and
 * counts it only on Monday to Friday. So a notice received on a Saturday or a
 * Sunday counts the following Monday as its first business day (Sat + 1 = Mon,
 * Sat + 3 = Wed, Sun + 3 = Wed, Fri + 3 = Wed, Wed + 3 = Mon).
 * No US holiday list: skipping a holiday would give a LATER date, so ignoring
 * holidays gives an equal or EARLIER due date (the safe side); a known limit
 * for counsel (D3).
 * `n` must be a non-negative integer and `fromMs` finite, else RangeError.
 */
export function addRegBusinessDays(fromMs: number, n: number): number {
  if (!Number.isFinite(fromMs)) throw new RangeError('addRegBusinessDays: fromMs must be finite');
  if (!Number.isInteger(n) || n < 0) throw new RangeError('addRegBusinessDays: n must be a non-negative integer');
  const d = new Date(fromMs);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left -= 1;
  }
  return d.getTime();
}

/** The due date of a case of class `cls` whose first notice was at `firstNoticeMs`. */
export function regDueAt(cls: RegClass, firstNoticeMs: number): number {
  if (!Number.isFinite(firstNoticeMs)) throw new RangeError('regDueAt: firstNoticeMs must be finite');
  const clock = REG_CLOCKS[cls];
  if (clock.unit === 'calendar') return firstNoticeMs + clock.days * DAY_MS;
  return addRegBusinessDays(firstNoticeMs, clock.days);
}

/** Never moves a due date later: null -> b, else the earlier of the two. */
export function earlierDue(a: number | null, b: number): number {
  return a === null ? b : Math.min(a, b);
}
