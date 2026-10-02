import { describe, it, expect } from 'vitest';
import type { Transfer } from '@/lib/types';
import { monthlyBuckets, sentThisMonthUsd, sentUsd } from '@/lib/customer-stats';

// One customer portal (Oct 2): the old /account home's "Sent this month" maths, moved unchanged so the
// portal home shows the same number. Dates are relative to `now` (never hardcoded windows).

const now = new Date();
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
const tx = (o: Partial<Transfer>): Transfer => ({ id: 'T', status: 'delivered', amountUsd: 10, createdAt: now.toISOString(), ...o }) as Transfer;

describe('sentUsd', () => {
  it('counts only money that left the customer (paid or delivered)', () => {
    expect(sentUsd(tx({ status: 'delivered', amountUsd: 12 }))).toBe(12);
    expect(sentUsd(tx({ status: 'paid', amountUsd: 5 }))).toBe(5);
    for (const status of ['awaiting_payment', 'in_review', 'cancelled', 'blocked'] as Transfer['status'][]) {
      expect({ status, usd: sentUsd(tx({ status, amountUsd: 99 })) }).toEqual({ status, usd: 0 });
    }
  });
  it('falls back to the source amount when there is no USD amount', () => {
    expect(sentUsd(tx({ amountUsd: undefined, amountSource: 7 }))).toBe(7);
  });
});

describe('monthlyBuckets', () => {
  it('six months oldest → newest, the newest is the current month, rounded to cents', () => {
    const b = monthlyBuckets([tx({ amountUsd: 10.005 }), tx({ amountUsd: 0.1 })], now);
    expect(b).toHaveLength(6);
    expect(b[5].volumeUsd).toBe(10.11);
    expect(b.slice(0, 5).every((x) => x.volumeUsd === 0)).toBe(true);
  });
  it('buckets by the EASTERN month of now, whatever the server time zone', () => {
    // 05:20 UTC on Oct 2 is 01:20 on Oct 2 in New York; 23:00 UTC on Sep 30 is 19:00 Sep 30 there.
    const at = new Date('2026-10-02T05:20:00Z');
    const b = monthlyBuckets(
      [tx({ createdAt: '2026-10-01T14:00:00Z', amountUsd: 3 }), tx({ createdAt: '2026-09-30T23:00:00Z', amountUsd: 40 })],
      at,
    );
    expect(b.map((x) => x.key)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    expect(b.map((x) => x.month)).toEqual(['May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
    expect(b[5].volumeUsd).toBe(3);
    expect(b[4].volumeUsd).toBe(40);
  });
  it('a year boundary counts back into the previous year', () => {
    const b = monthlyBuckets([], new Date('2027-02-10T12:00:00Z'));
    expect(b.map((x) => x.key)).toEqual(['2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02']);
  });
  it('ignores transfers older than the window', () => {
    expect(monthlyBuckets([tx({ createdAt: daysAgo(400) })], now).every((x) => x.volumeUsd === 0)).toBe(true);
  });
});

describe('sentThisMonthUsd', () => {
  it('is the current month bucket', () => {
    expect(sentThisMonthUsd([tx({ amountUsd: 20 }), tx({ status: 'cancelled', amountUsd: 50 })], now)).toBe(20);
    expect(sentThisMonthUsd([], now)).toBe(0);
  });
});
