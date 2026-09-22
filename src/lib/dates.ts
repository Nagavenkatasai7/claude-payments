const ET = 'America/New_York';

// ── ET calendar bounds (Program fix 16 / Task 10) ─────────────────────────
// The ledger cap totals (transfer-repo.senderTotalsSince) are a plain
// created_at range: [easternDayStart(now), …) for today's spend and velocity,
// [easternMonthStart(now), …) for the rolling-month EDD total. Both helpers
// return the UTC instant of ET midnight and are correct on the DST edge days:
// the ET offset is re-read AT the candidate midnight (not at `now`), so a
// 23:30 EDT instant on the spring-forward day still yields the EST midnight.

const ET_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: ET,
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function etParts(at: Date): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const p: Record<string, number> = {};
  for (const { type, value } of ET_PARTS.formatToParts(at)) {
    if (type !== 'literal') p[type] = Number(value);
  }
  return { y: p.year, m: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}

/** ET's offset from UTC at `at`, in ms (EST ⇒ -5h, EDT ⇒ -4h). */
function etOffsetMs(at: Date): number {
  const { y, m, d, h, mi, s } = etParts(at);
  return Date.UTC(y, m - 1, d, h, mi, s) - Math.floor(at.getTime() / 1000) * 1000;
}

/** The UTC instant of ET midnight on the ET calendar date (y, m, d). */
function etMidnight(y: number, m: number, d: number, near: Date): Date {
  const wall = Date.UTC(y, m - 1, d);
  // First guess uses the offset at `near`; re-read the offset at the guess so
  // a DST transition between `near` and midnight is corrected (2 passes suffice:
  // the transition is at 02:00 local, never at midnight).
  let guess = wall - etOffsetMs(near);
  guess = wall - etOffsetMs(new Date(guess));
  return new Date(guess);
}

function asDate(at: number | Date, fn: string): Date {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) throw new RangeError(`${fn}: invalid instant ${String(at)}`);
  return d;
}

/** ET midnight of the ET calendar day containing `at`. */
export function easternDayStart(at: number | Date): Date {
  const d = asDate(at, 'easternDayStart');
  const { y, m, d: day } = etParts(d);
  return etMidnight(y, m, day, d);
}

/** ET midnight of the first day of the ET calendar month containing `at`. */
export function easternMonthStart(at: number | Date): Date {
  const d = asDate(at, 'easternMonthStart');
  const { y, m } = etParts(d);
  return etMidnight(y, m, 1, d);
}

export function easternDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString('en-US', { timeZone: ET });
}

export function easternMonth(epochMs: number): string {
  const d = new Date(epochMs);
  const year = d.toLocaleString('en-US', { timeZone: ET, year: 'numeric' });
  const month = d.toLocaleString('en-US', { timeZone: ET, month: '2-digit' });
  return `${year}-${month}`;
}

export function easternDayOfMonth(epochMs: number): number {
  return Number(
    new Date(epochMs).toLocaleString('en-US', { timeZone: ET, day: 'numeric' }),
  );
}

export function easternDayOfWeek(epochMs: number): number {
  const short = new Date(epochMs).toLocaleString('en-US', {
    timeZone: ET,
    weekday: 'short',
  });
  const idx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(short);
  if (idx === -1) {
    throw new RangeError(`easternDayOfWeek: invalid epochMs ${epochMs}`);
  }
  return idx;
}
