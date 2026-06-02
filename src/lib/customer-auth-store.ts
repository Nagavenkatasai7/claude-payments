import { Redis } from '@upstash/redis';
import { createHash, randomBytes } from 'node:crypto';
import { env } from './env';
import type { RedisLike } from './store';
import type { Customer } from './types';
import { normalizePhone, isValidPhone } from './phone';
import { countryForPhone } from './partner-currency';
import { DEFAULT_PARTNER_ID, DEFAULT_SENDER_COUNTRY } from './defaults';
import { hashPassword, verifyPassword, needsRehash } from './password';
import {
  encryptField,
  defaultProvider,
  type EncryptionKeyProvider,
} from './field-crypto';

/**
 * customer-auth-store — persistent CUSTOMER account auth (separate from staff).
 *
 * Customer accounts attach to the existing phone-keyed `Customer` record
 * (`customer:<normalizedPhone>`); they are NOT staff and use a different cookie
 * (`__Host-sr_session`) and a different Redis namespace (`sr_*`).
 *
 * Sessions are AAL2 (NIST 800-63B): 256-bit opaque token, the Redis KEY is the
 * sha256 of the token so a DB dump leaks nothing usable; **30-min idle /
 * 12-h absolute** lifetimes enforced in code off an injectable `now()` seam.
 * A per-phone reverse-index set enables revoke-all on password reset/change.
 */

// ── Policy constants ──
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 64;
const IDLE_MS = 30 * 60 * 1000; //   30-min idle window
const ABSOLUTE_MS = 12 * 60 * 60 * 1000; // 12-h absolute window
const SESSION_IDLE_SECONDS = IDLE_MS / 1000; // Redis ex (defense-in-depth; code is authoritative)
const RESET_TTL_SECONDS = 30 * 60; // 30-min single-use reset token

// ── Key schema (sr_* namespace, fully separate from staff `session:` keys) ──
const sessionKey = (tokenHash: string) => `sr_sess:${tokenHash}`;
const sessionIndexKey = (phone: string) => `sr_sess_idx:${phone}`;
const resetKey = (tokenHash: string) => `sr_reset:${tokenHash}`;
const customerKey = (phone: string) => `customer:${phone}`;

function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

interface SessionRecord {
  phone: string;
  createdAtMs: number;
  lastSeenMs: number;
}

export interface RegisterInput {
  phone: string;
  email: string;
  password: string;
}

export interface RegisterOptions {
  /** Injectable HIBP breach check (defaults to the real k-anonymity check). */
  pwnedCheck?: (password: string) => Promise<boolean>;
  /** Injectable crypto provider for email encryption (defaults to env key). */
  cryptoProvider?: EncryptionKeyProvider;
}

export interface CustomerAuthStoreOptions {
  /** Injectable clock seam (ms epoch) for deterministic session-timeout tests. */
  now?: () => number;
}

export function createCustomerAuthStore(
  redis: RedisLike,
  opts: CustomerAuthStoreOptions = {},
) {
  const now = opts.now ?? (() => Date.now());

  async function loadCustomer(phone: string): Promise<Customer | null> {
    const raw = await redis.get(customerKey(phone));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Customer;
    } catch {
      return null;
    }
  }

  async function saveCustomer(customer: Customer): Promise<void> {
    await redis.set(customerKey(customer.senderPhone), JSON.stringify(customer));
    await redis.sadd('customers:phones', customer.senderPhone);
  }

  return {
    /** Read-only Customer lookup by raw/normalized phone (used by customer-auth). */
    async getCustomer(phoneRaw: string): Promise<Customer | null> {
      return loadCustomer(normalizePhone(phoneRaw));
    },

    /**
     * Register a customer account. Normalizes + validates the phone, attaches to
     * (or lazily creates) the phone-keyed Customer, refuses if an account already
     * exists (collision guard), enforces the password policy + a breach check
     * (fail-open), Argon2id-hashes the password, and field-encrypts the email.
     */
    async registerCustomer(
      input: RegisterInput,
      regOpts: RegisterOptions = {},
    ): Promise<Customer> {
      const phone = normalizePhone(input.phone);
      if (!isValidPhone(phone)) {
        throw new Error('Enter a valid phone number.');
      }

      // Collision-before-create: never silently overwrite/hijack an existing
      // account. saveCustomer is an unconditional SET, so this guard is mandatory.
      const existing = await loadCustomer(phone);
      if (existing?.passwordHash) {
        throw new Error('An account already exists for this number.');
      }

      // Password policy (no composition rules; just length bounds + breach check).
      const { password } = input;
      if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
        throw new Error(
          `Password must be between ${PASSWORD_MIN} and ${PASSWORD_MAX} characters.`,
        );
      }

      // Breach check is fail-open: if HIBP itself errors, do NOT block the user.
      const pwnedCheck = regOpts.pwnedCheck;
      if (pwnedCheck) {
        let pwned = false;
        try {
          pwned = await pwnedCheck(password);
        } catch {
          pwned = false; // availability over this advisory control
        }
        if (pwned) {
          throw new Error(
            'This password has appeared in a data breach — choose another.',
          );
        }
      }

      const passwordHash = await hashPassword(password);
      const provider = regOpts.cryptoProvider ?? defaultProvider();
      const encryptedEmail = encryptField(input.email, provider);
      const nowIso = new Date(now()).toISOString();

      let customer: Customer;
      if (existing) {
        // Attach to the existing record without clobbering its KYC/consent fields.
        customer = {
          ...existing,
          email: encryptedEmail,
          passwordHash,
          passwordUpdatedAt: nowIso,
          updatedAt: nowIso,
        };
      } else {
        // Lazy-create a fresh Customer (mirrors customer-store defaults).
        const senderCountry = countryForPhone(phone) ?? DEFAULT_SENDER_COUNTRY;
        customer = {
          senderPhone: phone,
          firstSeenAt: nowIso,
          kycStatus: 'not_started',
          senderCountry,
          partnerId: DEFAULT_PARTNER_ID,
          email: encryptedEmail,
          passwordHash,
          passwordUpdatedAt: nowIso,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
      }

      await saveCustomer(customer);
      return customer;
    },

    /**
     * Verify a login password. Returns the Customer on success, null otherwise
     * (no-account, no-password, and wrong-password all collapse to null — the
     * caller surfaces a single generic "Invalid login"). Lazy-upgrades a legacy
     * scrypt hash to Argon2id on a successful verify.
     */
    async verifyCustomerPassword(
      phoneRaw: string,
      password: string,
    ): Promise<Customer | null> {
      const phone = normalizePhone(phoneRaw);
      const customer = await loadCustomer(phone);
      if (!customer?.passwordHash) return null;

      const ok = await verifyPassword(password, customer.passwordHash);
      if (!ok) return null;

      if (needsRehash(customer.passwordHash)) {
        const upgraded: Customer = {
          ...customer,
          passwordHash: await hashPassword(password),
          passwordUpdatedAt: new Date(now()).toISOString(),
          updatedAt: new Date(now()).toISOString(),
        };
        await saveCustomer(upgraded);
        return upgraded;
      }
      return customer;
    },

    /**
     * Set a NEW password on an existing account (password reset / change). Unlike
     * registerCustomer this expects the account to exist — it never creates one,
     * and never clobbers KYC/consent/email. Enforces the same length policy +
     * (fail-open) breach check, Argon2id-hashes, and REVOKES ALL live sessions so
     * a reset invalidates every device. Returns the updated Customer, or null if
     * no account exists. The caller must NOT auto-login after this.
     */
    async setPassword(
      phoneRaw: string,
      newPassword: string,
      regOpts: RegisterOptions = {},
    ): Promise<Customer | null> {
      const phone = normalizePhone(phoneRaw);
      const customer = await loadCustomer(phone);
      if (!customer?.passwordHash) return null;

      if (newPassword.length < PASSWORD_MIN || newPassword.length > PASSWORD_MAX) {
        throw new Error(
          `Password must be between ${PASSWORD_MIN} and ${PASSWORD_MAX} characters.`,
        );
      }
      const pwnedCheck = regOpts.pwnedCheck;
      if (pwnedCheck) {
        let pwned = false;
        try {
          pwned = await pwnedCheck(newPassword);
        } catch {
          pwned = false; // availability over this advisory control
        }
        if (pwned) {
          throw new Error(
            'This password has appeared in a data breach — choose another.',
          );
        }
      }

      const nowIso = new Date(now()).toISOString();
      const updated: Customer = {
        ...customer,
        passwordHash: await hashPassword(newPassword),
        passwordUpdatedAt: nowIso,
        updatedAt: nowIso,
      };
      await saveCustomer(updated);

      // Revoke every live session: a reset/change invalidates all devices.
      const tokens = await redis.smembers(sessionIndexKey(phone));
      for (const t of tokens) {
        await redis.del(sessionKey(sha256hex(t)));
      }
      await redis.del(sessionIndexKey(phone));

      return updated;
    },

    /**
     * Stamp `phoneVerifiedAt` on the account after a successful WhatsApp OTP
     * verify (idempotent — re-verifying keeps the first timestamp). Returns the
     * updated Customer, or null if no account exists. Owns the same `customer:`
     * key + read-modify-write path as register so the phone-verify flag never
     * clobbers KYC/consent fields.
     */
    async markPhoneVerified(phoneRaw: string): Promise<Customer | null> {
      const phone = normalizePhone(phoneRaw);
      const customer = await loadCustomer(phone);
      if (!customer) return null;
      if (customer.phoneVerifiedAt) return customer; // first verify wins; no churn
      const nowIso = new Date(now()).toISOString();
      const updated: Customer = {
        ...customer,
        phoneVerifiedAt: nowIso,
        updatedAt: nowIso,
      };
      await saveCustomer(updated);
      return updated;
    },

    // ── Sessions (256-bit opaque token; Redis key = sha256(token)) ──

    async createSession(phone: string): Promise<string> {
      const token = randomBytes(32).toString('hex');
      const ts = now();
      const record: SessionRecord = {
        phone,
        createdAtMs: ts,
        lastSeenMs: ts,
      };
      await redis.set(sessionKey(sha256hex(token)), JSON.stringify(record), {
        ex: SESSION_IDLE_SECONDS,
      });
      await redis.sadd(sessionIndexKey(phone), token);
      return token;
    },

    /**
     * Resolve a session token to its phone, enforcing the AAL2 lifetimes in code
     * (Redis TTL is only a belt-and-suspenders backstop). On a live session,
     * refresh `lastSeenMs` (sliding idle window) and re-arm the Redis TTL.
     */
    async getSession(token: string): Promise<string | null> {
      const keyHash = sha256hex(token);
      const raw = await redis.get(sessionKey(keyHash));
      if (!raw) return null;
      let record: SessionRecord;
      try {
        record = JSON.parse(raw) as SessionRecord;
      } catch {
        return null;
      }
      const ts = now();
      if (ts - record.createdAtMs > ABSOLUTE_MS) return null; // 12-h absolute
      if (ts - record.lastSeenMs > IDLE_MS) return null; //      30-min idle

      record.lastSeenMs = ts;
      await redis.set(sessionKey(keyHash), JSON.stringify(record), {
        ex: SESSION_IDLE_SECONDS,
      });
      return record.phone;
    },

    async deleteSession(token: string): Promise<void> {
      const keyHash = sha256hex(token);
      const raw = await redis.get(sessionKey(keyHash));
      await redis.del(sessionKey(keyHash));
      if (raw) {
        try {
          const { phone } = JSON.parse(raw) as SessionRecord;
          await redis.srem(sessionIndexKey(phone), token);
        } catch {
          /* index entry will be skipped harmlessly on the next deleteAll */
        }
      }
    },

    /** Revoke every live session for a phone (on password reset/change). */
    async deleteAllSessions(phone: string): Promise<void> {
      const tokens = await redis.smembers(sessionIndexKey(phone));
      for (const t of tokens) {
        await redis.del(sessionKey(sha256hex(t)));
      }
      await redis.del(sessionIndexKey(phone));
    },

    // ── Password-reset tokens (256-bit, hashed at rest, single-use) ──

    async createResetToken(phone: string): Promise<string> {
      const token = randomBytes(32).toString('hex');
      await redis.set(resetKey(sha256hex(token)), phone, {
        ex: RESET_TTL_SECONDS,
      });
      return token;
    },

    /**
     * Consume a reset token: return its phone (or null) AND delete it so it can
     * never be replayed (single-use). The caller revokes all sessions + sets the
     * new password.
     */
    async consumeResetToken(token: string): Promise<string | null> {
      return redis.getdel(resetKey(sha256hex(token)));
    },
  };
}

export type CustomerAuthStore = ReturnType<typeof createCustomerAuthStore>;

let cached: CustomerAuthStore | null = null;

export function getCustomerAuthStore(): CustomerAuthStore {
  if (!cached) {
    const redis = new Redis({
      url: env.kvUrl,
      token: env.kvToken,
      automaticDeserialization: false,
    });
    cached = createCustomerAuthStore(redis as unknown as RedisLike);
  }
  return cached;
}
