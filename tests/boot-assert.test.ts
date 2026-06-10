import { describe, it, expect } from 'vitest';
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
