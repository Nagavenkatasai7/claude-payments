import { createHash } from 'node:crypto';
import { getRedis } from './redis';
import { getStore } from './store';
import { getCustomerStore } from './customer-store';
import { customerRowCtx } from './crypto-context';
import { decryptField, defaultProvider, encryptField, type EncryptionKeyProvider } from './field-crypto';
import { base32Decode, base32Encode, generateTotpSecret, totpOtpauthUri, verifyTotp, TOTP_STEP_SECONDS } from './totp';
import { env } from './env';
import { logWarn } from './log';
import type { RedisLike } from './store';
import type { CustomerRepo } from '@/db/repos/customer-repo';
import { getDb } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { auditSubjectId } from './customer-ref';
import type { Customer, PartnerId } from './types';

/**
 * customer-mfa — Program-Fix 49D (portal-03). Opt-in TOTP for the customer
 * portal, reusing 17b's RFC 6238 core (totp.ts) and mirroring the staff store
 * (staff-mfa-store.ts) with one difference: the enrolled secret lives in
 * Postgres (customers.mfa_totp_enc, migration 0020), not Redis. Redis is
 * hot/ephemeral here, and an evicted key would silently turn the second
 * factor off (brief §6 B4). Only short-lived state stays in Redis:
 *
 *   sr_mfa_enroll:<h>        sealed secret awaiting its first code (10 min)
 *   sr_mfa_enroll_n:<h>      confirm attempts for that enrolment (10 min)
 *   sr_totp_last:<h>         last accepted step (replay guard, 1 day)
 *   sr_totp_used:<h>:<step>  atomic per-step NX marker (replay guard, 2 min)
 *
 * <h> = sha256("<partnerId>|<phone>"): the tenant row, never the raw number.
 * The secret is sealed with field-crypto under customerRowCtx(row,
 * 'mfa_totp_enc') — v1 today, v2 once 46B flips writes; a successful verify
 * re-seals it when a fresh seal would be a different version. The sign-in's
 * pending token is pending-auth-store purpose 'mfa' (bound to passwordTag).
 */

export const CUSTOMER_MFA_ISSUER = 'SmartRemit';
export const CUSTOMER_MFA_ENROLL_TTL_S = 10 * 60;
export const CUSTOMER_MFA_ENROLL_MAX_CODES = 5;
const LAST_STEP_TTL_S = 24 * 60 * 60;
/** Covers the ±1 window (a code is acceptable for at most 90 s) with margin. */
const USED_STEP_TTL_S = 4 * TOTP_STEP_SECONDS;
const PASSWORD_TAG_HEX = 32;

export interface CustomerKey {
  partnerId: PartnerId;
  phone: string;
}

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
const rowHash = (k: CustomerKey) => sha256hex(`${k.partnerId}|${k.phone}`);

export const customerMfaKeys = {
  enroll: (k: CustomerKey) => `sr_mfa_enroll:${rowHash(k)}`,
  enrollCount: (k: CustomerKey) => `sr_mfa_enroll_n:${rowHash(k)}`,
  last: (k: CustomerKey) => `sr_totp_last:${rowHash(k)}`,
  used: (k: CustomerKey, step: number) => `sr_totp_used:${rowHash(k)}:${step}`,
};

/** The customer-repo methods this store needs (one mock point for tests). */
export type CustomerMfaRepo = Pick<CustomerRepo, 'isMfaEnrolled' | 'readMfa' | 'enableMfa' | 'clearMfa' | 'resealMfa'>;

export type BeginEnrolmentResult = { ok: true; secretBase32: string; uri: string } | { ok: false; reason: 'enrolled' };
export type ConfirmEnrolmentResult = 'ok' | 'invalid' | 'expired' | 'throttled' | 'enrolled';

export interface CustomerMfaStoreOptions {
  now?: () => number;
  provider?: () => EncryptionKeyProvider;
}

/** The authenticator-app label: the portal plus the last 4 digits, never the full number. */
function accountLabel(phone: string): string {
  return `portal …${phone.replace(/\D/g, '').slice(-4)}`;
}

export function createCustomerMfaStore(redis: RedisLike, repo: CustomerMfaRepo, opts: CustomerMfaStoreOptions = {}) {
  const now = opts.now ?? (() => Date.now());
  const provider = opts.provider ?? defaultProvider;
  const ctxFor = (k: CustomerKey) => customerRowCtx({ partnerId: k.partnerId, phone: k.phone }, 'mfa_totp_enc');

  /**
   * Check `code` against `secret`, then claim its step atomically: the step
   * must be above the last accepted one AND its NX marker must be new. Either
   * failing is a replay (a sign-in code cannot be reused for a step-up, or the
   * reverse, inside its 90-second life).
   */
  async function acceptCode(k: CustomerKey, secret: Buffer, code: string): Promise<boolean> {
    const lastRaw = await redis.get(customerMfaKeys.last(k));
    const lastStep = lastRaw !== null && /^\d+$/.test(lastRaw) ? Number(lastRaw) : null;
    const step = verifyTotp(secret, code, now(), { lastStep });
    if (step === null) return false;
    const claimed = await redis.set(customerMfaKeys.used(k, step), '1', { nx: true, ex: USED_STEP_TTL_S });
    if (claimed === null) return false;
    await redis.set(customerMfaKeys.last(k), String(step), { ex: LAST_STEP_TTL_S });
    return true;
  }

  return {
    /**
     * ON = a secret is stored, even one that no longer opens: a corrupt record
     * fails CLOSED (every code is refused) instead of turning the factor off.
     * Only a reset clears it.
     */
    async isEnrolled(k: CustomerKey): Promise<boolean> {
      return repo.isMfaEnrolled(k.partnerId, k.phone);
    },

    /**
     * Generate a fresh secret and hold it (sealed) for 10 minutes until the
     * first code confirms it. The plaintext is returned to the caller ONCE
     * (the action state), never persisted unsealed. Refused while enrolled.
     */
    async beginEnrolment(k: CustomerKey): Promise<BeginEnrolmentResult> {
      if (await this.isEnrolled(k)) return { ok: false, reason: 'enrolled' };
      const secretBase32 = base32Encode(generateTotpSecret());
      await redis.set(customerMfaKeys.enroll(k), encryptField(secretBase32, provider(), ctxFor(k)), {
        ex: CUSTOMER_MFA_ENROLL_TTL_S,
      });
      await redis.del(customerMfaKeys.enrollCount(k));
      return {
        ok: true,
        secretBase32,
        uri: totpOtpauthUri({ issuer: CUSTOMER_MFA_ISSUER, account: accountLabel(k.phone), secretBase32 }),
      };
    },

    /** Confirm the pending enrolment with one code (at most 5 tries per enrolment). */
    async confirmEnrolment(k: CustomerKey, code: string): Promise<ConfirmEnrolmentResult> {
      if (await this.isEnrolled(k)) return 'enrolled';
      const sealed = await redis.get(customerMfaKeys.enroll(k));
      if (!sealed) return 'expired';
      const n = await redis.incr(customerMfaKeys.enrollCount(k));
      if (n === 1) await redis.expire(customerMfaKeys.enrollCount(k), CUSTOMER_MFA_ENROLL_TTL_S);
      if (n > CUSTOMER_MFA_ENROLL_MAX_CODES) {
        await redis.del(customerMfaKeys.enroll(k));
        await redis.del(customerMfaKeys.enrollCount(k));
        return 'throttled';
      }
      const b32 = decryptField(sealed, provider(), ctxFor(k));
      if (!(await acceptCode(k, base32Decode(b32), code))) return 'invalid';
      // Take the pending secret atomically: a restarted setup that landed since
      // the read above wins, and nothing is written.
      if ((await redis.getdel(customerMfaKeys.enroll(k))) !== sealed) return 'expired';
      await redis.del(customerMfaKeys.enrollCount(k));
      // Single-column conditional write: never replaces an existing enrolment.
      return (await repo.enableMfa(k.partnerId, k.phone, b32)) ? 'ok' : 'enrolled';
    },

    /**
     * True only for a valid, not-yet-used code of an enrolled customer. Never
     * throws: a secret that does not open is logged (no value) and refused.
     */
    async verifyCode(k: CustomerKey, code: string): Promise<boolean> {
      let stored: { secretBase32: string; sealed: string } | null;
      try {
        stored = await repo.readMfa(k.partnerId, k.phone);
      } catch (err) {
        logWarn('customer.mfa', 'stored secret did not open; refusing', {
          error: err instanceof Error ? err.name : 'unknown',
        });
        return false;
      }
      if (!stored) return false;
      if (!(await acceptCode(k, base32Decode(stored.secretBase32), code))) return false;
      try {
        await repo.resealMfa(k.partnerId, k.phone, stored.sealed, stored.secretBase32);
      } catch (err) {
        // Best-effort upgrade; the accepted code stands.
        logWarn('customer.mfa', 'reseal failed', { error: err instanceof Error ? err.name : 'unknown' });
      }
      return true;
    },

    /** Turn MFA off (recovery) and drop its Redis state. Returns whether it was on. */
    async reset(k: CustomerKey): Promise<boolean> {
      const wasOn = await repo.clearMfa(k.partnerId, k.phone);
      await redis.del(customerMfaKeys.enroll(k));
      await redis.del(customerMfaKeys.enrollCount(k));
      await redis.del(customerMfaKeys.last(k));
      return wasOn;
    },

    /** A short, non-reversible tag of the password hash a pending sign-in proved. */
    passwordTag(passwordHash: string): string {
      return sha256hex(`customer-mfa-pending|${passwordHash}`).slice(0, PASSWORD_TAG_HEX);
    },
  };
}

export type CustomerMfaStore = ReturnType<typeof createCustomerMfaStore>;

let cached: CustomerMfaStore | null = null;

export function getCustomerMfaStore(): CustomerMfaStore {
  if (!cached) cached = createCustomerMfaStore(getRedis(), getCustomerStore(getStore()));
  return cached;
}

/** The (tenant, phone) key of a resolved customer row. */
export function customerKey(c: Pick<Customer, 'partnerId' | 'senderPhone'>): CustomerKey {
  return { partnerId: c.partnerId, phone: c.senderPhone };
}

// ── Audit (INSERT-only: audit_events rejects UPDATE/DELETE since 0019) ──────

export type CustomerMfaAuditAction = 'customer.mfa.enroll' | 'customer.mfa.reset';

/**
 * One `audit_events` row for a portal MFA change. The subject is the KEYED
 * customer id (auditSubjectId: `cust:<hmac>`), never the phone; the actor is
 * the portal itself (the customer is not staff). No secret, code or IP is
 * recorded. Throws on a write failure: callers log it.
 */
export async function recordCustomerMfaAudit(
  action: CustomerMfaAuditAction,
  k: CustomerKey,
  meta?: Record<string, unknown>,
): Promise<void> {
  await createAuditRepo(getDb()).record({
    partnerId: k.partnerId,
    actor: 'customer-portal',
    actorType: 'system',
    action,
    subjectId: auditSubjectId(k.partnerId, k.phone),
    ...(meta ? { meta } : {}),
  });
}

// ── Step-up (refund / recall) ────────────────────────────────────────────────

export type StepUpResult = 'ok' | 'code_required' | 'invalid' | 'throttled' | 'enrol_required';

export interface StepUpDeps {
  mfa: Pick<CustomerMfaStore, 'isEnrolled' | 'verifyCode'>;
  /** customer-auth-store's reserve-before-compare buckets (fix 19). */
  auth: {
    reserveLoginAttempt(phone: string, ip: string): Promise<boolean>;
    clearLoginFailures(phone: string, ip?: string): Promise<void>;
  };
  required?: boolean;
}

/**
 * Program-Fix 49D: the step-up in front of a portal refund or recall request.
 *  - Enrolled: a code is required. Every attempt reserves on the SAME buckets as
 *    a password attempt (so a code is never cheaper to guess), and a success
 *    clears the (phone, IP) bucket like changePasswordAction does.
 *  - Not enrolled: 'ok' (unchanged behaviour), unless CUSTOMER_MFA_REQUIRED is
 *    on, in which case the customer must turn MFA on first.
 */
export async function stepUp(
  customer: Pick<Customer, 'partnerId' | 'senderPhone'>,
  rawCode: string,
  clientIp: () => Promise<string>,
  deps: StepUpDeps,
): Promise<StepUpResult> {
  const k = customerKey(customer);
  if (!(await deps.mfa.isEnrolled(k))) {
    return (deps.required ?? env.customerMfaRequired) ? 'enrol_required' : 'ok';
  }
  const code = rawCode.replace(/\s+/g, '');
  if (!code) return 'code_required';
  // Read lazily: a customer without MFA never needs the request headers here.
  const ip = await clientIp();
  if (!(await deps.auth.reserveLoginAttempt(customer.senderPhone, ip))) return 'throttled';
  if (!(await deps.mfa.verifyCode(k, code))) return 'invalid';
  await deps.auth.clearLoginFailures(customer.senderPhone, ip);
  return 'ok';
}

/** The fixed `?error=` code a receipt page maps to fixed copy, per refusal. */
export const STEP_UP_ERROR: Record<Exclude<StepUpResult, 'ok'>, string> = {
  code_required: 'mfa_code',
  invalid: 'mfa_invalid',
  throttled: 'mfa_throttled',
  enrol_required: 'mfa_required',
};

