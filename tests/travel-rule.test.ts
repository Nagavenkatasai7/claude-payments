import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DOB_DESTINATIONS,
  LIMIT_NEEDS_ADDRESS_COPY,
  TRAVEL_RULE_DOB_FROM_USD,
  TRAVEL_RULE_FULL_FROM_USD,
  limitRaiseNeedsAddress,
  originatorDataMissing,
  travelRuleRequirement,
  validateSenderAddress,
  validateSenderDob,
} from '@/lib/travel-rule';
import { PLATFORM_SEND_LIMITS } from '@/lib/send-limits';
import type { CountryCode } from '@/lib/types';

// Fix pack 5 (R38, P18): the travel-rule bands and the originator validators.
// Every date is built from Date.now(); no calendar literal touches a window.

const ADDRESS = { band: 'address', address: true, dateOfBirth: false } as const;
const FULL = { band: 'address_dob', address: true, dateOfBirth: true } as const;

/**
 * YYYY-MM-DD (UTC) of `now` moved by whole years, then by `days`. Built from
 * the UTC year, month and day parts; 29 February clamps to 28 February in a
 * target year that is not a leap year (setUTCFullYear would roll it over to
 * 1 March, review round 1 RG1).
 */
function ymd(now: Date, years: number, days = 0): string {
  const y = now.getUTCFullYear() + years;
  const m = now.getUTCMonth();
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const day = m === 1 && now.getUTCDate() === 29 && !leap ? 28 : now.getUTCDate();
  const d = new Date(Date.UTC(y, m, day));
  d.setUTCFullYear(y); // Date.UTC maps years 0-99 to 1900-1999
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe('travel-rule constants pinned', () => {
  it('bands, the 14 DOB destinations (frozen), the limit copy and the platform cap it sits on', () => {
    expect(TRAVEL_RULE_DOB_FROM_USD).toBe(1000);
    expect(TRAVEL_RULE_FULL_FROM_USD).toBe(3000);
    expect(Object.isFrozen(DOB_DESTINATIONS)).toBe(true);
    expect([...DOB_DESTINATIONS]).toEqual(['DE', 'FR', 'NL', 'IE', 'IT', 'ES', 'AT', 'BE', 'GB', 'CA', 'AU', 'SG', 'NZ', 'HK']);
    expect(LIMIT_NEEDS_ADDRESS_COPY).toBe("Capture the sender's address first: limits above $2,999 need it on file.");
    expect(PLATFORM_SEND_LIMITS.perTransferCapCents).toBe(299_900);
  });
});

describe('travelRuleRequirement boundaries', () => {
  const table: [CountryCode | null | undefined, number, typeof ADDRESS | typeof FULL][] = [
    ['IN', 0.01, ADDRESS], ['IN', 999.99, ADDRESS], ['IN', 1000, ADDRESS], ['IN', 2999.99, ADDRESS],
    ['IN', 3000, FULL], ['IN', 5000, FULL],
    ['GB', 999.99, ADDRESS], ['GB', 1000, FULL],
    ['DE', 999.99, ADDRESS], ['DE', 1000, FULL],
    ['CA', 999.99, ADDRESS], ['CA', 1000, FULL],
    ['MX', 2999.99, ADDRESS], ['MX', 3000, FULL],
    ['AE', 2999.99, ADDRESS], ['AE', 3000, FULL],
    ['US', 2999.99, ADDRESS], ['US', 3000, FULL],
    [null, 1000, ADDRESS], [null, 3000, FULL],
    [undefined, 1000, ADDRESS], [undefined, 3000, FULL],
  ];
  it.each(table)('%s at %s', (destinationCountry, amountUsd, want) => {
    expect(travelRuleRequirement({ destinationCountry, amountUsd })).toEqual(want);
  });

  it('a NaN, infinite or negative amount asks the address only and never throws', () => {
    for (const amountUsd of [NaN, -1, -5000, Infinity, -Infinity]) {
      expect(travelRuleRequirement({ destinationCountry: 'GB', amountUsd }), String(amountUsd)).toEqual(ADDRESS);
    }
  });
});

describe('originatorDataMissing', () => {
  it('address required and not on file; DOB required and missing; both on file; DOB not required', () => {
    expect(originatorDataMissing(ADDRESS, { address: false, dateOfBirth: true })).toBe(true);
    expect(originatorDataMissing(FULL, { address: true, dateOfBirth: false })).toBe(true);
    expect(originatorDataMissing(FULL, { address: true, dateOfBirth: true })).toBe(false);
    expect(originatorDataMissing(ADDRESS, { address: true, dateOfBirth: false })).toBe(false);
  });
});

describe('limitRaiseNeedsAddress', () => {
  it('only above the $2,999 platform cap, on a real-money owner, with no address on file', () => {
    expect(limitRaiseNeedsAddress({ perTransferCapCents: 299_900, ownerRealMoney: true, addressOnFile: false })).toBe(false);
    expect(limitRaiseNeedsAddress({ perTransferCapCents: 299_901, ownerRealMoney: true, addressOnFile: false })).toBe(true);
    expect(limitRaiseNeedsAddress({ perTransferCapCents: 299_901, ownerRealMoney: true, addressOnFile: true })).toBe(false);
    expect(limitRaiseNeedsAddress({ perTransferCapCents: 299_901, ownerRealMoney: false, addressOnFile: false })).toBe(false);
  });
});

describe('validateSenderAddress', () => {
  it('trims and accepts 5..300 printable one-line characters with no web address', () => {
    expect(validateSenderAddress('  1 Test Street, Testville  ')).toEqual({ ok: true, value: '1 Test Street, Testville' });
    expect(validateSenderAddress('a'.repeat(300))).toEqual({ ok: true, value: 'a'.repeat(300) });
    expect(validateSenderAddress('1 Tst')).toEqual({ ok: true, value: '1 Tst' });
  });

  it('refuses empty, blank, too short, too long, a line break, a tab, a zero-width character, a web address and a non-string', () => {
    const bad: unknown[] = [
      '', '    ', 'abcd', 'a'.repeat(301), '1 Test Street\nTestville', '1 Test\tStreet',
      '1 Test​Street', 'see www.example.com', 'https://x.test', 42, null, undefined, {},
    ];
    for (const v of bad) {
      expect(validateSenderAddress(v as string), JSON.stringify(v)).toEqual({ ok: false });
    }
  });

  // Fix pack 5 review round 2 (GB3): a dot before a US state / territory code, "us" or
  // "in" with no space is an address, not a web address. Only the bare-domain rule is
  // relaxed, and only for the clashing endings ca, co, de, in, me, us.
  it('accepts a dot before a clashing state / country code (no space)', () => {
    for (const v of [
      '12 Elm St, Denver.CO 80202',
      'Indianapolis.IN 46204',
      '9 Main St, Sacramento.ca 95814',
      '4 Front St, Dover.DE',
      '7 Pine Rd, Portland.Me 04101',
      '1 Liberty Ave, Anytown.US',
      // Review round 2 R2 (F5-D2): a period that only closes the code.
      '12 Elm St, Denver.CO. 80202',
      'Indianapolis.IN.',
      // Final check F9 (R2-T1): an ideographic full stop before the code folds to "." and is accepted.
      'Denver\u3002CO 80202',
    ]) {
      expect(validateSenderAddress(v), v).toEqual({ ok: true, value: v });
    }
  });

  it('still refuses a scheme, www., an IPv4 address, another ending, or a clashing ending used as a host', () => {
    for (const v of [
      'pay at evil.com now',
      'http://x.co/a',
      'www.evil.co',
      '10.0.0.1',
      'see evil.co/a',
      'evil.co:8080 Main St',
      'pay.evil.co now',
      'mail me at a@evil.co',
      'send to evil.uk now',
      'evil[.]co please',
      // Review round 2 R2 (F5-D1): full-width "/", ":" and "@", a query and a fragment.
      'evil.co\uFF0Fpath here',
      'evil.co\uFF1A8080 Main',
      'a\uFF20evil.co main st',
      'evil.co?x=1 main',
      'evil.co#x main',
      // (F5-D2): a dot that continues a chain or a path is still a host.
      'x.co.uk main',
      'evil.co./path',
      'evil.co]/path',
      'evil\u3002co/path',
      // Final check F9 (R2-T1): pins the ideographic-dot fold and the bracket in the lookbehind.
      'evil.co\u3002/path',
      'pay.[]evil.co here',
    ]) {
      expect(validateSenderAddress(v), v).toEqual({ ok: false });
    }
  });
});

/** The 18 / 120 / 121 year boundaries at `now` (shared by the today and the leap-day cases). */
function expectAgeBoundsAccepted(now: Date): void {
  const at18 = ymd(now, -18);
  const at120 = ymd(now, -120);
  expect(validateSenderDob(at18, now)).toEqual({ ok: true, value: at18 });
  expect(validateSenderDob(at120, now)).toEqual({ ok: true, value: at120 });
  expect(validateSenderDob(ymd(now, -40), now)).toEqual({ ok: true, value: ymd(now, -40) });
}

function expectAgeBoundsRefused(now: Date): void {
  const bad: unknown[] = [
    ymd(now, -18, 1), // 17 years and 364 (or 365) days
    ymd(now, -121),
    ymd(now, -121, -1),
    ymd(now, 1),
    '2020-02-30', '2000-1-01', '01/02/1990', ' 1990-01-02 ', '1990-01-02T00:00:00Z', 19900102, null, undefined,
  ];
  for (const v of bad) {
    expect(validateSenderDob(v as string, now), JSON.stringify(v)).toEqual({ ok: false });
  }
}

describe('validateSenderDob', () => {
  const now = new Date(Date.now());

  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts exactly 18 and exactly 120 years old at now (UTC)', () => {
    expectAgeBoundsAccepted(now);
  });

  it('refuses 17 years 364 days, 121 years, an impossible date, loose formats, padding and a non-string', () => {
    expectAgeBoundsRefused(now);
  });

  // Review round 1 RG1: on 29 February the year-shifted test dates must not
  // roll over to 1 March (the one case where a fixed calendar date is the
  // point of the test).
  it('the same 18 / 120 / 121 year boundaries hold when today is 29 February (2028-02-29)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2028-02-29T12:00:00Z'));
    const leapNow = new Date(Date.now());
    expect(ymd(leapNow, -18)).toBe('2010-02-28');
    expectAgeBoundsAccepted(leapNow);
    expectAgeBoundsRefused(leapNow);
  });

  it('a now that is not a valid date refuses every value', () => {
    expect(validateSenderDob(ymd(new Date(Date.now()), -40), new Date(NaN))).toEqual({ ok: false });
  });
});
