import { describe, it, expect } from 'vitest';
import { calcDestinations, LAUNCH_DESTINATION } from '@/app/landing/calc-destinations';
import { WAITLIST_DESTINATIONS } from '@/app/landing/corridors';
import { destAmount } from '@/app/landing/format';

// Raj's website brief (Oct 25), widget step 2: the landing calculator gets a "to" picker.
// US to India is the launch corridor; every other supported country is "coming next".

describe('calcDestinations', () => {
  const toUsd = { INR: 0.0105, GBP: 1.34, EUR: 1.12, MXN: 0.058 } as const;
  const list = calcDestinations(94.96, (c) => (c in toUsd ? toUsd[c as keyof typeof toUsd] : null));

  it('puts India first as the only launch destination, priced from the USD to INR rate', () => {
    expect(LAUNCH_DESTINATION).toBe('IN');
    expect(list[0]).toEqual({ code: 'IN', name: 'India', currency: 'INR', rate: 94.96, launch: true });
    expect(list.filter((d) => d.launch)).toHaveLength(1);
  });

  it('lists every other waitlist country except the US (the send-from country), once', () => {
    const want = WAITLIST_DESTINATIONS.map((d) => d.value).filter((c) => c !== 'US');
    expect(list.map((d) => d.code).sort()).toEqual([...want].sort());
    expect(list.find((d) => d.code === 'US')).toBeUndefined();
  });

  it('prices a coming-next country as USD to its currency (1 / its USD value)', () => {
    const gb = list.find((d) => d.code === 'GB')!;
    expect(gb).toMatchObject({ name: 'United Kingdom', currency: 'GBP', launch: false });
    expect(gb.rate).toBeCloseTo(1 / 1.34, 6);
    expect(list.find((d) => d.code === 'DE')!.currency).toBe('EUR');
  });

  it('shows no figure when a leg is missing, invalid or the India rate is unavailable', () => {
    expect(list.find((d) => d.code === 'CA')!.rate).toBeNull();
    const bad = calcDestinations(null, () => 0);
    expect(bad.every((d) => d.rate === null)).toBe(true);
    const nan = calcDestinations(Number.NaN, () => Number.POSITIVE_INFINITY);
    expect(nan.every((d) => d.rate === null)).toBe(true);
  });
});

describe('destAmount', () => {
  it('keeps the whole-rupee lakh grouping for INR', () => {
    expect(destAmount(169500.4, 'INR')).toBe('₹1,69,500');
  });
  it('formats other currencies with their symbol and two decimals', () => {
    expect(destAmount(745.5, 'GBP')).toBe('£745.50');
    expect(destAmount(1000, 'EUR')).toBe('€1,000.00');
    expect(destAmount(17191.7, 'MXN')).toBe('MX$17,191.70');
  });
});
