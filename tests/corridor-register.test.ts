import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  CORRIDOR_STATUSES,
  RULE_PACKS,
  CORRIDOR_ROW_HASH_VERSION,
  REATTEST_REMINDER_DAYS,
  parseCorridorInput,
  corridorRowHash,
  corridorActive,
  reattestReminderDue,
  travelBandOf,
  purposeCodeFor,
  corridorDecision,
  type CorridorInput,
  type CorridorRow,
} from '@/lib/corridor-register';
import { SUGGESTED_RBI_CODE } from '@/lib/purpose-codes';
import type { TransferPurpose } from '@/lib/types';

const now = new Date();
/** UTC YYYY-MM-DD of now + d days. */
const day = (d: number) => new Date(now.getTime() + d * 86_400_000).toISOString().slice(0, 10);

function input(o: Partial<CorridorInput> = {}): CorridorInput {
  return {
    destinationCountry: 'IN',
    status: 'active',
    rulePack: 'IN-MTSS-v1',
    purposeCodeMap: { family_support: 'P1301' },
    attestationRef: 'att/2026.pdf',
    attestationSha256: 'a'.repeat(64),
    recipientNotices: true,
    travelDobFromUsd: null,
    travelFullFromUsd: null,
    reattestDue: day(180),
    ...o,
  };
}

/** A valid active IN row for partner 'pa', attested on its own hash. */
function row(o: Partial<CorridorRow> = {}): CorridorRow {
  const base: CorridorRow = {
    ...input(),
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

describe('corridor-register: closed lists', () => {
  it('CORRIDOR_STATUSES and RULE_PACKS are exact and frozen', () => {
    expect([...CORRIDOR_STATUSES]).toEqual(['active', 'suspended', 'closed']);
    expect([...RULE_PACKS]).toEqual(['IN-MTSS-v1']);
    expect(Object.isFrozen(CORRIDOR_STATUSES)).toBe(true);
    expect(Object.isFrozen(RULE_PACKS)).toBe(true);
    expect(CORRIDOR_ROW_HASH_VERSION).toBe('pc1');
    expect(REATTEST_REMINDER_DAYS).toBe(14);
  });
});

describe('corridor-register: parseCorridorInput', () => {
  it('accepts a valid input (with and without a pack, bands null and set, map empty and full)', () => {
    expect(parseCorridorInput(input(), now)).toEqual(input());
    expect(parseCorridorInput(input({ rulePack: null }), now)).toEqual(input({ rulePack: null }));
    const gb = input({ destinationCountry: 'GB', rulePack: null, purposeCodeMap: {}, attestationSha256: null });
    expect(parseCorridorInput(gb, now)).toEqual(gb);
    const banded = input({ travelDobFromUsd: 500.5, travelFullFromUsd: 3000 });
    expect(parseCorridorInput(banded, now)).toEqual(banded);
    const edge = input({ travelDobFromUsd: 1000, travelFullFromUsd: 0.01 });
    expect(parseCorridorInput(edge, now)).toEqual(edge);
    const full = input({
      purposeCodeMap: {
        family_support: 'P1301', gift: 'P1302', education: 'S1107', medical: 'S1108',
        savings: 'P0001', bills: 'B1', business: 'S0802', other: 'ZZ99ZZ99',
      },
    });
    expect(parseCorridorInput(full, now)).toEqual(full);
    expect(parseCorridorInput(input({ reattestDue: day(1) }), now)).toEqual(input({ reattestDue: day(1) }));
  });

  it('defaults now to the current time', () => {
    expect(parseCorridorInput(input())).toEqual(input());
  });

  it('refuses every bad field and never throws', () => {
    const year = now.getUTCFullYear() + 1;
    const nine = { ...Object.fromEntries(['family_support', 'gift', 'education', 'medical', 'savings', 'bills', 'business', 'other'].map((k) => [k, 'P1'])), extra: 'P2' };
    const bad: unknown[] = [
      { ...input(), status: 'paused' },
      { ...input(), rulePack: 'IN-MTSS-v2' },
      input({ destinationCountry: 'GB' }), // a pack on a GB row
      { ...input(), destinationCountry: 'ZZ' },
      { ...input(), destinationCountry: 'in' },
      { ...input(), purposeCodeMap: { rent: 'P1301' } },
      { ...input(), purposeCodeMap: { family_support: 'p13' } },
      { ...input(), purposeCodeMap: { family_support: 'P130100001' } },
      { ...input(), purposeCodeMap: { family_support: 'P' } },
      { ...input(), purposeCodeMap: nine },
      { ...input(), purposeCodeMap: null },
      { ...input(), purposeCodeMap: ['P1301'] },
      { ...input(), attestationRef: 'att 2026' },
      { ...input(), attestationRef: '' },
      { ...input(), attestationRef: 'a'.repeat(65) },
      { ...input(), attestationSha256: 'a'.repeat(63) },
      { ...input(), attestationSha256: 'A'.repeat(64) },
      { ...input(), recipientNotices: 'yes' },
      { ...input(), travelDobFromUsd: 0 },
      { ...input(), travelDobFromUsd: -1 },
      { ...input(), travelDobFromUsd: 1000.001 },
      { ...input(), travelDobFromUsd: 1001 },
      { ...input(), travelDobFromUsd: 1.005 },
      { ...input(), travelFullFromUsd: 3001 },
      { ...input(), travelFullFromUsd: Number.NaN },
      { ...input(), travelFullFromUsd: Number.POSITIVE_INFINITY },
      { ...input(), travelFullFromUsd: '1000' },
      { ...input(), reattestDue: day(0) },
      { ...input(), reattestDue: day(-1) },
      { ...input(), reattestDue: `${year}-13-01` },
      { ...input(), reattestDue: `${year}-02-30` },
      { ...input(), reattestDue: `${year}-1-01` },
      { ...input(), extra: 1 },
      (() => { const { recipientNotices: _r, ...rest } = input(); void _r; return rest; })(),
      null,
      undefined,
      'IN',
      [],
      [input()],
      42,
    ];
    for (const v of bad) {
      expect(() => parseCorridorInput(v, now)).not.toThrow();
      expect(parseCorridorInput(v, now), JSON.stringify(v) ?? String(v)).toEqual({ error: 'invalid' });
    }
  });

  it('refuses a map with an inherited key such as __proto__', () => {
    const v = JSON.parse('{"__proto__":"P1301"}');
    expect(parseCorridorInput({ ...input(), purposeCodeMap: v }, now)).toEqual({ error: 'invalid' });
  });
});

describe('corridor-register: corridorRowHash', () => {
  it('ignores recordedAt, the attestation and key order; starts pc1:', () => {
    const r = row();
    const h = corridorRowHash(r);
    expect(h).toMatch(/^pc1:[a-f0-9]{64}$/);
    expect(corridorRowHash({ ...r, recordedAt: new Date(0).toISOString() })).toBe(h);
    expect(corridorRowHash({ ...r, attestedBy: null, attestedAt: null, attestedHash: null })).toBe(h);
    expect(corridorRowHash({ ...r, attestedBy: 'x', attestedAt: 'y', attestedHash: 'pc1:z' })).toBe(h);
    const reversed = Object.fromEntries(Object.entries(r).reverse()) as unknown as CorridorRow;
    expect(corridorRowHash(reversed)).toBe(h);
    const map2 = row({ purposeCodeMap: { gift: 'P1302', family_support: 'P1301' } });
    const map3 = row({ purposeCodeMap: { family_support: 'P1301', gift: 'P1302' } });
    expect(corridorRowHash(map2)).toBe(corridorRowHash(map3));
  });

  it('hashes numbers by value (a db numeric mapped with Number())', () => {
    expect(corridorRowHash(row({ travelDobFromUsd: Number('1000.00') }))).toBe(corridorRowHash(row({ travelDobFromUsd: 1000 })));
  });

  it('changes with every recorded field', () => {
    const r = row();
    const h = corridorRowHash(r);
    const mutations: Partial<CorridorRow>[] = [
      { partnerId: 'pb' },
      { destinationCountry: 'GB' },
      { status: 'suspended' },
      { rulePack: null },
      { purposeCodeMap: { family_support: 'P1302' } },
      { attestationRef: 'att/2027.pdf' },
      { attestationSha256: 'b'.repeat(64) },
      { recipientNotices: false },
      { travelDobFromUsd: 500 },
      { travelFullFromUsd: 2000 },
      { reattestDue: day(181) },
      { recordedBy: 'admin2' },
    ];
    expect(mutations).toHaveLength(12);
    for (const m of mutations) {
      expect(corridorRowHash({ ...r, ...m }), JSON.stringify(m)).not.toBe(h);
    }
  });
});

describe('corridor-register: golden pc1 digest (early review FD1)', () => {
  // Literal values on purpose: the input of a hash is not a time window.
  // tests/partner-corridor-repo.test.ts saves the same row and pins the same digest.
  const GOLDEN: CorridorRow = {
    partnerId: 'pa',
    destinationCountry: 'IN',
    status: 'active',
    rulePack: 'IN-MTSS-v1',
    purposeCodeMap: { family_support: 'P1301', education: 'P1302' },
    attestationRef: 'att/2026.pdf',
    attestationSha256: 'a'.repeat(64),
    recipientNotices: true,
    travelDobFromUsd: 900.5,
    travelFullFromUsd: 2500,
    reattestDue: '2027-06-30',
    recordedBy: 'golden-admin',
    recordedAt: '2026-03-01T12:00:00.000Z',
    attestedBy: null,
    attestedAt: null,
    attestedHash: null,
  };
  // A change of this value means every stored attestation stops matching:
  // bump the version prefix (lm1 / pc1) and re-attest.
  const GOLDEN_PC1 = 'pc1:0454ebdd5fdeb9743e305e81b3a3b7ab6d17681bce5517c7ee915c47e8be2e95';

  it('pins the canonical form of a fixed row', () => {
    expect(corridorRowHash(GOLDEN)).toBe(GOLDEN_PC1);
  });
});

describe('corridor-register: corridorActive', () => {
  it('is true only for an active, attested, current row', () => {
    expect(corridorActive(row(), now)).toBe(true);
    expect(corridorActive(row({ status: 'suspended' }), now)).toBe(false);
    expect(corridorActive(row({ status: 'closed' }), now)).toBe(false);
    expect(corridorActive(row({ attestedHash: null }), now)).toBe(false);
    const stale = { ...row(), attestationRef: 'att/edited.pdf' }; // edited after the stamp
    expect(corridorActive(stale, now)).toBe(false);
    expect(corridorActive(row({ reattestDue: day(0) }), now)).toBe(false);
    expect(corridorActive(row({ reattestDue: day(1) }), now)).toBe(true);
    expect(corridorActive(null, now)).toBe(false);
    expect(corridorActive(undefined, now)).toBe(false);
  });
});

describe('corridor-register: reattestReminderDue', () => {
  it('fires from 14 days before the due date, on active rows only', () => {
    expect(reattestReminderDue(row({ reattestDue: day(15) }), now)).toBe(false);
    expect(reattestReminderDue(row({ reattestDue: day(14) }), now)).toBe(true);
    expect(reattestReminderDue(row({ reattestDue: day(-3) }), now)).toBe(true);
    expect(reattestReminderDue(row({ reattestDue: day(5), status: 'suspended' }), now)).toBe(false);
  });
});

describe('corridor-register: travelBandOf / purposeCodeFor', () => {
  it('travelBandOf returns the stored band or undefined', () => {
    expect(travelBandOf(null)).toBeUndefined();
    expect(travelBandOf(undefined)).toBeUndefined();
    expect(travelBandOf(row())).toEqual({ dobFromUsd: null, fullFromUsd: null });
    expect(travelBandOf(row({ travelDobFromUsd: 500, travelFullFromUsd: 2500.5 }))).toEqual({ dobFromUsd: 500, fullFromUsd: 2500.5 });
  });

  it('purposeCodeFor returns only a mapped code, never a suggestion', () => {
    expect(purposeCodeFor(null, 'family_support')).toBeNull();
    expect(purposeCodeFor(row(), null)).toBeNull();
    expect(purposeCodeFor(row(), undefined)).toBeNull();
    expect(purposeCodeFor(row(), 'family_support')).toBe('P1301');
    const unmapped = row({ purposeCodeMap: { gift: 'P1302' } });
    expect(SUGGESTED_RBI_CODE.family_support).toBe('P1301');
    expect(purposeCodeFor(unmapped, 'family_support')).toBeNull();
    expect(purposeCodeFor(row(), 'gift')).toBeNull();
    expect(purposeCodeFor(row(), '__proto__' as TransferPurpose)).toBeNull();
    expect(purposeCodeFor(row(), 'toString' as TransferPurpose)).toBeNull();
  });
});

describe('corridor-register: corridorDecision', () => {
  it('is certified-only and fails closed', () => {
    expect(corridorDecision({ certified: false, row: null, readFailed: true, now })).toBe('allowed');
    expect(corridorDecision({ certified: true, row: row(), readFailed: true, now })).toBe('corridor_closed');
    expect(corridorDecision({ certified: true, row: null, readFailed: false, now })).toBe('corridor_closed');
    expect(corridorDecision({ certified: true, row: row({ status: 'suspended' }), readFailed: false, now })).toBe('corridor_closed');
    expect(corridorDecision({ certified: true, row: row({ attestedHash: null }), readFailed: false, now })).toBe('corridor_closed');
    expect(corridorDecision({ certified: true, row: row(), readFailed: false, now })).toBe('allowed');
  });
});

describe('corridor-register: server only', () => {
  it("no 'use client' file imports corridor-register", () => {
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
      .filter((f) => /['"][^'"]*\/corridor-register['"]/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(process.cwd(), f));
    expect(files.length).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });
});
