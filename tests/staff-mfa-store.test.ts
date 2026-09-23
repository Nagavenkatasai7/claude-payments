/**
 * Program-Fix 17b — staff MFA store (Redis keys of its own, secret sealed with
 * field-crypto under ctx.staffMfa(username)).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fakeRedis } from './helpers';
import { createStaffMfaStore, staffMfaKeys, STAFF_MFA_PENDING_MAX_CODES } from '@/lib/staff-mfa-store';
import { base32Decode, totpAt } from '@/lib/totp';
import { __setFieldCryptoWriteV2ForTests, decryptField, encryptField } from '@/lib/field-crypto';
import { ctx } from '@/lib/crypto-context';

const redis = fakeRedis();
const T0 = 1_700_000_015_000;
let clock = T0;
const store = () => createStaffMfaStore(redis, { now: () => clock });

async function enrol(username: string): Promise<Buffer> {
  const begun = await store().beginEnrolment(username);
  if (!begun.ok) throw new Error('enrol refused');
  const secret = base32Decode(begun.secretBase32);
  expect(await store().confirmEnrolment(username, totpAt(secret, clock))).toBe('ok');
  return secret;
}

beforeEach(() => {
  redis.dump.clear();
  clock = T0;
});
afterEach(() => __setFieldCryptoWriteV2ForTests(false));

describe('staff-mfa-store (Program-Fix 17b)', () => {
  it('not enrolled by default; begin → confirm with a code enrols', async () => {
    expect(await store().isEnrolled('ops')).toBe(false);
    const begun = await store().beginEnrolment('ops');
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    expect(begun.uri).toMatch(/^otpauth:\/\/totp\/SmartRemit:ops\?secret=[A-Z2-7]{32}&/);
    // pending, not enrolled, until confirmed
    expect(await store().isEnrolled('ops')).toBe(false);
    const secret = base32Decode(begun.secretBase32);
    clock += 31_000; // the confirm code comes from the next step: still fine
    expect(await store().confirmEnrolment('ops', totpAt(secret, clock))).toBe('ok');
    expect(await store().isEnrolled('ops')).toBe(true);
    expect(redis.dump.has(staffMfaKeys.enroll('ops'))).toBe(false);
  });

  it('a wrong confirm code does not enrol; an expired enrolment says so', async () => {
    const begun = await store().beginEnrolment('ops');
    if (!begun.ok) throw new Error();
    expect(await store().confirmEnrolment('ops', '000000')).toBe('invalid');
    expect(await store().isEnrolled('ops')).toBe(false);
    redis.dump.delete(staffMfaKeys.enroll('ops')); // TTL elapsed
    const secret = base32Decode(begun.secretBase32);
    expect(await store().confirmEnrolment('ops', totpAt(secret, clock))).toBe('expired');
  });

  it('confirm is rate-limited: the 6th code drops the pending enrolment', async () => {
    const begun = await store().beginEnrolment('ops');
    if (!begun.ok) throw new Error();
    for (let i = 0; i < 5; i++) expect(await store().confirmEnrolment('ops', '000000')).toBe('invalid');
    const good = totpAt(base32Decode(begun.secretBase32), clock);
    expect(await store().confirmEnrolment('ops', good)).toBe('throttled');
    expect(await store().confirmEnrolment('ops', good)).toBe('expired');
    expect(await store().isEnrolled('ops')).toBe(false);
  });

  it('refuses to begin a second enrolment while enrolled (reset first)', async () => {
    await enrol('ops');
    expect((await store().beginEnrolment('ops')).ok).toBe(false);
  });

  it('the secret is never stored in plaintext and is sealed for this username only', async () => {
    const secret = await enrol('ops');
    const raw = redis.dump.get(staffMfaKeys.secret('ops'))!;
    const b32 = raw.includes('secretEnc') ? JSON.parse(raw).secretEnc : raw;
    expect(raw).not.toContain(secret.toString('hex'));
    expect(decryptField(b32, undefined, ctx.staffMfa('ops'))).toMatch(/^[A-Z2-7]+$/);
  });

  it('verifyCode accepts the current code once (replay refused), and an older code after a newer one', async () => {
    const secret = await enrol('ops');
    clock += 60_000;
    const code = totpAt(secret, clock);
    expect(await store().verifyCode('ops', code)).toBe(true);
    expect(await store().verifyCode('ops', code)).toBe(false); // same step: replay
    expect(await store().verifyCode('ops', totpAt(secret, clock - 30_000))).toBe(false); // older step
    clock += 30_000;
    expect(await store().verifyCode('ops', totpAt(secret, clock))).toBe(true);
  });

  it('the enrolment confirm code cannot be replayed at login', async () => {
    const begun = await store().beginEnrolment('ops');
    if (!begun.ok) throw new Error();
    const code = totpAt(base32Decode(begun.secretBase32), clock);
    expect(await store().confirmEnrolment('ops', code)).toBe('ok');
    expect(await store().verifyCode('ops', code)).toBe(false);
  });

  it('replay is refused even when the last-step marker is lost (per-step NX key)', async () => {
    const secret = await enrol('ops');
    clock += 60_000;
    const code = totpAt(secret, clock);
    expect(await store().verifyCode('ops', code)).toBe(true);
    redis.dump.delete(staffMfaKeys.last('ops'));
    expect(await store().verifyCode('ops', code)).toBe(false);
  });

  it('verifyCode is false for an unenrolled user and for garbage input', async () => {
    expect(await store().verifyCode('ghost', '123456')).toBe(false);
    await enrol('ops');
    expect(await store().verifyCode('ops', 'abcdef')).toBe(false);
  });

  it('works under v2 writes (after 46B): blob is v2, bound to the username, and still verifies', async () => {
    __setFieldCryptoWriteV2ForTests(true);
    const secret = await enrol('ops');
    const blob = JSON.parse(redis.dump.get(staffMfaKeys.secret('ops'))!).secretEnc as string;
    expect(blob.startsWith('v2.')).toBe(true);
    expect(() => decryptField(blob, undefined, ctx.staffMfa('other'))).toThrow();
    clock += 60_000;
    expect(await store().verifyCode('ops', totpAt(secret, clock))).toBe(true);
  });

  it('a v1 secret (enrolled before 46B) keeps verifying and is re-sealed to v2 once v2 writes are on', async () => {
    const secret = await enrol('ops');
    const before = JSON.parse(redis.dump.get(staffMfaKeys.secret('ops'))!).secretEnc as string;
    expect(before.startsWith('v1.')).toBe(true);
    // v1 → v1: no rewrite on verify
    clock += 60_000;
    expect(await store().verifyCode('ops', totpAt(secret, clock))).toBe(true);
    expect(JSON.parse(redis.dump.get(staffMfaKeys.secret('ops'))!).secretEnc).toBe(before);
    __setFieldCryptoWriteV2ForTests(true);
    clock += 60_000;
    expect(await store().verifyCode('ops', totpAt(secret, clock))).toBe(true);
    const after = JSON.parse(redis.dump.get(staffMfaKeys.secret('ops'))!);
    expect(after.secretEnc.startsWith('v2.')).toBe(true);
    expect(after.enrolledAt).toBeTruthy();
    clock += 60_000;
    expect(await store().verifyCode('ops', totpAt(secret, clock))).toBe(true);
  });

  it('a re-seal never resurrects a secret reset in between', async () => {
    const secret = await enrol('ops');
    __setFieldCryptoWriteV2ForTests(true);
    clock += 60_000;
    // reset lands after the secret was read but before the re-seal write:
    // simulated by a redis whose second GET of the secret key sees it gone.
    const s = createStaffMfaStore(
      {
        ...redis,
        get: (() => {
          let n = 0;
          return async (k: string) => {
            if (k === staffMfaKeys.secret('ops') && ++n === 2) {
              await store().reset('ops');
              return null;
            }
            return redis.get(k);
          };
        })(),
      },
      { now: () => clock },
    );
    await s.verifyCode('ops', totpAt(secret, clock));
    expect(await store().isEnrolled('ops')).toBe(false);
  });

  it('reset removes the secret, a pending enrolment and the replay marker', async () => {
    await enrol('ops');
    await store().reset('ops');
    expect(await store().isEnrolled('ops')).toBe(false);
    expect(redis.dump.has(staffMfaKeys.last('ops'))).toBe(false);
    expect((await store().beginEnrolment('ops')).ok).toBe(true);
  });

  it('enrolledAmong lists only enrolled usernames', async () => {
    await enrol('a');
    expect([...(await store().enrolledAmong(['a', 'b']))]).toEqual(['a']);
  });

  describe('pending second step', () => {
    it('stores only sha(token); the username comes back from the token', async () => {
      const token = await store().createPending('ops');
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect([...redis.dump.keys()].some((k) => k.includes(token))).toBe(false);
      expect(await store().pendingUser(token)).toBe('ops');
      expect(await store().pendingUser('nope')).toBeNull();
    });

    it(`allows ${STAFF_MFA_PENDING_MAX_CODES} codes per token, then drops it`, async () => {
      const token = await store().createPending('ops');
      for (let i = 0; i < STAFF_MFA_PENDING_MAX_CODES; i++) {
        expect(await store().countPendingAttempt(token)).toBe(true);
      }
      expect(await store().countPendingAttempt(token)).toBe(false);
      expect(await store().pendingUser(token)).toBeNull();
    });

    it('consumePending is single-use (two concurrent successes cannot both mint)', async () => {
      const token = await store().createPending('ops');
      const [a, b] = await Promise.all([store().consumePending(token), store().consumePending(token)]);
      expect([a, b].filter((x) => x === 'ops')).toHaveLength(1);
      expect(await store().pendingUser(token)).toBeNull();
    });
  });

  it('keeps working when a v1 blob was sealed without the context (legacy writes)', async () => {
    // A v1 blob ignores the context: an enrolment written by any build opens.
    const b32 = 'MZXW6YTBOI'.padEnd(32, 'A');
    redis.dump.set(
      staffMfaKeys.secret('ops'),
      JSON.stringify({ secretEnc: encryptField(b32), enrolledAt: new Date(T0).toISOString() }),
    );
    expect(await store().verifyCode('ops', totpAt(base32Decode(b32), clock))).toBe(true);
  });
});
