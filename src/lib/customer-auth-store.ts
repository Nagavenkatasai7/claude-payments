import { getRedis } from './redis';
import { createHash, randomBytes } from 'node:crypto';
import type { RedisLike } from './store';
import { getStore } from './store';
import { getCustomerStore, type CustomerStore } from './customer-store';
import type { Customer, PartnerId } from './types';
import { logWarn } from './log';
import { normalizePhone, isValidPhone } from './phone';
import { countryForPhone } from './partner-currency';
import { DEFAULT_PARTNER_ID, DEFAULT_SENDER_COUNTRY } from './defaults';
import { hashPassword, verifyPassword, verifyPasswordOrDummy, needsRehash } from './password';
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
 * Sessions: 256-bit opaque token (password-only login for phone-verified
 * accounts since 2026-06-12; the register OTP remains the phone binding), the
 * Redis KEY is the sha256 of the token so a DB dump leaks nothing usable;
 * **30-min idle / 12-h absolute** lifetimes enforced in code off an
 * injectable `now()` seam.
 * A per-phone reverse-index set enables revoke-all on password reset/change;
 * since Program-Fix 20 it holds sha256(token) too (`sr_sess_ix:`), with a TTL,
 * so no Redis read yields a replayable token. The pre-fix raw-token index
 * (`sr_sess_idx:`) is still swept on revoke until the owner purges it.
 */

/**
 * A validation/policy error whose message is SAFE to show the end user (bad
 * phone, account collision, password length, breach hit). Everything else a
 * store method can throw — a crypto/env misconfig, an Argon2 failure, a Redis
 * outage — is an *internal* error whose raw message must NEVER be reflected to
 * the customer (it can leak config like env-var names). Callers surface
 * `CustomerInputError.message` verbatim and collapse all other throws to a
 * generic message.
 */
export class CustomerInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomerInputError';
  }
}

// ── Policy constants ──
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 64;
const IDLE_MS = 30 * 60 * 1000; //   30-min idle window
const ABSOLUTE_MS = 12 * 60 * 60 * 1000; // 12-h absolute window
const SESSION_IDLE_SECONDS = IDLE_MS / 1000; // Redis ex (defense-in-depth; code is authoritative)
const RESET_TTL_SECONDS = 30 * 60; // 30-min single-use reset token

// ── Login brute-force throttle (OWASP/NIST: cap consecutive failures) ──
// Program-Fix 19 (F71/F67): every password check RESERVES its attempt with an
// atomic INCR before the Argon2 run (no read-then-bump race), under three caps.
// The per-(phone, IP) cap is what a stranger hits; only reservations that pass
// it count toward the per-phone day ceiling, so ten requests from one IP can no
// longer lock the owner out of every device. A successful login clears the
// phone's counters; a successful reset (WhatsApp OTP) clears the day ceiling.
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const LOGIN_FAIL_MAX_PER_PHONE_IP_HOUR = 10; // per (phone, IP) per hour bucket
const LOGIN_FAIL_MAX_PER_PHONE_DAY = 30; // per phone per day bucket, across all IPs
const LOGIN_FAIL_MAX_PER_IP_HOUR = 50; // blunt distributed credential-stuffing
const HOUR_BUCKET_TTL_S = 2 * 60 * 60;
const DAY_BUCKET_TTL_S = 2 * 24 * 60 * 60;

// ── Key schema (sr_* namespace, fully separate from staff `session:` keys) ──
const sessionKey = (tokenHash: string) => `sr_sess:${tokenHash}`;
// Program-Fix 20 (F65): the revoke index holds sha256(token), never the token.
const sessionHashIndexKey = (phone: string) => `sr_sess_ix:${phone}`;
// Pre-fix index of RAW tokens. Never written again; revoke paths still sweep it
// (its sessions survive the deploy: the record key is unchanged) until
// scripts/purge-legacy-session-keys.ts --customer removes what is left.
const legacySessionIndexKey = (phone: string) => `sr_sess_idx:${phone}`;
const SESSION_INDEX_TTL_SECONDS = ABSOLUTE_MS / 1000; // no session outlives 12 h
const resetKey = (tokenHash: string) => `sr_reset:${tokenHash}`;

function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

interface SessionRecord {
  phone: string;
  partnerId?: PartnerId; // absent only on pre-fix-1 records ⇒ resolves to nothing (re-login)
  createdAtMs: number;
  lastSeenMs: number;
}

export interface SessionIdentity {
  phone: string;
  partnerId: PartnerId;
}

/** The ONE register refusal shown to the browser (D6): never says whether the number exists or under how many tenants. */
const REGISTER_UNAVAILABLE =
  "We can't set up an account for this number. If you already have one, sign in or reset your password; otherwise contact support.";

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
  customers: CustomerStore,
  opts: CustomerAuthStoreOptions = {},
) {
  const now = opts.now ?? (() => Date.now());

  // Stage 2a: customer RECORDS live in Postgres now — these helpers delegate
  // to the injected customer store. Sessions / reset tokens / throttles below
  // stay on Redis (hot, TTL'd, exactly where they belong).
  // Customer RECORDS live in Postgres. A phone may have a row per tenant (fix 1);
  // the portal binds to the ONE account-bearing row (the row holding
  // password_hash). Two account-bearing rows ⇒ ambiguous ⇒ null: the portal
  // fails CLOSED rather than logging someone into the wrong tenant's history.
  async function loadAccountRow(phone: string): Promise<Customer | null> {
    const rows = await customers.findByPhone(phone);
    const withAccount = rows.filter((c) => Boolean(c.passwordHash));
    return withAccount.length === 1 ? withAccount[0] : null;
  }

  async function saveCustomer(customer: Customer): Promise<void> {
    await customers.saveCustomer(customer);
  }

  /** Atomic increment + TTL on the bucket's first write (no read-then-set race). */
  async function bumpCounter(key: string, ttlS: number): Promise<number> {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, ttlS);
    return n;
  }

  /** Revoke every session for a phone: hashed-index members AND legacy raw-token members. */
  async function revokeAll(phone: string): Promise<void> {
    const hashes = await redis.smembers(sessionHashIndexKey(phone));
    for (const h of hashes) await redis.del(sessionKey(h));
    const legacyTokens = await redis.smembers(legacySessionIndexKey(phone));
    for (const t of legacyTokens) await redis.del(sessionKey(sha256hex(t)));
    await redis.del(sessionHashIndexKey(phone));
    await redis.del(legacySessionIndexKey(phone));
  }

  /**
   * Resolve a token to its live record, enforcing the AAL2 lifetimes in code
   * (Redis TTL is only a backstop) and sliding the idle window. A record without
   * a tenant (pre-fix-1) is treated as expired.
   */
  async function readLiveSession(
    token: string,
  ): Promise<(SessionRecord & { partnerId: PartnerId }) | null> {
    const keyHash = sha256hex(token);
    const raw = await redis.get(sessionKey(keyHash));
    if (!raw) return null;
    let record: SessionRecord;
    try {
      record = JSON.parse(raw) as SessionRecord;
    } catch {
      return null;
    }
    if (!record.partnerId) return null;
    const ts = now();
    if (ts - record.createdAtMs > ABSOLUTE_MS) return null; // 12-h absolute
    if (ts - record.lastSeenMs > IDLE_MS) return null; //      30-min idle
    record.lastSeenMs = ts;
    await redis.set(sessionKey(keyHash), JSON.stringify(record), { ex: SESSION_IDLE_SECONDS });
    return { ...record, partnerId: record.partnerId };
  }

  return {
    /** The account-bearing Customer for a phone, or null (missing OR ambiguous). Used by password reset. */
    async getCustomer(phoneRaw: string): Promise<Customer | null> {
      return loadAccountRow(normalizePhone(phoneRaw));
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
        throw new CustomerInputError('Enter a valid phone number.');
      }

      // Collision-before-create: never silently overwrite/hijack an existing
      // account. saveCustomer is an unconditional upsert, so this guard is mandatory.
      const rows = await customers.findByPhone(phone);
      // ONE generic message for BOTH refusals below. This is an unauthenticated
      // form: "an account already exists" is an existence oracle for any phone
      // and "linked to more than one service" is a multi-tenancy oracle (it
      // tells a caller the number is a customer of >1 partner). The distinction
      // lives only in a logWarn field — ids/reasons, never the phone — exactly
      // like the login / reset / verify ambiguity paths, which return a generic
      // null already.
      if (rows.some((c) => c.passwordHash)) {
        logWarn('portal.register_refused', 'account exists', { reason: 'exists' });
        throw new CustomerInputError(REGISTER_UNAVAILABLE);
      }
      // Fail closed on an ambiguous phone (a row under more than one tenant, none
      // with an account): the portal never picks a tenant on the customer's behalf.
      if (rows.length > 1) {
        logWarn('portal.register_refused', 'ambiguous tenant', { reason: 'ambiguous', tenants: rows.length });
        throw new CustomerInputError(REGISTER_UNAVAILABLE);
      }
      const existing = rows[0] ?? null;

      // Password policy (no composition rules; just length bounds + breach check).
      const { password } = input;
      if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
        throw new CustomerInputError(
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
          throw new CustomerInputError(
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
        // Attach to the existing record (whatever tenant it is under) without
        // clobbering its KYC/consent fields.
        customer = {
          ...existing,
          email: encryptedEmail,
          passwordHash,
          passwordUpdatedAt: nowIso,
          updatedAt: nowIso,
        };
      } else {
        // Lazy-create a fresh Customer under the default tenant (mirrors customer-store defaults).
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
      const customer = await loadAccountRow(phone);
      if (!customer?.passwordHash) {
        // Fix 21: no account (or no password) still pays ONE Argon2id verify
        // against the per-instance dummy hash, so a login for an unknown phone
        // takes as long as a wrong password for a known one.
        await verifyPasswordOrDummy(password, null);
        return null;
      }

      const ok = await verifyPassword(password, customer.passwordHash);
      if (!ok) return null;

      if (needsRehash(customer.passwordHash)) {
        const upgraded: Customer = {
          ...customer,
          passwordHash: await hashPassword(password),
          // passwordUpdatedAt is NOT bumped: the password is unchanged, and
          // resolveSession (fix 20) kills every session older than that stamp.
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
      const customer = await loadAccountRow(phone);
      if (!customer?.passwordHash) return null;

      if (newPassword.length < PASSWORD_MIN || newPassword.length > PASSWORD_MAX) {
        throw new CustomerInputError(
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
          throw new CustomerInputError(
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
      await revokeAll(phone);

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
      const customer = await loadAccountRow(phone);
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

    async createSession(phone: string, partnerId: PartnerId): Promise<string> {
      const token = randomBytes(32).toString('hex');
      const ts = now();
      const record: SessionRecord = { phone, partnerId, createdAtMs: ts, lastSeenMs: ts };
      const keyHash = sha256hex(token);
      // Index FIRST (a dangling index hash is harmless; an unindexed live record
      // would escape revoke-all on password reset).
      await redis.sadd(sessionHashIndexKey(phone), keyHash);
      await redis.expire(sessionHashIndexKey(phone), SESSION_INDEX_TTL_SECONDS);
      await redis.set(sessionKey(keyHash), JSON.stringify(record), { ex: SESSION_IDLE_SECONDS });
      return token;
    },

    /**
     * Resolve a session token to its (phone, tenant), enforcing the AAL2 lifetimes
     * in code (Redis TTL is only a belt-and-suspenders backstop). On a live
     * session, refresh `lastSeenMs` (sliding idle window) and re-arm the TTL.
     * A record without a tenant (pre-fix-1) is treated as expired.
     */
    async getSessionIdentity(token: string): Promise<SessionIdentity | null> {
      const live = await readLiveSession(token);
      return live ? { phone: live.phone, partnerId: live.partnerId } : null;
    },

    /** Phone-only view of getSessionIdentity (kept for existing callers/tests). */
    async getSession(token: string): Promise<string | null> {
      return (await this.getSessionIdentity(token))?.phone ?? null;
    },

    /**
     * The Customer a live session belongs to — the (tenant, phone) row, never a
     * phone-only guess. Fix 20 review: a session minted BEFORE the row's last
     * password change is dead whether or not any revoke index still lists it
     * (an old build's reset during a rolling release / Skew Protection /
     * rollback, or a lost index write). No `passwordUpdatedAt` ⇒ no rejection.
     */
    async resolveSession(token: string): Promise<Customer | null> {
      const live = await readLiveSession(token);
      if (!live) return null;
      const customer = await customers.getCustomer(live.partnerId, live.phone);
      if (!customer) return null;
      const changedAt = customer.passwordUpdatedAt ? Date.parse(customer.passwordUpdatedAt) : NaN;
      if (Number.isFinite(changedAt) && changedAt > live.createdAtMs) return null;
      return customer;
    },

    async deleteSession(token: string): Promise<void> {
      const keyHash = sha256hex(token);
      const raw = await redis.get(sessionKey(keyHash));
      await redis.del(sessionKey(keyHash));
      if (raw) {
        try {
          const { phone } = JSON.parse(raw) as SessionRecord;
          await redis.srem(sessionHashIndexKey(phone), keyHash);
          await redis.srem(legacySessionIndexKey(phone), token); // a pre-fix session signing out
        } catch {
          /* index entry will be skipped harmlessly on the next deleteAll */
        }
      }
    },

    /** Revoke every live session for a phone (on password reset/change). */
    async deleteAllSessions(phone: string): Promise<void> {
      await revokeAll(phone);
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

    // ── Login brute-force throttle (reserve-before-compare; fix 19) ──

    /**
     * Reserve ONE password attempt for (phone, ip). Returns true when the caller
     * may run the compare; false means refuse without touching Argon2. Each cap
     * is an atomic INCR with the TTL armed on the bucket's first write, checked
     * in this order so a refused reservation never advances a later counter:
     *   1. `sr_loginfail:pi:<phone>:<sha(ip)>:<hour>` — 10 per (phone, IP) per hour;
     *   2. `sr_loginfail:p:<phone>:<day>`             — 30 per phone per day, all IPs;
     *   3. `sr_loginfail:ip:<sha(ip)>:<hour>`         — 50 per IP per hour, all phones.
     * The IP is hashed in the key; the password never reaches this method.
     */
    async reserveLoginAttempt(phoneRaw: string, ip: string): Promise<boolean> {
      const t = now();
      const phone = normalizePhone(phoneRaw);
      const ipHash = sha256hex(ip);
      const hour = Math.floor(t / HOUR_MS);
      const day = Math.floor(t / DAY_MS);
      const piN = await bumpCounter(`sr_loginfail:pi:${phone}:${ipHash}:${hour}`, HOUR_BUCKET_TTL_S);
      if (piN > LOGIN_FAIL_MAX_PER_PHONE_IP_HOUR) return false;
      const pN = await bumpCounter(`sr_loginfail:p:${phone}:${day}`, DAY_BUCKET_TTL_S);
      if (pN > LOGIN_FAIL_MAX_PER_PHONE_DAY) return false;
      const ipN = await bumpCounter(`sr_loginfail:ip:${ipHash}:${hour}`, HOUR_BUCKET_TTL_S);
      return ipN <= LOGIN_FAIL_MAX_PER_IP_HOUR;
    },

    /**
     * Clear the phone's counters after a proven login (phone + ip) or a proven
     * reset (phone only — the WhatsApp OTP proved the number, so this is the
     * owner's way out of a distributed lock). The per-IP hourly counter keeps
     * counting successes too: an office NAT needs more than 50 logins an hour to notice.
     */
    async clearLoginFailures(phoneRaw: string, ip?: string): Promise<void> {
      const t = now();
      const phone = normalizePhone(phoneRaw);
      if (ip) {
        await redis.del(`sr_loginfail:pi:${phone}:${sha256hex(ip)}:${Math.floor(t / HOUR_MS)}`);
      }
      await redis.del(`sr_loginfail:p:${phone}:${Math.floor(t / DAY_MS)}`);
    },

    // ── Per-IP OTP-send throttle (blunt number-rotation OTP/toll-fraud pumping) ──
    async isOtpIpLocked(ip: string): Promise<boolean> {
      const t = now();
      return (
        Number((await redis.get(`sr_otpip:${sha256hex(ip)}:${Math.floor(t / HOUR_MS)}`)) ?? 0) >= 20
      );
    },
    async recordOtpIp(ip: string): Promise<void> {
      const t = now();
      const k = `sr_otpip:${sha256hex(ip)}:${Math.floor(t / HOUR_MS)}`;
      const n = await redis.incr(k);
      if (n === 1) await redis.expire(k, 2 * 60 * 60);
    },
  };
}

export type CustomerAuthStore = ReturnType<typeof createCustomerAuthStore>;

let cached: CustomerAuthStore | null = null;

export function getCustomerAuthStore(): CustomerAuthStore {
  if (!cached) {
    cached = createCustomerAuthStore(
      getRedis(),
      getCustomerStore(getStore()),
    );
  }
  return cached;
}
