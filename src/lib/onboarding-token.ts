import { Redis } from '@upstash/redis';
import { createHash, randomBytes } from 'node:crypto';
import { env } from './env';
import type { RedisLike } from './store';
import { normalizePhone } from './phone';

/**
 * onboarding-token — a Redis-backed, single-use, phone-bound link token.
 *
 * Use case: the WhatsApp bot (Phase 3) hands the customer a deep link to the
 * account portal with `?token=...`. The token AUTHORIZES one specific phone for
 * the register step so the customer can't register a number they don't control
 * via the link. (Direct register without a token still goes through the WhatsApp
 * OTP, which is the real possession proof — the token is a convenience binding,
 * not the security boundary.)
 *
 * Mirrors the reset-token pattern in customer-auth-store:
 *  - 256-bit token from a CSPRNG (randomBytes(32).hex).
 *  - Only a sha256 HASH of the token is the Redis KEY, so a DB dump leaks nothing
 *    usable (the value is the normalized phone, which the key can't be reversed to).
 *  - 30-min TTL.
 *  - verifyOnboardingToken is READ-ONLY (does NOT consume) so the register page
 *    can prefill/authorize the phone; consumeOnboardingToken burns it single-use,
 *    called by the register server action once the account is created.
 */

const TTL_SECONDS = 30 * 60; // 30-min single-use link

const onboardKey = (tokenHash: string) => `onboard:${tokenHash}`;

function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function createOnboardingTokenStore(redis: RedisLike) {
  return {
    /** Issue a 256-bit link token bound to the (normalized) phone, TTL 30 min. */
    async createOnboardingToken(phoneRaw: string): Promise<string> {
      const phone = normalizePhone(phoneRaw);
      const token = randomBytes(32).toString('hex');
      await redis.set(onboardKey(sha256hex(token)), phone, { ex: TTL_SECONDS });
      return token;
    },

    /**
     * Resolve a token to its bound phone WITHOUT consuming it (read-only). The
     * register step consumes it via consumeOnboardingToken. Returns null for an
     * unknown / forged / expired token.
     */
    async verifyOnboardingToken(token: string): Promise<string | null> {
      return redis.get(onboardKey(sha256hex(token)));
    },

    /**
     * Consume a token: return its bound phone (or null) AND delete it so it can
     * never be replayed (single-use). Called by registerAction once the account
     * is created so a leaked link can't be reused.
     */
    async consumeOnboardingToken(token: string): Promise<string | null> {
      return redis.getdel(onboardKey(sha256hex(token)));
    },
  };
}

export type OnboardingTokenStore = ReturnType<typeof createOnboardingTokenStore>;

let cached: OnboardingTokenStore | null = null;

export function getOnboardingTokenStore(): OnboardingTokenStore {
  if (!cached) {
    const redis = new Redis({
      url: env.kvUrl,
      token: env.kvToken,
      automaticDeserialization: false,
    });
    cached = createOnboardingTokenStore(redis as unknown as RedisLike);
  }
  return cached;
}
