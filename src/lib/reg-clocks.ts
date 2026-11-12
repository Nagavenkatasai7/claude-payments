/**
 * Fix pack 8 (R44, P4): the regulatory case classes and their clocks from the
 * FIRST notice. Draft lengths until counsel confirms (REG_CLOCKS_VERSION).
 * Business days = Monday to Friday, no holidays, counted on the calendar of UTC
 * and of every US state time zone (REG_DAY_OFFSETS_HOURS); the due date is the
 * EARLIEST of those counts, so it is never later than the Mon-Fri count on UTC
 * days or on the days of any US state. Holidays and the provider's own time
 * zone (and its cut-off) are open points for counsel (fix F3, early review FB1).
 * Pure, client-safe: no runtime import.
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
const HOUR_MS = 3_600_000;

/**
 * UTC and every UTC offset a US state uses in standard or daylight time (UTC-4
 * Eastern daylight to UTC-10 Hawaii). A business-day count runs on each of these
 * calendars and the earliest result wins (fix F3).
 */
export const REG_DAY_OFFSETS_HOURS = Object.freeze([0, -4, -5, -6, -7, -8, -9, -10] as const);

/** Calendar days that n Mon-Fri days take on the calendar shifted by `offsetH` hours, counting from the next day. */
function businessCountDays(fromMs: number, n: number, offsetH: number): number {
  let k = 0;
  let left = n;
  while (left > 0) {
    k += 1;
    const dow = new Date(fromMs + k * DAY_MS + offsetH * HOUR_MS).getUTCDay();
    if (dow !== 0 && dow !== 6) left -= 1;
  }
  return k;
}

/**
 * Add n business days (Monday to Friday, no holidays), keeping the time of day
 * of `fromMs`: the result is `fromMs` plus a whole number of days.
 * On each calendar of REG_DAY_OFFSETS_HOURS (the weekday of a moment there is
 * the UTC weekday of the moment plus the offset) the count starts on the next
 * calendar day and counts only Monday to Friday, so a notice received on a
 * Saturday or a Sunday counts the following Monday as its first business day
 * (Sat + 1 = Mon, Sat + 3 = Wed, Sun + 3 = Wed, Fri + 3 = Wed, Wed + 3 = Mon).
 * The result takes the SMALLEST number of days over those calendars, so it is
 * never later than the count on UTC days or on the days of any US state time
 * zone. No US holiday list: skipping a holiday would give a LATER date, so
 * ignoring holidays errs earlier too. Holidays and the provider's own time zone
 * are open points for counsel (D3, owner question 11).
 * `n` must be a non-negative integer and `fromMs` finite, else RangeError.
 */
export function addRegBusinessDays(fromMs: number, n: number): number {
  if (!Number.isFinite(fromMs)) throw new RangeError('addRegBusinessDays: fromMs must be finite');
  if (!Number.isInteger(n) || n < 0) throw new RangeError('addRegBusinessDays: n must be a non-negative integer');
  if (n === 0) return fromMs;
  let days = Number.POSITIVE_INFINITY;
  for (const h of REG_DAY_OFFSETS_HOURS) days = Math.min(days, businessCountDays(fromMs, n, h));
  return fromMs + days * DAY_MS;
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
