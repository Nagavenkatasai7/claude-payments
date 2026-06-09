import { describe, it, expect } from 'vitest';
import { scryptSync, randomBytes } from 'node:crypto';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { createCustomerAuthStore } from '@/lib/customer-auth-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createStore } from '@/lib/store';
import { EnvKeyProvider, decryptField } from '@/lib/field-crypto';
import { verifyPassword } from '@/lib/password';
import type { Customer } from '@/lib/types';

// Fixed crypto provider so the email-encryption path never touches env.
const crypto = new EnvKeyProvider('0'.repeat(64));

const PHONE = '+1 (555) 010-2030'; // normalizes to 15550102030
const NORM = '15550102030';

// A legacy scrypt hash in the exact `salt:hash` shape password.ts understands,
// so the lazy-rehash path can be exercised without a pepper.
function legacyScryptHash(plain: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(plain, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

// Customer RECORDS live in Postgres now (pg-backed customer store); sessions /
// reset tokens / throttles stay on the injected Redis (sr_* keys).
async function mkAuth(redis = fakeRedis(), now?: () => number) {
  const db = await freshDb();
  const customers = createCustomerStore(db, createStore(fakeRedis(), db));
  const s = createCustomerAuthStore(redis, customers, now ? { now } : {});
  return { s, customers };
}

function neverPwned() {
  return async () => false;
}

describe('registerCustomer', () => {
  it('attaches an account to a lazily-created Customer, argon2-hashes the password and encrypts the email', async () => {
    const { s, customers } = await mkAuth();
    const c = await s.registerCustomer(
      { phone: PHONE, email: 'a@example.com', password: 'correct horse battery' },
      { pwnedCheck: neverPwned(), cryptoProvider: crypto },
    );

    expect(c.senderPhone).toBe(NORM);
    expect(c.partnerId).toBe('default');
    expect(c.senderCountry).toBe('US');
    expect(c.passwordHash?.startsWith('$argon2id$')).toBe(true);
    expect(c.passwordUpdatedAt).toBeTruthy();
    // email is a ciphertext blob, not the plaintext
    expect(c.email).toBeTruthy();
    expect(c.email).not.toContain('a@example.com');
    expect(decryptField(c.email!, crypto)).toBe('a@example.com');
    expect(await verifyPassword('correct horse battery', c.passwordHash!)).toBe(true);

    // persisted in the customer store
    const persisted = await customers.getCustomer(NORM);
    expect(persisted).toBeTruthy();
    expect(persisted!.passwordHash).toBe(c.passwordHash);
  });

  it('attaches to an EXISTING Customer record without clobbering its kyc fields', async () => {
    const { s, customers } = await mkAuth();
    const existing: Customer = {
      senderPhone: NORM,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      kycStatus: 'grandfathered',
      senderCountry: 'US',
      partnerId: 'default',
      optInAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    await customers.saveCustomer(existing);

    const c = await s.registerCustomer(
      { phone: NORM, email: 'b@example.com', password: 'another good one!!' },
      { pwnedCheck: neverPwned(), cryptoProvider: crypto },
    );
    expect(c.kycStatus).toBe('grandfathered');
    expect(c.optInAt).toBe('2026-01-01T00:00:00.000Z');
    expect(c.passwordHash).toBeTruthy();
  });

  it('throws a collision error when an account already exists for the number', async () => {
    const { s } = await mkAuth();
    await s.registerCustomer(
      { phone: PHONE, email: 'a@example.com', password: 'first password ok' },
      { pwnedCheck: neverPwned(), cryptoProvider: crypto },
    );
    await expect(
      s.registerCustomer(
        { phone: PHONE, email: 'a@example.com', password: 'second password ok' },
        { pwnedCheck: neverPwned(), cryptoProvider: crypto },
      ),
    ).rejects.toThrow(/already exists/i);
  });

  it('throws on an invalid phone', async () => {
    const { s } = await mkAuth();
    await expect(
      s.registerCustomer(
        { phone: '123', email: 'a@example.com', password: 'good password here' },
        { pwnedCheck: neverPwned(), cryptoProvider: crypto },
      ),
    ).rejects.toThrow();
  });

  it('throws when the password is too short', async () => {
    const { s } = await mkAuth();
    await expect(
      s.registerCustomer(
        { phone: PHONE, email: 'a@example.com', password: 'short' },
        { pwnedCheck: neverPwned(), cryptoProvider: crypto },
      ),
    ).rejects.toThrow(/8/);
  });

  it('throws when the password is too long', async () => {
    const { s } = await mkAuth();
    await expect(
      s.registerCustomer(
        { phone: PHONE, email: 'a@example.com', password: 'x'.repeat(65) },
        { pwnedCheck: neverPwned(), cryptoProvider: crypto },
      ),
    ).rejects.toThrow();
  });

  it('throws when the password is found in a breach corpus', async () => {
    const { s } = await mkAuth();
    await expect(
      s.registerCustomer(
        { phone: PHONE, email: 'a@example.com', password: 'breached password' },
        { pwnedCheck: async () => true, cryptoProvider: crypto },
      ),
    ).rejects.toThrow(/data breach/i);
  });

  it('fails open: a pwnedCheck that throws does not block registration', async () => {
    const { s } = await mkAuth();
    const c = await s.registerCustomer(
      { phone: PHONE, email: 'a@example.com', password: 'resilient password' },
      {
        pwnedCheck: async () => {
          throw new Error('HIBP unreachable');
        },
        cryptoProvider: crypto,
      },
    );
    expect(c.passwordHash).toBeTruthy();
  });
});

describe('verifyCustomerPassword', () => {
  it('returns the customer on a correct password and null on a wrong one', async () => {
    const { s } = await mkAuth();
    await s.registerCustomer(
      { phone: PHONE, email: 'a@example.com', password: 'the right password' },
      { pwnedCheck: neverPwned(), cryptoProvider: crypto },
    );
    expect(await s.verifyCustomerPassword(PHONE, 'the right password')).not.toBeNull();
    expect(await s.verifyCustomerPassword(PHONE, 'the wrong password')).toBeNull();
  });

  it('returns null when no account exists / no passwordHash', async () => {
    const { s, customers } = await mkAuth();
    expect(await s.verifyCustomerPassword(PHONE, 'whatever1234')).toBeNull();

    // record exists but has no passwordHash
    await customers.saveCustomer({
      senderPhone: NORM,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      kycStatus: 'not_started',
      senderCountry: 'US',
      partnerId: 'default',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(await s.verifyCustomerPassword(PHONE, 'whatever1234')).toBeNull();
  });

  it('lazily re-hashes a legacy scrypt hash to argon2 on a successful verify', async () => {
    const { s, customers } = await mkAuth();
    const legacy = legacyScryptHash('legacy secret pw');
    expect(legacy.startsWith('$argon2id$')).toBe(false);
    await customers.saveCustomer({
      senderPhone: NORM,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      kycStatus: 'not_started',
      senderCountry: 'US',
      partnerId: 'default',
      passwordHash: legacy,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const c = await s.verifyCustomerPassword(PHONE, 'legacy secret pw');
    expect(c).not.toBeNull();
    const persisted = (await customers.getCustomer(NORM))!;
    expect(persisted.passwordHash?.startsWith('$argon2id$')).toBe(true);
    // still verifies after the upgrade
    expect(await verifyPassword('legacy secret pw', persisted.passwordHash!)).toBe(true);
  });
});

describe('sessions', () => {
  it('creates a session and resolves it back to the phone', async () => {
    const { s } = await mkAuth();
    const token = await s.createSession(NORM);
    expect(typeof token).toBe('string');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await s.getSession(token)).toBe(NORM);
  });

  it('does not store the raw token as a key (hashed at rest)', async () => {
    const redis = fakeRedis();
    const { s } = await mkAuth(redis);
    const token = await s.createSession(NORM);
    expect([...redis.dump.keys()].some((k) => k.includes(token))).toBe(false);
  });

  it('deletes a session', async () => {
    const { s } = await mkAuth();
    const token = await s.createSession(NORM);
    await s.deleteSession(token);
    expect(await s.getSession(token)).toBeNull();
  });

  it('rejects after the 30-minute idle window', async () => {
    let now = 1_000_000;
    const { s } = await mkAuth(fakeRedis(), () => now);
    const token = await s.createSession(NORM);
    now += 31 * 60 * 1000; // 31 min idle
    expect(await s.getSession(token)).toBeNull();
  });

  it('refreshes lastSeen on access so steady activity keeps a session alive past 30 min', async () => {
    let now = 1_000_000;
    const { s } = await mkAuth(fakeRedis(), () => now);
    const token = await s.createSession(NORM);
    now += 20 * 60 * 1000;
    expect(await s.getSession(token)).toBe(NORM); // refresh
    now += 20 * 60 * 1000; // 20 more, but idle since refresh is only 20
    expect(await s.getSession(token)).toBe(NORM);
  });

  it('rejects after the 12-hour absolute window even with continuous activity', async () => {
    let now = 1_000_000;
    const { s } = await mkAuth(fakeRedis(), () => now);
    const token = await s.createSession(NORM);
    // keep refreshing every 10 min for >12h
    for (let i = 0; i < 80; i++) {
      now += 10 * 60 * 1000;
      await s.getSession(token);
    }
    // we are now ~13.3h past creation
    expect(await s.getSession(token)).toBeNull();
  });

  it('deleteAllSessions revokes every live session for the phone but not others', async () => {
    const { s } = await mkAuth();
    const t1 = await s.createSession(NORM);
    const t2 = await s.createSession(NORM);
    const tOther = await s.createSession('19998887777');
    await s.deleteAllSessions(NORM);
    expect(await s.getSession(t1)).toBeNull();
    expect(await s.getSession(t2)).toBeNull();
    expect(await s.getSession(tOther)).toBe('19998887777');
  });
});

describe('reset tokens', () => {
  it('issues a token that consumes to the phone exactly once (single-use)', async () => {
    const { s } = await mkAuth();
    const token = await s.createResetToken(NORM);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await s.consumeResetToken(token)).toBe(NORM);
    // second consume returns null
    expect(await s.consumeResetToken(token)).toBeNull();
  });

  it('returns null for an unknown / forged reset token', async () => {
    const { s } = await mkAuth();
    expect(await s.consumeResetToken('deadbeef')).toBeNull();
  });

  it('does not store the raw reset token as a key (hashed at rest)', async () => {
    const redis = fakeRedis();
    const { s } = await mkAuth(redis);
    const token = await s.createResetToken(NORM);
    expect([...redis.dump.keys()].some((k) => k.includes(token))).toBe(false);
  });
});
