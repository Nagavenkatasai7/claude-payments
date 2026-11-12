import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  BENEFICIARY_LOCK_CLASS,
  CORRIDOR_PACKS,
  CORRIDOR_REFUSAL_CODES,
  IN_MTSS_V1,
  beneficiaryKeys,
  istYearBounds,
  packFor,
  packLimits,
  purposeAllowed,
} from '@/lib/corridor-pack';
import { corridorRowHash, type CorridorRow } from '@/lib/corridor-register';
import { PLATFORM_SEND_LIMITS } from '@/lib/send-limits';
import type { SendLimits } from '@/lib/types';

const now = new Date();
/** UTC YYYY-MM-DD of now + d days. */
const day = (d: number) => new Date(now.getTime() + d * 86_400_000).toISOString().slice(0, 10);
const MIN = 60_000;

/** An attested, active IN row with the India pack for partner 'pa'. */
function row(o: Partial<CorridorRow> = {}): CorridorRow {
  const base: CorridorRow = {
    destinationCountry: 'IN',
    status: 'active',
    rulePack: 'IN-MTSS-v1',
    purposeCodeMap: { family_support: 'P1301', gift: 'P1302', education: 'P1303' },
    attestationRef: 'att/2026.pdf',
    attestationSha256: 'a'.repeat(64),
    recipientNotices: true,
    travelDobFromUsd: null,
    travelFullFromUsd: null,
    reattestDue: day(180),
    partnerId: 'pa',
    recordedBy: 'admin',
    recordedAt: now.toISOString(),
    attestedBy: 'partner-admin',
    attestedAt: now.toISOString(),
    attestedHash: null,
    ...o,
  };
  return { ...base, attestedHash: 'attestedHash' in o ? o.attestedHash! : corridorRowHash(base) };
}

describe('corridor-pack: registry', () => {
  it('IN_MTSS_V1 holds the draft values and is deeply frozen', () => {
    expect(IN_MTSS_V1).toEqual({
      id: 'IN-MTSS-v1',
      valuesVersion: 'in-mtss-v1-2026-11-draft',
      perRemittanceCapCents: 250_000,
      perBeneficiaryYearCount: 30,
      allowedPurposes: ['family_support', 'gift', 'education', 'medical', 'savings'],
      yearUtcOffsetMinutes: 330,
    });
    expect(Object.isFrozen(IN_MTSS_V1)).toBe(true);
    expect(Object.isFrozen(IN_MTSS_V1.allowedPurposes)).toBe(true);
    expect(IN_MTSS_V1.valuesVersion.endsWith('-draft')).toBe(true);
    expect(CORRIDOR_PACKS['IN-MTSS-v1']).toBe(IN_MTSS_V1);
    expect(Object.isFrozen(CORRIDOR_PACKS)).toBe(true);
    expect([...CORRIDOR_REFUSAL_CODES]).toEqual(['beneficiary_year_count', 'prohibited_purpose']);
    expect(Object.isFrozen(CORRIDOR_REFUSAL_CODES)).toBe(true);
  });

  it('BENEFICIARY_LOCK_CLASS is 8042', () => {
    expect(BENEFICIARY_LOCK_CLASS).toBe(8042);
  });
});

describe('corridor-pack: packFor', () => {
  it('answers the pack only for an active IN pack row and an IN destination', () => {
    expect(packFor(row(), 'IN', now)).toBe(IN_MTSS_V1);
    expect(packFor(row(), 'GB', now)).toBeNull();
    expect(packFor(row({ rulePack: null }), 'IN', now)).toBeNull();
    expect(packFor(row({ status: 'suspended' }), 'IN', now)).toBeNull();
    expect(packFor(row({ attestedHash: null }), 'IN', now)).toBeNull();
    const past = row({ reattestDue: day(5) });
    expect(packFor(past, 'IN', new Date(now.getTime() + 10 * 86_400_000))).toBeNull();
    expect(packFor(null, 'IN', now)).toBeNull();
    expect(packFor(undefined, 'IN', now)).toBeNull();
  });

  it('a row for another destination never carries the pack', () => {
    // parseCorridorInput refuses this shape; packFor still answers null.
    expect(packFor(row({ destinationCountry: 'GB' }), 'IN', now)).toBeNull();
  });

  it('an unknown stored pack name is not looked up through the prototype', () => {
    const r = row({ rulePack: 'toString' as unknown as CorridorRow['rulePack'] });
    expect(packFor(r, 'IN', now)).toBeNull();
  });
});

describe('corridor-pack: packLimits', () => {
  it('packLimits(limits, null) returns the same object', () => {
    const l: SendLimits = { ...PLATFORM_SEND_LIMITS };
    expect(packLimits(l, null)).toBe(l);
  });

  it('packLimits tightens only', () => {
    const platform: SendLimits = { ...PLATFORM_SEND_LIMITS };
    const before = { ...platform };
    const out = packLimits(platform, IN_MTSS_V1);
    expect(out).toEqual({
      t0DailyCapCents: PLATFORM_SEND_LIMITS.t0DailyCapCents,
      t1DailyCapCents: PLATFORM_SEND_LIMITS.t1DailyCapCents,
      perTransferCapCents: 250_000,
      maxUsd: 2500,
    });
    expect(out).not.toBe(platform);
    expect(platform).toEqual(before);

    const partner: SendLimits = { t0DailyCapCents: 40_000, t1DailyCapCents: 150_000, perTransferCapCents: 100_000, maxUsd: 1000 };
    expect(packLimits(partner, IN_MTSS_V1)).toEqual(partner);
    const odd: SendLimits = { ...partner, perTransferCapCents: 100_050, maxUsd: 900 };
    expect(packLimits(odd, IN_MTSS_V1)).toEqual(odd);
  });

  it('works on a frozen input (PLATFORM_SEND_LIMITS itself)', () => {
    const out = packLimits(PLATFORM_SEND_LIMITS, IN_MTSS_V1);
    expect(out.perTransferCapCents).toBe(250_000);
    expect(PLATFORM_SEND_LIMITS.perTransferCapCents).toBe(299_900);
  });
});

describe('corridor-pack: purposeAllowed', () => {
  it('allowed only when the pack lists it AND the register maps it', () => {
    const r = row();
    expect(purposeAllowed(IN_MTSS_V1, r, 'family_support')).toBe(true);
    expect(purposeAllowed(IN_MTSS_V1, r, 'gift')).toBe(true);
    expect(purposeAllowed(IN_MTSS_V1, r, 'savings')).toBe(false);
    const mapped = row({
      purposeCodeMap: { family_support: 'P1301', business: 'P0101', bills: 'P1006', other: 'P9999' },
    });
    expect(purposeAllowed(IN_MTSS_V1, mapped, 'business')).toBe(false);
    expect(purposeAllowed(IN_MTSS_V1, mapped, 'bills')).toBe(false);
    expect(purposeAllowed(IN_MTSS_V1, mapped, 'other')).toBe(false);
    expect(purposeAllowed(IN_MTSS_V1, r, null)).toBe(false);
    expect(purposeAllowed(IN_MTSS_V1, r, undefined)).toBe(false);
    expect(purposeAllowed(IN_MTSS_V1, null, 'family_support')).toBe(false);
  });
});

describe('corridor-pack: istYearBounds', () => {
  it('istYearBounds at the India new year edge', () => {
    const Y = now.getUTCFullYear();
    const edge = Date.UTC(Y, 0, 1) - 330 * MIN;
    expect(istYearBounds(new Date(edge - 1)).year).toBe(Y - 1);
    const b = istYearBounds(new Date(edge));
    expect(b.year).toBe(Y);
    expect(b.start.getTime()).toBe(edge);
    expect(b.start.toISOString()).toBe(`${Y - 1}-12-31T18:30:00.000Z`);
    expect(b.end.toISOString()).toBe(`${Y}-12-31T18:30:00.000Z`);
    const days = (b.end.getTime() - b.start.getTime()) / 86_400_000;
    expect([365, 366]).toContain(days);
    const prev = istYearBounds(new Date(edge - 1));
    expect(prev.end.getTime()).toBe(b.start.getTime());

    const cur = istYearBounds(new Date());
    const t = Date.now();
    expect(cur.start.getTime()).toBeLessThanOrEqual(t);
    expect(cur.end.getTime()).toBeGreaterThan(t);
  });
});

describe('corridor-pack: beneficiaryKeys', () => {
  it('builds the b and p keys, owner-bound and de-duplicated', () => {
    expect(beneficiaryKeys('pa', 'bx1', '919876543210')).toEqual(['ben:pa:b:bx1', 'ben:pa:p:919876543210']);
    expect(beneficiaryKeys('pa', 'bx1', null)).toEqual(['ben:pa:b:bx1']);
    expect(beneficiaryKeys('pa', null, '919876543210')).toEqual(['ben:pa:p:919876543210']);
    expect(beneficiaryKeys('pa', null, '+91 98765-43210')).toEqual(['ben:pa:p:919876543210']);
    expect(beneficiaryKeys('pa', '  bx1  ', undefined)).toEqual(['ben:pa:b:bx1']);
    expect(beneficiaryKeys('pa', '', '')).toEqual([]);
    expect(beneficiaryKeys('pa', '  ', '+ -')).toEqual([]);
    expect(beneficiaryKeys('pa', null, null)).toEqual([]);
    expect(beneficiaryKeys('pa', undefined, undefined)).toEqual([]);
    const k = beneficiaryKeys('pa', 'bx1', '919876543210');
    expect(new Set(k).size).toBe(k.length);
    expect(beneficiaryKeys('pa', 'bx1', '9198')).not.toEqual(beneficiaryKeys('pb', 'bx1', '9198'));
  });
});

describe('corridor-pack: server only', () => {
  it("no 'use client' file imports corridor-pack", () => {
    const SRC = join(process.cwd(), 'src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name)) files.push(p);
      }
    };
    walk(SRC);
    const useClient = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*['"]use client['"]/;
    const offenders = files
      .filter((f) => useClient.test(readFileSync(f, 'utf8')))
      .filter((f) => /['"][^'"]*\/corridor-pack['"]/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(process.cwd(), f));
    expect(files.length).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });
});
