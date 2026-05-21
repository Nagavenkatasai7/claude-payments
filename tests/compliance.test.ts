import { describe, it, expect } from 'vitest';
import { screenTransfer } from '@/lib/compliance';

describe('screenTransfer', () => {
  it('clears an ordinary transfer', () => {
    const r = screenTransfer({ amountUsd: 200, recipientName: 'Mom', transfersToday: 0 });
    expect(r.status).toBe('cleared');
    expect(r.reasons).toEqual([]);
  });

  it('blocks a recipient on the watchlist (case-insensitive)', () => {
    const r = screenTransfer({ amountUsd: 200, recipientName: '  John Doe ', transfersToday: 0 });
    expect(r.status).toBe('blocked');
    expect(r.reasons[0]).toMatch(/watchlist/i);
  });

  it('flags a large amount', () => {
    const r = screenTransfer({ amountUsd: 1500, recipientName: 'Mom', transfersToday: 0 });
    expect(r.status).toBe('flagged');
    expect(r.reasons.some((x) => /amount/i.test(x))).toBe(true);
  });

  it('flags high velocity', () => {
    const r = screenTransfer({ amountUsd: 200, recipientName: 'Mom', transfersToday: 3 });
    expect(r.status).toBe('flagged');
    expect(r.reasons.some((x) => /velocity/i.test(x))).toBe(true);
  });

  it('records both reasons when amount and velocity both trip', () => {
    const r = screenTransfer({ amountUsd: 1500, recipientName: 'Mom', transfersToday: 4 });
    expect(r.status).toBe('flagged');
    expect(r.reasons).toHaveLength(2);
  });

  it('blocked takes precedence over flagged', () => {
    const r = screenTransfer({ amountUsd: 2000, recipientName: 'John Doe', transfersToday: 9 });
    expect(r.status).toBe('blocked');
  });
});
