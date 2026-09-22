import { describe, it, expect } from 'vitest';
import { bearerMatches } from '@/lib/cron-auth';

// cron-auth — the Bearer CRON_SECRET gate shared by /api/worker and /api/cron
// (Program-Fix 12 review follow-up). The compare is constant-time over
// fixed-length SHA-256 digests, so neither the secret's length nor the position
// of the first mismatching byte leaks through timing. Fail-closed: anything
// but an exact `Bearer <secret>` is refused.

describe('bearerMatches', () => {
  const secret = 'a-very-secret-cron-token';

  it('accepts exactly `Bearer <secret>`', () => {
    expect(bearerMatches(`Bearer ${secret}`, secret)).toBe(true);
  });

  it('refuses a missing header, an empty header and a bare secret', () => {
    expect(bearerMatches(null, secret)).toBe(false);
    expect(bearerMatches('', secret)).toBe(false);
    expect(bearerMatches(secret, secret)).toBe(false);
  });

  it('refuses a near miss of the same length, a prefix, a suffix and a case change', () => {
    expect(bearerMatches(`Bearer ${secret.slice(0, -1)}X`, secret)).toBe(false);
    expect(bearerMatches(`Bearer ${secret.slice(0, -1)}`, secret)).toBe(false);
    expect(bearerMatches(`Bearer ${secret}x`, secret)).toBe(false);
    expect(bearerMatches(`bearer ${secret}`, secret)).toBe(false);
    expect(bearerMatches(`Bearer  ${secret}`, secret)).toBe(false);
  });

  it('refuses everything when the secret is empty (the route gates on env.cronSecret first, this is belt and braces)', () => {
    expect(bearerMatches('Bearer ', '')).toBe(false);
    expect(bearerMatches(null, '')).toBe(false);
  });
});
