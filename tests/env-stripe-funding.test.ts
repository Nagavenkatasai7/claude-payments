/**
 * Program-Fix 7 — the funding flags are OPTIONAL and default OFF; the
 * test-mode escape hatch is IGNORED in any production build (review M4), so
 * a stray env var can never let a Stripe test-mode success pay out on a live
 * rail. Neither is boot-required.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { env } from '@/lib/env';
import { REQUIRED_PRODUCTION_VARS } from '@/lib/boot-assert';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Stripe funding flags', () => {
  it('both default OFF', () => {
    vi.stubEnv('STRIPE_FUNDING_ENABLED', '');
    vi.stubEnv('STRIPE_FUNDING_ALLOW_TEST_MODE', '');
    expect(env.stripeFundingEnabled).toBe(false);
    expect(env.stripeFundingAllowTestMode).toBe(false);
  });

  it('only the exact string "true" turns them on (outside production)', () => {
    vi.stubEnv('STRIPE_FUNDING_ENABLED', '1');
    expect(env.stripeFundingEnabled).toBe(false);
    vi.stubEnv('STRIPE_FUNDING_ENABLED', 'true');
    vi.stubEnv('STRIPE_FUNDING_ALLOW_TEST_MODE', 'true');
    expect(env.stripeFundingEnabled).toBe(true);
    expect(env.stripeFundingAllowTestMode).toBe(true);
  });

  it('test mode is IGNORED in a production build', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('STRIPE_FUNDING_ALLOW_TEST_MODE', 'true');
    expect(env.stripeFundingAllowTestMode).toBe(false);
  });

  it('neither is boot-required', () => {
    expect(REQUIRED_PRODUCTION_VARS).not.toContain('STRIPE_FUNDING_ENABLED');
    expect(REQUIRED_PRODUCTION_VARS).not.toContain('STRIPE_FUNDING_ALLOW_TEST_MODE');
  });
});
