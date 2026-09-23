import { afterEach, describe, it, expect, vi } from 'vitest';
import { randomBytes, scryptSync } from 'node:crypto';

// Pass-through spy on hash-wasm (the tests/password.test.ts pattern) so the
// dummy-verify parity below can COUNT the Argon2 verify work.
const hw = vi.hoisted(() => ({ argon2Verify: vi.fn() }));
vi.mock('hash-wasm', async (orig) => {
  const real = await orig<typeof import('hash-wasm')>();
  hw.argon2Verify.mockImplementation(real.argon2Verify);
  return { ...real, argon2Verify: hw.argon2Verify };
});

import { hashPassword, needsRehash, verifyPassword, PEPPER_ID_CURRENT } from '@/lib/password';

// Program-Fix 45 P3 — the pepper-id READER. verifyPassword/needsRehash accept
// `$pv=<id>$<argon2 PHC>` (P4 will write it), while hashPassword keeps writing
// the bare `$argon2id$…` string exactly as on main.
//
// Peppers are built at runtime (no secret-shaped literals).
const PEPPER_A = randomBytes(24).toString('hex');
const PEPPER_B = randomBytes(24).toString('hex');
// Passwords are random per run (no password-shaped literals in the repo).
const randomPw = () => randomBytes(12).toString('base64url');
const PW_0 = randomPw();
const PW_1 = randomPw();
const PW_2 = randomPw();
const PW_3 = randomPw();
const PW_4 = randomPw();
const PW_5 = randomPw();
const PW_6 = randomPw();
const PW_X = randomPw();

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The BARE argon2id PHC under a pepper (what main / P3 wrote; P4 prefixes `$pv=p0$`). */
async function hashUnder(pepper: string, plain: string): Promise<string> {
  vi.stubEnv('PASSWORD_PEPPER', pepper);
  const h = await hashPassword(plain);
  vi.unstubAllEnvs();
  return h.replace(/^\$pv=p0\$/, '');
}

describe('GOLDEN (fix 45 P4): hashPassword writes $pv=p0$ + the argon2id PHC', () => {
  it('`$pv=p0$$argon2id$v=19$m=19456,t=2,p=1$…` — even with PASSWORD_PEPPER_PREVIOUS set', async () => {
    vi.stubEnv('PASSWORD_PEPPER', PEPPER_A);
    vi.stubEnv('PASSWORD_PEPPER_PREVIOUS', `p1:${PEPPER_B}`);
    const pw = randomPw();
    const h = await hashPassword(pw);
    expect(h.startsWith('$pv=p0$$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
    expect(h.split('$')).toHaveLength(8);
    // The PHC inside is exactly what main wrote: it verifies under PASSWORD_PEPPER on its own.
    const bare = h.slice('$pv=p0$'.length);
    expect(await verifyPassword(pw, bare)).toBe(true);
    expect(await verifyPassword(pw, h)).toBe(true);
    expect(needsRehash(h)).toBe(false);
  });
});

describe('$pv=<id>$ reader', () => {
  it('pins the current pepper id', () => {
    expect(PEPPER_ID_CURRENT).toBe('p0');
  });

  it('$pv=p0$ verifies under PASSWORD_PEPPER; a wrong password fails', async () => {
    const bare = await hashUnder(PEPPER_A, PW_0);
    vi.stubEnv('PASSWORD_PEPPER', PEPPER_A);
    expect(await verifyPassword(PW_0, `$pv=p0$${bare}`)).toBe(true);
    expect(await verifyPassword(PW_X, `$pv=p0$${bare}`)).toBe(false);
    // the bare form is unchanged
    expect(await verifyPassword(PW_0, bare)).toBe(true);
  });

  it('$pv=p1$ verifies under the PASSWORD_PEPPER_PREVIOUS entry for p1', async () => {
    const underB = await hashUnder(PEPPER_B, PW_1);
    vi.stubEnv('PASSWORD_PEPPER', PEPPER_A);
    vi.stubEnv('PASSWORD_PEPPER_PREVIOUS', `p1:${PEPPER_B}`);
    expect(await verifyPassword(PW_1, `$pv=p1$${underB}`)).toBe(true);
    expect(await verifyPassword(PW_X, `$pv=p1$${underB}`)).toBe(false);
    // the same hash under the p0 label does NOT verify (a different pepper)
    expect(await verifyPassword(PW_1, `$pv=p0$${underB}`)).toBe(false);
  });

  it('an unknown id is false, never a throw and never another pepper', async () => {
    const underB = await hashUnder(PEPPER_B, PW_2);
    vi.stubEnv('PASSWORD_PEPPER', PEPPER_B); // even the CURRENT pepper matches…
    expect(await verifyPassword(PW_2, `$pv=p1$${underB}`)).toBe(false); // …p1 is not configured
    vi.stubEnv('PASSWORD_PEPPER_PREVIOUS', `p2:${PEPPER_B}`);
    expect(await verifyPassword(PW_2, `$pv=p1$${underB}`)).toBe(false);
  });

  it('a p0 entry in PASSWORD_PEPPER_PREVIOUS never shadows PASSWORD_PEPPER', async () => {
    const underA = await hashUnder(PEPPER_A, PW_3);
    const underB = await hashUnder(PEPPER_B, PW_3);
    vi.stubEnv('PASSWORD_PEPPER', PEPPER_A);
    vi.stubEnv('PASSWORD_PEPPER_PREVIOUS', `p0:${PEPPER_B}`);
    expect(await verifyPassword(PW_3, `$pv=p0$${underA}`)).toBe(true);
    expect(await verifyPassword(PW_3, `$pv=p0$${underB}`)).toBe(false);
  });

  it('a p0 entry makes PASSWORD_PEPPER_PREVIOUS malformed (as the field ring refuses k0): p1 is not served', async () => {
    const underB = await hashUnder(PEPPER_B, PW_6);
    vi.stubEnv('PASSWORD_PEPPER', PEPPER_A);
    vi.stubEnv('PASSWORD_PEPPER_PREVIOUS', `p0:${PEPPER_A},p1:${PEPPER_B}`);
    expect(await verifyPassword(PW_6, `$pv=p1$${underB}`)).toBe(false);
  });

  it('never lets $pv= wrap the unpeppered legacy scrypt form (no downgrade)', async () => {
    const salt = randomBytes(16).toString('hex');
    const legacy = `${salt}:${scryptSync(PW_4, salt, 64).toString('hex')}`;
    expect(await verifyPassword(PW_4, legacy)).toBe(true); // bare legacy still works
    expect(await verifyPassword(PW_4, `$pv=p0$${legacy}`)).toBe(false);
  });

  it.each(['$pv=', '$pv=$', '$pv=p0', '$pv=p0$', '$pv=P0$$argon2id$x', '$pv=p01$$argon2id$x', '$pv=__proto__$$argon2id$x'])(
    'a malformed prefix %j is false, never a throw',
    async (stored) => {
      vi.stubEnv('PASSWORD_PEPPER', PEPPER_A);
      await expect(verifyPassword(randomPw(), stored)).resolves.toBe(false);
    },
  );

  it('a malformed PASSWORD_PEPPER_PREVIOUS never breaks the bare or p0 paths', async () => {
    const underA = await hashUnder(PEPPER_A, PW_5);
    vi.stubEnv('PASSWORD_PEPPER', PEPPER_A);
    vi.stubEnv('PASSWORD_PEPPER_PREVIOUS', 'no-colon-here');
    expect(await verifyPassword(PW_5, underA)).toBe(true);
    expect(await verifyPassword(PW_5, `$pv=p0$${underA}`)).toBe(true);
    expect(await verifyPassword(PW_5, `$pv=p1$${underA}`)).toBe(false);
  });
});

describe('needsRehash strips $pv=<id>$ first', () => {
  const GOOD = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g';
  const WEAK = '$argon2id$v=19$m=4096,t=1,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g';

  it('the bare forms: weak and legacy rehash as on main; a GOOD bare hash now rehashes ONCE to $pv=p0$ (fix 45 P4)', () => {
    expect(needsRehash(GOOD)).toBe(true);
    expect(needsRehash(WEAK)).toBe(true);
    expect(needsRehash('salt:hash')).toBe(true);
  });

  it('$pv=p0$ + good params → no rehash (so a P4 hash is not re-hashed on every login)', () => {
    expect(needsRehash(`$pv=p0$${GOOD}`)).toBe(false);
  });

  it('$pv=p0$ + weak params → rehash', () => {
    expect(needsRehash(`$pv=p0$${WEAK}`)).toBe(true);
  });

  it('a non-current pepper id → rehash (moves it to the current pepper)', () => {
    expect(needsRehash(`$pv=p1$${GOOD}`)).toBe(true);
  });

  it('a malformed prefix or a wrapped legacy form → rehash', () => {
    expect(needsRehash('$pv=$')).toBe(true);
    expect(needsRehash('$pv=p0$salt:hash')).toBe(true);
  });
});

describe('$pv= timing parity (fix 21): every path pays exactly one Argon2 verify', () => {
  it('an unknown pepper id burns exactly one dummy verify and is false', async () => {
    const bare = await hashUnder(PEPPER_A, PW_0);
    vi.stubEnv('PASSWORD_PEPPER', PEPPER_A);
    await verifyPassword(randomPw(), bare); // warm the per-instance dummy hash memo
    hw.argon2Verify.mockClear();
    expect(await verifyPassword(PW_0, `$pv=p9$${bare}`)).toBe(false);
    expect(hw.argon2Verify).toHaveBeenCalledTimes(1);
  });

  it('a malformed prefix burns exactly one dummy verify and is false', async () => {
    vi.stubEnv('PASSWORD_PEPPER', PEPPER_A);
    hw.argon2Verify.mockClear();
    expect(await verifyPassword(randomPw(), '$pv=$')).toBe(false);
    expect(hw.argon2Verify).toHaveBeenCalledTimes(1);
  });

  // Program-Fix 45 P4: the dummy hash itself is now `$pv=p0$…` (hashPassword's
  // new shape). The burned verify must run REAL Argon2 work over the bare PHC —
  // a verify handed the tagged string rejects at parse time, doing no work.
  it('the burned dummy verify does real Argon2 work (it resolves, never rejects on parse)', async () => {
    vi.stubEnv('PASSWORD_PEPPER', PEPPER_A);
    hw.argon2Verify.mockClear();
    expect(await verifyPassword(randomPw(), '$pv=p9$$argon2id$v=19$m=19456,t=2,p=1$x$y')).toBe(false);
    expect(hw.argon2Verify).toHaveBeenCalledTimes(1);
    const call = hw.argon2Verify.mock.calls[0][0] as { hash: string };
    expect(call.hash.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
    await expect(hw.argon2Verify.mock.results[0].value).resolves.toBe(false);
  });

  it('the known-id path makes exactly one verify', async () => {
    const bare = await hashUnder(PEPPER_A, PW_1);
    vi.stubEnv('PASSWORD_PEPPER', PEPPER_A);
    hw.argon2Verify.mockClear();
    expect(await verifyPassword(PW_1, `$pv=p0$${bare}`)).toBe(true);
    expect(hw.argon2Verify).toHaveBeenCalledTimes(1);
    hw.argon2Verify.mockClear();
    expect(await verifyPassword(randomPw(), `$pv=p0$${bare}`)).toBe(false);
    expect(hw.argon2Verify).toHaveBeenCalledTimes(1);
  });
});
