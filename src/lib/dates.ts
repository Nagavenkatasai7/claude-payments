const ET = 'America/New_York';

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
  const d = new Date(epochMs);
  if (isNaN(d.getTime())) {
    throw new RangeError(`easternDayOfMonth: invalid epochMs ${epochMs}`);
  }
  return Number(
    d.toLocaleString('en-US', { timeZone: ET, day: 'numeric' }),
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
