// Fix pack 4 T7 (C16): the stored delivery days win over the partner's current value.
import { describe, expect, it } from 'vitest';
import { deliveryDaysFor } from '../src/lib/remittance-disclosure';
import type { ResolvedDisclosure } from '../src/lib/partner-config';

const d = (days: number): ResolvedDisclosure => ({
  demo: false,
  configured: true,
  licensedEntity: 'Acme Money Services LLC',
  licenseIds: [],
  phone: null,
  website: null,
  stateRegulator: null,
  deliveryBusinessDays: days,
  partnerApproved: false,
  hash: null,
});

describe('deliveryDaysFor (C16)', () => {
  it('stored value wins (0, 3, 10)', () => {
    expect(deliveryDaysFor({ deliveryBusinessDays: 0 }, d(5))).toBe(0);
    expect(deliveryDaysFor({ deliveryBusinessDays: 3 }, d(1))).toBe(3);
    expect(deliveryDaysFor({ deliveryBusinessDays: 10 }, d(1))).toBe(10);
  });

  it('undefined -> d.deliveryBusinessDays', () => {
    expect(deliveryDaysFor({}, d(2))).toBe(2);
    expect(deliveryDaysFor({ deliveryBusinessDays: undefined }, d(0))).toBe(0);
  });
});
