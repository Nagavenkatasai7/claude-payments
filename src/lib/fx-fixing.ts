// fx-fixing — Step 0 FX-1: how many ECB fixings the platform rate is behind.
//
// Frankfurter serves the ECB reference rates, one fixing per TARGET business
// day, published around 16:00 CET. The rate's `asOf` (rate.ts) is that fixing's
// date. A feed that keeps answering with an old `asOf` is FROZEN even though
// every fetch is fresh (fetchedAt only measures our own call), so this module
// measures the lag in business days, from the date string alone.
//
// Two "due" rules, both in UTC:
//   • ALERT : a weekday d is due at d 17:00 UTC (the ops alert, rate-staleness.ts);
//   • REFUSE: a weekday d is due at (d+1) 06:00 UTC (the refusal, fx.ts).
// The lag counts the Mon–Fri dates in (asOf, latest due date]. TARGET closing
// days are not listed: legitimate closures miss at most 2 consecutive weekday
// fixings (Good Friday + Easter Monday, or 25 + 26 Dec), so refusing at a
// REFUSE-lag of 3 never refuses a closure, and a fixing only counts toward the
// refusal once it is ≥ 13 h overdue, so a merely-late fixing after a two-day
// closure alerts and never refuses.
//
// PURE: no clock, no I/O. Callers pass `now`.

export type FixingRule = 'alert' | 'refuse';

/** Alert once a single fixing is overdue (ALERT rule). */
export const FIXING_ALERT_LAG = 1;
/** Refuse once three fixings are overdue (REFUSE rule). */
export const FIXING_REFUSE_LAG = 3;

const DAY_MS = 86_400_000;
const ALERT_DUE_OFFSET_MS = 17 * 3_600_000; // d 17:00 UTC
const REFUSE_DUE_OFFSET_MS = DAY_MS + 6 * 3_600_000; // (d+1) 06:00 UTC

/** Epoch ms of `YYYY-MM-DD` at 00:00 UTC, or null for anything that is not a real calendar date. */
function parseIsoDate(asOf: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(asOf);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  // Round-trip check: 2026-02-30 would silently roll to 2 March.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return ms;
}

/** Saturday (6) and Sunday (0) never carry a fixing. */
const isWeekday = (dayStartMs: number): boolean => {
  const dow = new Date(dayStartMs).getUTCDay();
  return dow !== 0 && dow !== 6;
};

/**
 * The number of weekday fixings after `asOf` that are already due at `now`
 * under `rule`. 0 when `asOf` is in the future (clock skew); null when `asOf`
 * is not a plain YYYY-MM-DD date.
 */
export function fixingLagBusinessDays(asOf: string, now: number, rule: FixingRule): number | null {
  const start = parseIsoDate(asOf);
  if (start === null || !Number.isFinite(now)) return null;
  const dueOffset = rule === 'alert' ? ALERT_DUE_OFFSET_MS : REFUSE_DUE_OFFSET_MS;
  // Whole weeks first (5 weekdays each), so a years-old date costs a few steps.
  const lastDue = now - dueOffset; // a day d is due when d 00:00 <= lastDue
  const firstCandidate = start + DAY_MS;
  if (lastDue < firstCandidate) return 0;
  const span = Math.floor((lastDue - firstCandidate) / DAY_MS) + 1; // calendar days d in (asOf, lastDue]
  const weeks = Math.floor(span / 7);
  let lag = weeks * 5;
  for (let i = weeks * 7; i < span; i++) {
    if (isWeekday(firstCandidate + i * DAY_MS)) lag++;
  }
  return lag;
}

/**
 * True when the REFUSE-rule lag reaches FIXING_REFUSE_LAG. An absent or
 * malformed `asOf` never refuses here (the caller logs it; the fetch-age
 * ceiling in fx.ts still applies).
 */
export function isFixingRefused(asOf: string | undefined, now: number): boolean {
  if (asOf === undefined) return false;
  const lag = fixingLagBusinessDays(asOf, now, 'refuse');
  return lag !== null && lag >= FIXING_REFUSE_LAG;
}
