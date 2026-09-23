import { afterEach, describe, it, expect, vi } from 'vitest';
import { currentWriteKid, defaultProvider } from '@/lib/field-crypto';
import {
  shouldAssertProductionBoot,
  productionBootProblems,
  REQUIRED_PRODUCTION_VARS,
} from '@/lib/boot-assert';

const FULL_ENV: Record<string, string> = {
  DATABASE_URL: 'postgres://x',
  KV_REST_API_URL: 'https://kv.test',
  KV_REST_API_TOKEN: 't',
  FIELD_ENCRYPTION_KEY: '07'.repeat(32),
  PASSWORD_PEPPER: 'pepper',
  CRON_SECRET: 'cron',
  META_APP_SECRET: 'meta',
  OPS_ALERT_PHONE: '15555550100',
};

describe('shouldAssertProductionBoot — the context gate', () => {
  const PROD_RUNTIME = { VERCEL_ENV: 'production', NODE_ENV: 'production' };

  it('asserts ONLY in the Vercel production runtime', () => {
    expect(shouldAssertProductionBoot(PROD_RUNTIME)).toBe(true);
  });

  it('skips local dev even though `vercel env pull` wrote VERCEL_ENV=production into .env.local', () => {
    expect(
      shouldAssertProductionBoot({ VERCEL_ENV: 'production', NODE_ENV: 'development' }),
    ).toBe(false);
  });

  it('skips local/CI `next build` (NEXT_PHASE=phase-production-build)', () => {
    expect(
      shouldAssertProductionBoot({ ...PROD_RUNTIME, NEXT_PHASE: 'phase-production-build' }),
    ).toBe(false);
  });

  it('skips preview deployments and CI (no VERCEL_ENV=production)', () => {
    expect(shouldAssertProductionBoot({ VERCEL_ENV: 'preview', NODE_ENV: 'production' })).toBe(false);
    expect(shouldAssertProductionBoot({ NODE_ENV: 'production' })).toBe(false);
  });
});

describe('productionBootProblems — names only, never values', () => {
  it('a fully-configured env has zero problems', () => {
    expect(productionBootProblems(FULL_ENV)).toEqual([]);
  });

  it('flags EVERY missing or empty required var by name', () => {
    const problems = productionBootProblems({});
    expect(problems).toHaveLength(REQUIRED_PRODUCTION_VARS.length);
    for (const name of REQUIRED_PRODUCTION_VARS) {
      expect(problems.join(' ')).toContain(name);
    }
  });

  it('an EMPTY string is as fatal as a missing var (the `vercel env add` pipe gotcha)', () => {
    const problems = productionBootProblems({ ...FULL_ENV, CRON_SECRET: '' });
    expect(problems).toEqual(['CRON_SECRET is missing or empty']);
  });

  it('a whitespace-only value is fatal too', () => {
    expect(productionBootProblems({ ...FULL_ENV, META_APP_SECRET: '  ' })).toEqual([
      'META_APP_SECRET is missing or empty',
    ]);
  });

  it('accepts BOTH key shapes EnvKeyProvider accepts: 64-hex AND base64-32-bytes', () => {
    // hex (already in FULL_ENV) — and the base64 form `openssl rand -base64 32`
    // emits, which is what production actually carries. The first deploy of
    // this assert was hex-only and bricked prod middleware — regression-pinned.
    const b64 = Buffer.alloc(32, 7).toString('base64');
    expect(productionBootProblems({ ...FULL_ENV, FIELD_ENCRYPTION_KEY: b64 })).toEqual([]);
  });

  it('rejects a malformed FIELD_ENCRYPTION_KEY (wrong length, junk)', () => {
    expect(productionBootProblems({ ...FULL_ENV, FIELD_ENCRYPTION_KEY: 'abc123' }).join(' '))
      .toContain('FIELD_ENCRYPTION_KEY');
    expect(
      productionBootProblems({
        ...FULL_ENV,
        FIELD_ENCRYPTION_KEY: Buffer.alloc(16, 7).toString('base64'), // 16 bytes ≠ 32
      }).join(' '),
    ).toContain('FIELD_ENCRYPTION_KEY');
  });

  it('never echoes a value into a problem string', () => {
    const problems = productionBootProblems({ ...FULL_ENV, DATABASE_URL: '' });
    expect(problems.join(' ')).not.toContain('postgres://');
  });
});

// Program-Fix 45 P4 follow-up: FIELD_ENCRYPTION_CURRENT_KID is checked at boot
// ONLY when it is set (production leaves it unset, so its boot is unchanged).
// The check MUST mirror field-crypto's currentWriteKid exactly (the
// FIELD_ENCRYPTION_KEY incident: an assert stricter or looser than the code).
describe('productionBootProblems — FIELD_ENCRYPTION_CURRENT_KID (only when set)', () => {
  const k1 = Buffer.alloc(32, 9);
  const ring = `k1:${k1.toString('hex')},k2:${Buffer.alloc(32, 11).toString('base64')}`;

  it('unset, empty, whitespace or k0 → no problem (k0 is always FIELD_ENCRYPTION_KEY)', () => {
    for (const v of [undefined, '', '   ', 'k0', ' k0 ']) {
      expect(productionBootProblems({ ...FULL_ENV, FIELD_ENCRYPTION_CURRENT_KID: v })).toEqual([]);
    }
    // k0 is fine even when the optional ring env is malformed (the writer never reads it for k0).
    expect(productionBootProblems({ ...FULL_ENV, FIELD_ENCRYPTION_CURRENT_KID: 'k0', FIELD_ENCRYPTION_PREVIOUS_KEYS: 'junk' })).toEqual([]);
  });

  it('a kid the ring holds → no problem', () => {
    expect(productionBootProblems({ ...FULL_ENV, FIELD_ENCRYPTION_CURRENT_KID: 'k1', FIELD_ENCRYPTION_PREVIOUS_KEYS: ring })).toEqual([]);
    expect(productionBootProblems({ ...FULL_ENV, FIELD_ENCRYPTION_CURRENT_KID: 'k2', FIELD_ENCRYPTION_PREVIOUS_KEYS: ring })).toEqual([]);
  });

  it('malformed or unheld → one problem naming ONLY the env var, never a value', () => {
    const cases: Record<string, string | undefined>[] = [
      { FIELD_ENCRYPTION_CURRENT_KID: 'K1' },
      { FIELD_ENCRYPTION_CURRENT_KID: 'k01' },
      { FIELD_ENCRYPTION_CURRENT_KID: '__proto__' },
      { FIELD_ENCRYPTION_CURRENT_KID: 'k1' }, // no ring
      { FIELD_ENCRYPTION_CURRENT_KID: 'k3', FIELD_ENCRYPTION_PREVIOUS_KEYS: ring }, // not held
      { FIELD_ENCRYPTION_CURRENT_KID: 'k1', FIELD_ENCRYPTION_PREVIOUS_KEYS: `${ring},k1:${k1.toString('hex')}` }, // dup
      { FIELD_ENCRYPTION_CURRENT_KID: 'k1', FIELD_ENCRYPTION_PREVIOUS_KEYS: `k1:${k1.toString('hex').slice(0, 30)}` }, // short key
      { FIELD_ENCRYPTION_CURRENT_KID: 'k1', FIELD_ENCRYPTION_PREVIOUS_KEYS: `k0:${k1.toString('hex')},k1:${k1.toString('hex')}` }, // k0 entry
    ];
    for (const extra of cases) {
      const problems = productionBootProblems({ ...FULL_ENV, ...extra });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^FIELD_ENCRYPTION_CURRENT_KID /);
      expect(problems[0]).not.toContain(k1.toString('hex').slice(0, 16));
      if (extra.FIELD_ENCRYPTION_CURRENT_KID) expect(problems[0]).not.toContain(extra.FIELD_ENCRYPTION_CURRENT_KID);
    }
  });
});

describe('the boot check and currentWriteKid accept EXACTLY the same configs', () => {
  const k1hex = Buffer.alloc(32, 9).toString('hex');
  const k1b64 = Buffer.alloc(32, 9).toString('base64');
  const kids = [undefined, '', ' ', 'k0', ' k0', 'k1', 'k2', 'K1', 'k01', 'k1000', '__proto__', 'kx', 'k1|x'];
  const rings = [
    undefined, '', ' , ', 'junk', `k1:${k1hex}`, `k1:${k1b64}`, ` k1 : ${k1hex} `, `k2:${k1hex}`,
    `k1:${k1hex},k1:${k1hex}`, `k0:${k1hex}`, `k1:${k1hex.slice(0, 20)}`, `k1:`, `:${k1hex}`, `kx:${k1hex}`,
    `k1:${k1hex},k2:${k1b64}`,
  ];

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(kids.flatMap((kid) => rings.map((r) => [kid, r] as const)))('kid %j, ring %j', (kid, r) => {
    vi.stubEnv('FIELD_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('hex'));
    if (kid !== undefined) vi.stubEnv('FIELD_ENCRYPTION_CURRENT_KID', kid);
    if (r !== undefined) vi.stubEnv('FIELD_ENCRYPTION_PREVIOUS_KEYS', r);
    let codeAccepts = true;
    try {
      currentWriteKid(defaultProvider());
    } catch {
      codeAccepts = false;
    }
    const assertAccepts = productionBootProblems({
      ...FULL_ENV,
      FIELD_ENCRYPTION_CURRENT_KID: kid,
      FIELD_ENCRYPTION_PREVIOUS_KEYS: r,
    }).length === 0;
    expect(assertAccepts).toBe(codeAccepts);
  });
});
