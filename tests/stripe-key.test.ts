/**
 * Fix pack 5 T16 (P16): SmartRemit only ever charges through a partner's
 * Stripe account with a RESTRICTED key (rk_live_ / rk_test_,
 * https://docs.stripe.com/keys). Keys are built by join so no literal key
 * sits in the source.
 */
import { describe, it, expect } from 'vitest';
import { isRestrictedStripeKey, RESTRICTED_STRIPE_KEY } from '@/lib/providers/funding-provider';

const k = (...parts: string[]) => parts.join('_');

describe('isRestrictedStripeKey', () => {
  it('accepts a live or test restricted key', () => {
    expect(isRestrictedStripeKey(k('rk', 'live', 'abc'))).toBe(true);
    expect(isRestrictedStripeKey(k('rk', 'test', 'abc'))).toBe(true);
    expect(isRestrictedStripeKey(k('rk', 'test', 'A1b2C3'))).toBe(true);
    expect(RESTRICTED_STRIPE_KEY.test(k('rk', 'live', 'abc'))).toBe(true);
  });

  it('refuses secret, organization and publishable keys, malformed restricted keys and non-strings', () => {
    const bad: unknown[] = [
      k('sk', 'test', 'x'), k('sk', 'live', 'x'), k('sk', 'org', 'x'), k('pk', 'test', 'x'),
      k('rk', 'x'), k('rk', 'test', ''), k('rk', 'test', 'a b'), ' ' + k('rk', 'test', 'abc'),
      k('rk', 'test', 'abc') + '\n', '', null, undefined, 42, { key: k('rk', 'test', 'abc') },
    ];
    for (const v of bad) expect(isRestrictedStripeKey(v)).toBe(false);
  });
});
