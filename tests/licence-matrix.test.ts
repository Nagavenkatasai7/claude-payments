import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  US_STATE_CODES,
  isUsStateCode,
  RESIDENCE_SOURCES,
  isResidenceSource,
  LICENCE_MATRIX_VERSION,
  LICENCE_MAX_STATES,
  LICENCE_MAX_ORIGINS,
  parseLicenceMatrix,
  utcToday,
  isActiveOn,
  licenceMatrixHash,
  matrixAttested,
  licenceMatrixReady,
  effectiveResidence,
  licenceDecision,
  type LicenceMatrix,
  type UsStateCode,
} from '@/lib/licence-matrix';
import type { CountryCode } from '@/lib/types';

// Fix pack 8 T4 (P17, D7, D9; critics R8, C1, R16/C12): the licence matrix module.
// Dates are relative to now (P0 rule 8).

const NOW_ISO = new Date().toISOString();
const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

function m(o: Partial<LicenceMatrix> = {}): LicenceMatrix {
  return {
    version: 1,
    states: [
      { code: 'NY', licenceRef: 'NY-MT-1', effectiveFrom: day(-1), expiresAt: day(365) },
      { code: 'NJ', licenceRef: 'NJ-MT-2', effectiveFrom: day(-1), expiresAt: day(365) },
    ],
    origins: [{ country: 'US', effectiveFrom: day(-1) }],
    evidenceRef: 'ev-1',
    recordedBy: 'admin',
    recordedAt: NOW_ISO,
    ...o,
  };
}

function attested(x: LicenceMatrix): LicenceMatrix {
  return { ...x, attestation: { by: 'partner-admin', at: new Date().toISOString(), hash: licenceMatrixHash(x) } };
}

function reverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).reverse()) out[k] = reverseKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

describe('licence-matrix: codes and sources', () => {
  it('US_STATE_CODES has 56 unique sorted codes incl. DC and the five territories', () => {
    expect(US_STATE_CODES).toHaveLength(56);
    expect(new Set(US_STATE_CODES).size).toBe(56);
    expect([...US_STATE_CODES]).toEqual([...US_STATE_CODES].sort());
    for (const c of ['DC', 'PR', 'GU', 'VI', 'AS', 'MP', 'NY', 'CA', 'WY']) expect(US_STATE_CODES).toContain(c);
    expect(Object.isFrozen(US_STATE_CODES)).toBe(true);
    expect(isUsStateCode('NY')).toBe(true);
    expect(isUsStateCode('ny')).toBe(false);
    expect(isUsStateCode('XX')).toBe(false);
    expect(isUsStateCode('__proto__')).toBe(false);
    expect(isUsStateCode('toString')).toBe(false);
    expect(isUsStateCode(undefined)).toBe(false);
    expect(isUsStateCode(1)).toBe(false);
  });

  it('RESIDENCE_SOURCES is the closed frozen tuple; kyc_vendor is accepted by the type guard', () => {
    expect([...RESIDENCE_SOURCES]).toEqual(['kyc_vendor', 'partner_attested', 'staff_verified']);
    expect(Object.isFrozen(RESIDENCE_SOURCES)).toBe(true);
    expect(isResidenceSource('kyc_vendor')).toBe(true);
    expect(isResidenceSource('staff_verified')).toBe(true);
    expect(isResidenceSource('chat')).toBe(false);
    expect(isResidenceSource('__proto__')).toBe(false);
    expect(isResidenceSource(null)).toBe(false);
  });

  it('pins the version and the bounds', () => {
    expect(LICENCE_MATRIX_VERSION).toBe('lm1');
    expect(LICENCE_MAX_STATES).toBe(60);
    expect(LICENCE_MAX_ORIGINS).toBe(20);
    expect(utcToday(new Date('2030-01-02T23:59:59.000Z'))).toBe('2030-01-02');
  });
});

describe('licence-matrix: parseLicenceMatrix', () => {
  it('accepts a valid matrix and returns it unchanged (toEqual)', () => {
    const v = m();
    expect(parseLicenceMatrix(v)).toEqual(v);
    const a = attested(m({ origins: [{ country: 'US', effectiveFrom: day(-3), expiresAt: day(30) }] }));
    expect(parseLicenceMatrix(a)).toEqual(a);
    expect(parseLicenceMatrix(m({ states: [], origins: [] }))).toEqual(m({ states: [], origins: [] }));
  });

  it('refuses every malformed shape', () => {
    const y = new Date().getUTCFullYear();
    const st = (o: Record<string, unknown>) => ({ code: 'NY', licenceRef: 'r1', effectiveFrom: day(-1), expiresAt: day(10), ...o });
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ code: US_STATE_CODES[i % 56], licenceRef: `r${i}`, effectiveFrom: day(-1), expiresAt: day(10) }));
    const cases: Array<[string, unknown]> = [
      ['version 2', { ...m(), version: 2 }],
      ['lowercase state', m({ states: [st({ code: 'ny' })] as never })],
      ['unknown state', m({ states: [st({ code: 'XX' })] as never })],
      ['duplicate state', m({ states: [st({}), st({ licenceRef: 'r2' })] as never })],
      ['duplicate origin', m({ origins: [{ country: 'US', effectiveFrom: day(-1) }, { country: 'US', effectiveFrom: day(-2) }] })],
      ['unsupported origin', m({ origins: [{ country: 'ZZ' as CountryCode, effectiveFrom: day(-1) }] })],
      ['lowercase origin', m({ origins: [{ country: 'us' as CountryCode, effectiveFrom: day(-1) }] })],
      ['61 states', m({ states: many(61) as never })],
      [
        '21 origins',
        m({ origins: Array.from({ length: 21 }, () => ({ country: 'US' as CountryCode, effectiveFrom: day(-1) })) }),
      ],
      ['licenceRef with a space', m({ states: [st({ licenceRef: 'a b' })] as never })],
      ['licenceRef 65 chars', m({ states: [st({ licenceRef: 'a'.repeat(65) })] as never })],
      ['empty licenceRef', m({ states: [st({ licenceRef: '' })] as never })],
      ['evidenceRef with <', m({ evidenceRef: 'ev<1' })],
      ['state from == to', m({ states: [st({ effectiveFrom: day(5), expiresAt: day(5) })] as never })],
      ['state from > to', m({ states: [st({ effectiveFrom: day(6), expiresAt: day(5) })] as never })],
      ['origin from >= to', m({ origins: [{ country: 'US', effectiveFrom: day(5), expiresAt: day(5) }] })],
      ['impossible date', m({ states: [st({ effectiveFrom: `${y}-02-30` })] as never })],
      ['impossible month', m({ states: [st({ expiresAt: `${y + 1}-13-01` })] as never })],
      ['date with time', m({ states: [st({ effectiveFrom: `${day(-1)}T00:00:00Z` })] as never })],
      ['missing state expiresAt', m({ states: [{ code: 'NY', licenceRef: 'r', effectiveFrom: day(-1) }] as never })],
      ['unknown top-level key', { ...m(), extra: 1 }],
      ['unknown key inside a state', m({ states: [st({ note: 'x' })] as never })],
      ['unknown key inside an origin', m({ origins: [{ country: 'US', effectiveFrom: day(-1), x: 1 }] as never })],
      ['bad attestation prefix', { ...m(), attestation: { by: 'p', at: new Date().toISOString(), hash: `dh1:${'a'.repeat(64)}` } }],
      ['bad attestation hex', { ...m(), attestation: { by: 'p', at: new Date().toISOString(), hash: `lm1:${'A'.repeat(64)}` } }],
      ['unknown key inside the attestation', { ...attested(m()), attestation: { ...attested(m()).attestation!, x: 1 } }],
      ['bad recordedAt', m({ recordedAt: 'not a time' })],
      ['empty recordedBy', m({ recordedBy: '' })],
      ['recordedBy 201 chars', m({ recordedBy: 'a'.repeat(201) })],
    ];
    for (const [name, v] of cases) expect(parseLicenceMatrix(v), name).toBeUndefined();
    // the bound itself is allowed
    expect(parseLicenceMatrix(m({ states: many(56) as never }))).toBeDefined();
  });

  it('never throws', () => {
    const cyclic: Record<string, unknown> = { version: 1 };
    cyclic.self = cyclic;
    for (const v of [null, undefined, 'x', 42, [], [m()], cyclic, { states: 'x' }, Object.create(null)]) {
      expect(() => parseLicenceMatrix(v)).not.toThrow();
      expect(parseLicenceMatrix(v)).toBeUndefined();
    }
  });
});

describe('licence-matrix: isActiveOn', () => {
  it('edges', () => {
    const today = day(0);
    expect(isActiveOn({ effectiveFrom: today, expiresAt: day(1) }, today)).toBe(true);
    expect(isActiveOn({ effectiveFrom: day(-5), expiresAt: today }, today)).toBe(false);
    expect(isActiveOn({ effectiveFrom: day(-5), expiresAt: day(1) }, today)).toBe(true);
    expect(isActiveOn({ effectiveFrom: day(1), expiresAt: day(5) }, today)).toBe(false);
    expect(isActiveOn({ effectiveFrom: today }, today)).toBe(true);
    expect(isActiveOn({ effectiveFrom: day(-400) }, today)).toBe(true);
    expect(isActiveOn({ effectiveFrom: day(1) }, today)).toBe(false);
  });
});

describe('licence-matrix: licenceMatrixHash and matrixAttested', () => {
  it('ignores the attestation and key order', () => {
    const base = m();
    const h = licenceMatrixHash(base);
    expect(h).toMatch(/^lm1:[a-f0-9]{64}$/);
    expect(licenceMatrixHash(attested(base))).toBe(h);
    expect(licenceMatrixHash(reverseKeys(base) as LicenceMatrix)).toBe(h);
  });

  it('changes with any recorded field', () => {
    const base = m();
    const h = licenceMatrixHash(base);
    const s0 = base.states[0];
    const variants: LicenceMatrix[] = [
      m({ states: [{ ...s0, code: 'CA' as UsStateCode }, base.states[1]] }),
      m({ states: [{ ...s0, licenceRef: 'NY-MT-9' }, base.states[1]] }),
      m({ states: [{ ...s0, effectiveFrom: day(-2) }, base.states[1]] }),
      m({ states: [{ ...s0, expiresAt: day(366) }, base.states[1]] }),
      m({ origins: [{ country: 'GB', effectiveFrom: day(-1) }] }),
      m({ origins: [{ country: 'US', effectiveFrom: day(-1), expiresAt: day(100) }] }),
      m({ evidenceRef: 'ev-2' }),
      m({ recordedBy: 'admin2' }),
      m({ recordedAt: new Date(Date.now() - 60_000).toISOString() }),
      m({ states: [...base.states, { code: 'TX', licenceRef: 'TX-1', effectiveFrom: day(-1), expiresAt: day(30) }] }),
      m({ states: [base.states[1], base.states[0]] }),
    ];
    expect(m().recordedAt).toBe(base.recordedAt);
    for (const v of variants) expect(licenceMatrixHash(v)).not.toBe(h);
    expect(new Set(variants.map(licenceMatrixHash)).size).toBe(variants.length);
  });

  it('matrixAttested', () => {
    const base = m();
    expect(matrixAttested(base)).toBe(false);
    expect(matrixAttested(attested(base))).toBe(true);
    const stamped = attested(base);
    const edited: LicenceMatrix = { ...stamped, evidenceRef: 'ev-2' };
    expect(matrixAttested(edited)).toBe(false);
    expect(matrixAttested(undefined)).toBe(false);
    expect(matrixAttested(null)).toBe(false);
  });
});

describe('licence-matrix: licenceMatrixReady', () => {
  const now = new Date();
  it('needs the attestation, an active origin and, for a US origin, an active state', () => {
    expect(licenceMatrixReady(attested(m()), now)).toBe(true);
    const expiredStates = m({
      states: [{ code: 'NY', licenceRef: 'r', effectiveFrom: day(-30), expiresAt: day(-1) }],
    });
    expect(licenceMatrixReady(attested(expiredStates), now)).toBe(false);
    expect(licenceMatrixReady(attested(m({ origins: [] })), now)).toBe(false);
    expect(licenceMatrixReady(attested(m({ origins: [{ country: 'US', effectiveFrom: day(5) }] })), now)).toBe(false);
    expect(
      licenceMatrixReady(attested(m({ origins: [{ country: 'US', effectiveFrom: day(-30), expiresAt: day(-1) }] })), now),
    ).toBe(false);
    expect(licenceMatrixReady(attested(m({ states: [], origins: [{ country: 'GB', effectiveFrom: day(-1) }] })), now)).toBe(
      true,
    );
    expect(licenceMatrixReady(m(), now)).toBe(false);
    expect(licenceMatrixReady(undefined, now)).toBe(false);
    expect(licenceMatrixReady(null, now)).toBe(false);
  });
});

describe('licence-matrix: effectiveResidence', () => {
  it('a stored staff_verified state wins; else requested ?? stored ?? null', () => {
    expect(effectiveResidence({ state: 'CA', source: 'staff_verified' }, { state: 'NY', source: 'partner_attested' })).toEqual({
      state: 'CA',
      source: 'staff_verified',
    });
    expect(effectiveResidence({ state: 'NJ', source: 'partner_attested' }, { state: 'NY', source: 'partner_attested' })).toEqual({
      state: 'NY',
      source: 'partner_attested',
    });
    expect(effectiveResidence(null, { state: 'NY', source: 'partner_attested' })).toEqual({ state: 'NY', source: 'partner_attested' });
    expect(effectiveResidence(undefined, { state: 'NY', source: 'partner_attested' })).toEqual({
      state: 'NY',
      source: 'partner_attested',
    });
    expect(effectiveResidence({ state: 'TX', source: 'kyc_vendor' }, null)).toEqual({ state: 'TX', source: 'kyc_vendor' });
    expect(effectiveResidence({ state: 'TX', source: 'kyc_vendor' }, undefined)).toEqual({ state: 'TX', source: 'kyc_vendor' });
    expect(effectiveResidence(null, null)).toBeNull();
    expect(effectiveResidence(undefined, undefined)).toBeNull();
  });
});

describe('licence-matrix: licenceDecision', () => {
  const now = new Date();
  const res = (state: string, source = 'partner_attested') => ({ state, source });

  it('uncertified -> allowed without looking at anything else', () => {
    let touched = 0;
    const trap = new Proxy(
      {},
      {
        get() {
          touched += 1;
          return undefined;
        },
      },
    ) as LicenceMatrix;
    expect(licenceDecision({ certified: false, matrix: null, readFailed: true, sourceCountry: 'US', residence: null, now })).toBe(
      'allowed',
    );
    expect(licenceDecision({ certified: false, matrix: trap, readFailed: false, sourceCountry: 'GB', residence: trap as never, now })).toBe(
      'allowed',
    );
    expect(touched).toBe(0);
  });

  it('certified: readFailed / no matrix / unattested -> unavailable', () => {
    const base = { certified: true, sourceCountry: 'US' as CountryCode, residence: res('NY'), now };
    expect(licenceDecision({ ...base, matrix: attested(m()), readFailed: true })).toBe('unavailable');
    expect(licenceDecision({ ...base, matrix: null, readFailed: false })).toBe('unavailable');
    expect(licenceDecision({ ...base, matrix: undefined, readFailed: false })).toBe('unavailable');
    expect(licenceDecision({ ...base, matrix: m(), readFailed: false })).toBe('unavailable');
    const stale = { ...attested(m()), evidenceRef: 'ev-9' };
    expect(licenceDecision({ ...base, matrix: stale, readFailed: false })).toBe('unavailable');
  });

  it('certified: source country not an active origin -> not_licensed', () => {
    expect(
      licenceDecision({ certified: true, matrix: attested(m()), readFailed: false, sourceCountry: 'GB', residence: null, now }),
    ).toBe('not_licensed');
    const expiredOrigin = attested(m({ origins: [{ country: 'US', effectiveFrom: day(-30), expiresAt: day(-1) }] }));
    expect(
      licenceDecision({ certified: true, matrix: expiredOrigin, readFailed: false, sourceCountry: 'US', residence: res('NY'), now }),
    ).toBe('not_licensed');
  });

  it('certified US: no residence / unknown source / garbage state -> state_unverified; kyc_vendor accepted', () => {
    const base = { certified: true, matrix: attested(m()), readFailed: false, sourceCountry: 'US' as CountryCode, now };
    expect(licenceDecision({ ...base, residence: null })).toBe('state_unverified');
    expect(licenceDecision({ ...base, residence: undefined })).toBe('state_unverified');
    expect(licenceDecision({ ...base, residence: res('NY', 'chat') })).toBe('state_unverified');
    expect(licenceDecision({ ...base, residence: res('ny') })).toBe('state_unverified');
    expect(licenceDecision({ ...base, residence: res('__proto__') })).toBe('state_unverified');
    expect(licenceDecision({ ...base, residence: res('NY', 'kyc_vendor') })).toBe('allowed');
  });

  it('certified US: state not in the matrix or its licence expired -> not_licensed; active state -> allowed', () => {
    const matrix = attested(
      m({
        states: [
          { code: 'NY', licenceRef: 'r1', effectiveFrom: day(-1), expiresAt: day(30) },
          { code: 'NJ', licenceRef: 'r2', effectiveFrom: day(-30), expiresAt: day(0) },
          { code: 'TX', licenceRef: 'r3', effectiveFrom: day(1), expiresAt: day(30) },
        ],
      }),
    );
    const base = { certified: true, matrix, readFailed: false, sourceCountry: 'US' as CountryCode, now };
    expect(licenceDecision({ ...base, residence: res('CA') })).toBe('not_licensed');
    expect(licenceDecision({ ...base, residence: res('NJ') })).toBe('not_licensed');
    expect(licenceDecision({ ...base, residence: res('TX') })).toBe('not_licensed');
    expect(licenceDecision({ ...base, residence: res('NY', 'staff_verified') })).toBe('allowed');
  });

  it('certified non-US origin (active) needs no state -> allowed', () => {
    const matrix = attested(m({ origins: [{ country: 'US', effectiveFrom: day(-1) }, { country: 'GB', effectiveFrom: day(-1) }] }));
    expect(licenceDecision({ certified: true, matrix, readFailed: false, sourceCountry: 'GB', residence: null, now })).toBe('allowed');
  });
});

describe('licence-matrix: server only', () => {
  it("no 'use client' file imports licence-matrix", () => {
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
      .filter((f) => /['"][^'"]*\/licence-matrix['"]/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(process.cwd(), f));
    expect(files.length).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });
});
