/**
 * Program-Fix 49D — customer portal TOTP store (secret in customers.mfa_totp_enc
 * via customer-repo; enrolment-in-progress, replay guard in Redis).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { createCustomerMfaStore, customerMfaKeys, stepUp, CUSTOMER_MFA_ENROLL_MAX_CODES } from '@/lib/customer-mfa';
import { base32Decode, totpAt } from '@/lib/totp';
import { EnvKeyProvider, encryptField } from '@/lib/field-crypto';
import type { Db } from '@/db/client';
import type { Customer } from '@/lib/types';

const provider = new EnvKeyProvider(Buffer.alloc(32, 3));
vi.mock('@/lib/field-crypto', async () => {
  const actual = await vi.importActual<typeof import('@/lib/field-crypto')>('@/lib/field-crypto');
  return { ...actual, defaultProvider: () => provider };
});

const redis = fakeRedis();
const T0 = 1_700_000_015_000;
let clock = T0;
let db: Db;
let repo: ReturnType<typeof createCustomerRepo>;
const store = () => createCustomerMfaStore(redis, repo, { now: () => clock });
const WHO = { partnerId: 'default', phone: '15550004321' };

function customer(): Customer {
  const now = '2026-09-01T00:00:00.000Z';
  return {
    senderPhone: WHO.phone,
    partnerId: WHO.partnerId,
    firstSeenAt: now,
    kycStatus: 'not_started',
    senderCountry: 'US',
    passwordHash: 'x',
    createdAt: now,
    updatedAt: now,
  } as Customer;
}

async function enrol(): Promise<Buffer> {
  const begun = await store().beginEnrolment(WHO);
  if (!begun.ok) throw new Error('enrol refused');
  const secret = base32Decode(begun.secretBase32);
  expect(await store().confirmEnrolment(WHO, totpAt(secret, clock))).toBe('ok');
  return secret;
}

beforeEach(async () => {
  redis.dump.clear();
  clock = T0;
  db = await freshDb();
  repo = createCustomerRepo(db, async () => null, provider);
  await repo.saveCustomer(customer());
});

describe('customer-mfa store (Program-Fix 49D)', () => {
  it('begin → confirm with one code enrols; the secret lands in the customers row, not Redis', async () => {
    expect(await store().isEnrolled(WHO)).toBe(false);
    const begun = await store().beginEnrolment(WHO);
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    // Label: issuer + the last 4 digits only (never the full number).
    expect(begun.uri).toMatch(/^otpauth:\/\/totp\/SmartRemit:portal%20%E2%80%A64321\?secret=[A-Z2-7]{32}&/);
    expect(begun.uri).not.toContain(WHO.phone);
    expect(await store().isEnrolled(WHO)).toBe(false); // pending until confirmed
    const secret = base32Decode(begun.secretBase32);
    clock += 31_000;
    expect(await store().confirmEnrolment(WHO, totpAt(secret, clock))).toBe('ok');
    expect(await store().isEnrolled(WHO)).toBe(true);
    expect((await repo.readMfa(WHO.partnerId, WHO.phone))?.secretBase32).toBe(begun.secretBase32);
    expect(redis.dump.has(customerMfaKeys.enroll(WHO))).toBe(false);
    for (const v of redis.dump.values()) expect(String(v)).not.toContain(begun.secretBase32);
  });

  it('a wrong confirm code does not enrol; an expired enrolment says so', async () => {
    const begun = await store().beginEnrolment(WHO);
    if (!begun.ok) throw new Error();
    expect(await store().confirmEnrolment(WHO, '000000')).toBe('invalid');
    expect(await store().isEnrolled(WHO)).toBe(false);
    redis.dump.delete(customerMfaKeys.enroll(WHO));
    expect(await store().confirmEnrolment(WHO, totpAt(base32Decode(begun.secretBase32), clock))).toBe('expired');
  });

  it('confirm is capped: past the cap the pending enrolment is dropped', async () => {
    const begun = await store().beginEnrolment(WHO);
    if (!begun.ok) throw new Error();
    for (let i = 0; i < CUSTOMER_MFA_ENROLL_MAX_CODES; i++) expect(await store().confirmEnrolment(WHO, '000000')).toBe('invalid');
    expect(await store().confirmEnrolment(WHO, totpAt(base32Decode(begun.secretBase32), clock))).toBe('throttled');
    expect(redis.dump.has(customerMfaKeys.enroll(WHO))).toBe(false);
  });

  it('begin is refused while enrolled', async () => {
    await enrol();
    expect(await store().beginEnrolment(WHO)).toEqual({ ok: false, reason: 'enrolled' });
  });

  it('verifyCode: a valid code once; the same code again is a replay', async () => {
    const secret = await enrol();
    clock += 60_000;
    const code = totpAt(secret, clock);
    expect(await store().verifyCode(WHO, code)).toBe(true);
    expect(await store().verifyCode(WHO, code)).toBe(false);
    clock += 30_000;
    expect(await store().verifyCode(WHO, totpAt(secret, clock))).toBe(true);
    expect(await store().verifyCode(WHO, '12345')).toBe(false);
  });

  it('two DIFFERENT valid steps submitted concurrently: at most one passes (review r1)', async () => {
    const secret = await enrol();
    clock += 120_000;
    const now = totpAt(secret, clock);
    const next = totpAt(secret, clock + 30_000); // step+1 is inside the ±1 window
    // Force a real overlap: the last-step read waits (up to 50 ms) until BOTH
    // attempts have reached it, so without serialisation both would read the
    // same "last step" and both would pass.
    let arrived = 0;
    const overlapping = {
      ...redis,
      async get(key: string) {
        const value = await redis.get(key);
        if (key.startsWith('sr_totp_last:')) {
          arrived += 1;
          for (let i = 0; i < 50 && arrived < 2; i++) await new Promise((r) => setTimeout(r, 1));
        }
        return value;
      },
    };
    const s2 = createCustomerMfaStore(overlapping, repo, { now: () => clock });
    const results = await Promise.all([s2.verifyCode(WHO, now), s2.verifyCode(WHO, next)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('sequential use of the next step still works (the lock is released)', async () => {
    const secret = await enrol();
    clock += 120_000;
    expect(await store().verifyCode(WHO, totpAt(secret, clock))).toBe(true);
    clock += 30_000;
    expect(await store().verifyCode(WHO, totpAt(secret, clock))).toBe(true);
  });

  it('the confirm code cannot be replayed at sign-in', async () => {
    const begun = await store().beginEnrolment(WHO);
    if (!begun.ok) throw new Error();
    const code = totpAt(base32Decode(begun.secretBase32), clock);
    expect(await store().confirmEnrolment(WHO, code)).toBe('ok');
    expect(await store().verifyCode(WHO, code)).toBe(false);
  });

  it('verifyCode for a customer who is not enrolled is false', async () => {
    expect(await store().verifyCode(WHO, '123456')).toBe(false);
  });

  it('fails CLOSED when the stored secret does not open (still enrolled, every code refused)', async () => {
    const secret = await enrol();
    // The stored blob no longer opens (a tamper / a moved blob).
    const broken = createCustomerMfaStore(redis, {
      ...repo,
      readMfa: async () => {
        throw new Error('field-crypto: auth tag mismatch');
      },
    }, { now: () => clock });
    clock += 60_000;
    expect(await broken.isEnrolled(WHO)).toBe(true);
    expect(await broken.verifyCode(WHO, totpAt(secret, clock))).toBe(false);
  });

  it('reset turns MFA off, clears the Redis state, and reports whether it was on', async () => {
    await enrol();
    await store().beginEnrolment(WHO).catch(() => undefined);
    expect(await store().reset(WHO)).toBe(true);
    expect(await store().isEnrolled(WHO)).toBe(false);
    expect(redis.dump.has(customerMfaKeys.last(WHO))).toBe(false);
    expect(await store().reset(WHO)).toBe(false);
  });

  it('a verify after 46B flips writes re-seals the secret as v2 (and it still verifies)', async () => {
    const secret = await enrol();
    // Since 46B enrolment itself seals v2; model a pre-46B enrolment by sealing
    // the same secret v1 directly (the ctx-less legacy envelope).
    const current = (await repo.readMfa(WHO.partnerId, WHO.phone))!;
    expect(current.sealed.startsWith('v2.')).toBe(true);
    const legacy = encryptField(current.secretBase32, provider);
    expect(legacy.startsWith('v1.')).toBe(true);
    await db.execute(sql`UPDATE customers SET mfa_totp_enc = ${legacy} WHERE partner_id = ${WHO.partnerId} AND phone = ${WHO.phone}`);
    expect((await repo.readMfa(WHO.partnerId, WHO.phone))!.sealed).toBe(legacy);
    clock += 60_000;
    expect(await store().verifyCode(WHO, totpAt(secret, clock))).toBe(true);
    expect((await repo.readMfa(WHO.partnerId, WHO.phone))!.sealed.startsWith('v2.')).toBe(true);
    clock += 30_000;
    expect(await store().verifyCode(WHO, totpAt(secret, clock))).toBe(true);
  });

  it('passwordTag is a short, stable, non-reversible tag that changes with the hash', () => {
    const a = store().passwordTag('hash-1');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(store().passwordTag('hash-1')).toBe(a);
    expect(store().passwordTag('hash-2')).not.toBe(a);
  });
});

describe('stepUp (refund / recall, Program-Fix 49D)', () => {
  const C = { partnerId: WHO.partnerId, senderPhone: WHO.phone };
  const IP = async () => '1.2.3.4';
  function auth(allow = true) {
    return {
      reserveLoginAttempt: vi.fn(async () => allow),
      clearLoginFailures: vi.fn(async () => undefined),
    };
  }

  it('not enrolled and not required: ok with no code and no reservation', async () => {
    const a = auth();
    expect(await stepUp(C, '', IP, { mfa: store(), auth: a, required: false })).toBe('ok');
    expect(a.reserveLoginAttempt).not.toHaveBeenCalled();
  });

  it('not enrolled and CUSTOMER_MFA_REQUIRED on: enrol_required', async () => {
    expect(await stepUp(C, '', IP, { mfa: store(), auth: auth(), required: true })).toBe('enrol_required');
  });

  it('enrolled: no code → code_required (no reservation spent)', async () => {
    await enrol();
    const a = auth();
    expect(await stepUp(C, '  ', IP, { mfa: store(), auth: a })).toBe('code_required');
    expect(a.reserveLoginAttempt).not.toHaveBeenCalled();
  });

  it('enrolled: a wrong code spends a reservation and is refused; a right one clears (phone, IP)', async () => {
    const secret = await enrol();
    clock += 60_000;
    const a = auth();
    expect(await stepUp(C, '000000', IP, { mfa: store(), auth: a })).toBe('invalid');
    expect(a.reserveLoginAttempt).toHaveBeenCalledWith(WHO.phone, '1.2.3.4');
    expect(a.clearLoginFailures).not.toHaveBeenCalled();
    expect(await stepUp(C, totpAt(secret, clock), IP, { mfa: store(), auth: a })).toBe('ok');
    expect(a.clearLoginFailures).toHaveBeenCalledWith(WHO.phone, '1.2.3.4');
  });

  it('enrolled: a refused reservation never reaches the code check', async () => {
    const secret = await enrol();
    clock += 60_000;
    const m = store();
    const spy = vi.spyOn(m, 'verifyCode');
    expect(await stepUp(C, totpAt(secret, clock), IP, { mfa: m, auth: auth(false) })).toBe('throttled');
    expect(spy).not.toHaveBeenCalled();
  });
});
