import { describe, it, expect } from 'vitest';
import { ANALYTICS_ROW_CAP, analyticsHref, buildPartnerAnalytics, parseAnalyticsWindow } from '@/lib/partner-analytics';
import type { Transfer } from '@/lib/types';

// Merge plan 2d: the PURE view model behind /partner/analytics. It reuses the tested @/lib/analytics
// functions and never carries a phone or a full recipient name (top recipients are shortened, p3 B8).
const DAY = 86_400_000;
const NOW = Date.now();

const mk = (o: Partial<Transfer>): Transfer =>
  ({
    id: 't',
    phone: '14155550101',
    amountUsd: 100,
    feeUsd: 2,
    totalChargeUsd: 102,
    fxRate: 85,
    amountInr: 8500,
    recipientName: 'Testname Samplesurname',
    recipientPhone: '919876543210',
    payoutMethod: 'bank',
    payoutDestination: '****2222',
    fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared',
    complianceReasons: [],
    status: 'delivered',
    createdAt: new Date(NOW - 60_000).toISOString(),
    ...o,
  }) as Transfer;

describe('parseAnalyticsWindow', () => {
  it('accepts 7, 30 and 90; anything else is 30', () => {
    expect(parseAnalyticsWindow('7')).toBe(7);
    expect(parseAnalyticsWindow('30')).toBe(30);
    expect(parseAnalyticsWindow('90')).toBe(90);
    for (const bad of [undefined, '', '365', '7.0', ' 7', '-7', ['7'], '0x7', 'Infinity']) expect(parseAnalyticsWindow(bad), String(bad)).toBe(30);
  });
  it('analyticsHref builds the window links', () => {
    expect(analyticsHref(7)).toBe('/partner/analytics?window=7');
    expect(analyticsHref(30)).toBe('/partner/analytics');
  });
});

describe('buildPartnerAnalytics', () => {
  const rows = [
    mk({ id: 'a', amountUsd: 100, feeUsd: 2, status: 'delivered' }),
    mk({ id: 'b', amountUsd: 50.5, feeUsd: 1.25, status: 'paid', fundingMethod: 'debit_card' }),
    mk({ id: 'c', amountUsd: 20, feeUsd: 1, status: 'awaiting_payment', complianceStatus: 'flagged' }),
    mk({ id: 'old', amountUsd: 999, feeUsd: 9, createdAt: new Date(NOW - 10 * DAY).toISOString() }),
  ];
  it('totals the window: count, volume, commission (paid/delivered fees only)', () => {
    const m = buildPartnerAnalytics(rows, NOW, 7, false);
    expect(m.windowDays).toBe(7);
    expect(m.totals).toEqual({ count: 3, volumeUsd: 170.5, commissionUsd: 3.25 });
    expect(buildPartnerAnalytics(rows, NOW, 30, false).totals.count).toBe(4);
  });
  it('daily series have one bucket per day of the window', () => {
    const m = buildPartnerAnalytics(rows, NOW, 30, false);
    expect(m.daily.counts).toHaveLength(30);
    expect(m.daily.volume).toHaveLength(30);
    expect(m.daily.commission).toHaveLength(30);
    expect(m.daily.counts.reduce((s, d) => s + d.count, 0)).toBe(4);
  });
  it('distributions come from the in-window rows', () => {
    const m = buildPartnerAnalytics(rows, NOW, 7, false);
    expect(m.status).toEqual(expect.arrayContaining([{ status: 'delivered', count: 1 }, { status: 'paid', count: 1 }, { status: 'awaiting_payment', count: 1 }]));
    expect(m.compliance).toEqual([{ status: 'cleared', count: 2 }, { status: 'flagged', count: 1 }]);
    expect(m.funding).toEqual([{ method: 'bank_transfer', count: 2 }, { method: 'debit_card', count: 1 }]);
  });
  it('never carries a full recipient name, phone or payout destination (p3 B8: names are shortened)', () => {
    const json = JSON.stringify(buildPartnerAnalytics(rows, NOW, 90, false));
    for (const pii of ['Samplesurname', '14155550101', '919876543210', '2222']) expect(json).not.toContain(pii);
    expect(json).toContain('1. Testname S.');
  });
  it('top recipients: grouped on the FULL name server-side, ranked, at most 10, in-window only', () => {
    const many = [
      mk({ id: 'x1', recipientName: 'Testname Samplesurname' }),
      mk({ id: 'x2', recipientName: 'Testname Samplesurname' }),
      // Same mask ("Testname S."), different person: two rows, told apart by the rank.
      mk({ id: 'x3', recipientName: 'Testname Secondsurname' }),
      mk({ id: 'old', recipientName: 'Oldname Outside', createdAt: new Date(NOW - 10 * DAY).toISOString() }),
      ...Array.from({ length: 12 }, (_, i) => mk({ id: `n${i}`, recipientName: `Zed${String.fromCharCode(97 + i)} Last${i}` })),
    ];
    const top = buildPartnerAnalytics(many, NOW, 7, false).topRecipients;
    expect(top).toHaveLength(10);
    expect(top[0]).toEqual({ label: '1. Testname S.', count: 2 });
    expect(top[1]).toEqual({ label: '2. Testname S.', count: 1 });
    const json = JSON.stringify(top);
    for (const pii of ['Samplesurname', 'Secondsurname', 'Oldname', 'Last1']) expect(json).not.toContain(pii);
  });
  it('passes the truncation flag through; the cap is bounded', () => {
    expect(buildPartnerAnalytics([], NOW, 30, true).truncated).toBe(true);
    expect(buildPartnerAnalytics([], NOW, 30, false)).toMatchObject({ truncated: false, totals: { count: 0, volumeUsd: 0, commissionUsd: 0 } });
    expect(ANALYTICS_ROW_CAP).toBeGreaterThanOrEqual(1000);
    expect(ANALYTICS_ROW_CAP).toBeLessThanOrEqual(20_000);
  });
});
