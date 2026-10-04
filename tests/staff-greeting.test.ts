import { describe, it, expect } from 'vitest';
import { greetingFor } from '@/lib/staff-greeting';

// The admin Overview greets by the New York clock (the dashboard's day boundary everywhere).
const NY = 'America/New_York';

describe('greetingFor', () => {
  it('morning before noon, afternoon until 17:00, evening after (New York time)', () => {
    expect(greetingFor(new Date('2026-10-04T09:00:00Z'), NY)).toBe('Good morning'); // 05:00 EDT
    expect(greetingFor(new Date('2026-10-04T15:59:00Z'), NY)).toBe('Good morning'); // 11:59 EDT
    expect(greetingFor(new Date('2026-10-04T16:00:00Z'), NY)).toBe('Good afternoon'); // 12:00 EDT
    expect(greetingFor(new Date('2026-10-04T20:59:00Z'), NY)).toBe('Good afternoon'); // 16:59 EDT
    expect(greetingFor(new Date('2026-10-04T21:00:00Z'), NY)).toBe('Good evening'); // 17:00 EDT
  });
  it('after midnight is evening until 05:00, then morning', () => {
    expect(greetingFor(new Date('2026-10-04T05:30:00Z'), NY)).toBe('Good evening'); // 01:30 EDT
    expect(greetingFor(new Date('2026-10-04T08:59:00Z'), NY)).toBe('Good evening'); // 04:59 EDT
  });
  it('follows the zone, not the server clock', () => {
    expect(greetingFor(new Date('2026-10-04T09:00:00Z'), 'Asia/Kolkata')).toBe('Good afternoon'); // 14:30 IST
  });
});
