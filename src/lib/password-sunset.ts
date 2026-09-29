// password-sunset — UI redesign M2-14 Task 14.2. The legacy apex /account
// password sign-in ends 30 days after the partner portals launch (retirement
// itself is M5). CUSTOMER_PASSWORD_SUNSET holds that end date as an ISO date
// (YYYY-MM-DD); the /account layout shows a banner only while it is set and
// valid. Formatted in UTC so the server-rendered text never depends on the
// server's timezone.
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const FORMAT = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });

/** The sunset date as "November 6, 2026", or null when unset or not a real calendar date. */
export function passwordSunsetLabel(raw: string | undefined): string | null {
  const m = ISO_DATE.exec((raw ?? '').trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(y, mo - 1, d));
  // Round-trip: 2026-02-30 would roll over to March 2.
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d) return null;
  return FORMAT.format(at);
}
