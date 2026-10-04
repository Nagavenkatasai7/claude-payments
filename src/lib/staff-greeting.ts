/**
 * The admin Overview greeting ("Good morning, <name>"), by the hour in `timeZone` (the dashboard uses
 * America/New_York for its day boundary). Morning is 05:00–11:59, afternoon 12:00–16:59, evening
 * otherwise. Pure: the caller passes the clock.
 */
export function greetingFor(now: Date, timeZone: string): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(now),
  );
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 17) return 'Good afternoon';
  return 'Good evening';
}
