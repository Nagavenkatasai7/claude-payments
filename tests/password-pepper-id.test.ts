import { afterEach, describe, it, expect, vi } from 'vitest';
import { randomBytes, scryptSync } from 'node:crypto';
import { hashPassword, needsRehash, verifyPassword, PEPPER_ID_CURRENT } from '@/lib/password';

// Program-Fix 45 P3 — the pepper-id READER. verifyPassword/needsRehash accept
// `$pv=<id>$<argon2 PHC>` (P4 will write it), while hashPassword keeps writing
// the bare `$argon2id$…` string exactly as on main.
//
// Peppers are built at runtime (no secret-shaped literals).
const PEPPER_A = randomBytes(24).toString('hex');
const PEPPER_B = randomBytes(24).toString('hex');

afterEach(() => {
  vi.unstubAllEnvs();
});

async function hashUnder(pepper: string, plain: string): Promise<string> {
  vi.stubEnv('PASSWORD_PEPPER', pepper);
  const h = await hashPassword(plain);
  vi.unstubAllEnvs();
  return h;
}

describe('GOLDEN: hashPassword writes exactly what main writes', () => {
  it('a bare $argon2id PHC with the target params, no $pv= prefix — even with PASSWORD_PEPPER_PREVIOUS set', async () => {
    vi.stubEnv('PASSWORD_PEPPER', PEPPER_A);
    vi.stubEnv('PASSWORD_PEPPER_PREVIOUS', `p1:${PEPPER_B}`);
    const h = await hashPassword('correct horse');
    expect(h.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
    expect(h).not.toContain('$pv=');
    expect(h.split('$')).toHaveLength(6);
  });
});

describe('$pv=<id>$ reader', () => {
  it('pins the current pepper id', () => {
    expect(PEPPER_ID_CURRENT).toBe('p0');
  });

  it('$pv=p0$ verifies under PASSWORD_PEPPER; a wrong password fails', async () => {
    const bare = await hashUnder(PEPPER_A, 'pw-0');
    vi.stubEnv('PASSWORD_PEPPER', PEPPER_A);
    expect(await verifyPassword('pw-0', `$pv=p0$${bare}`)).toBe(true);
    expect(await verifyPassword('pw-x', `$pv=p0$${bare}`)).toBe(false);
    // the bare form is unchanged
    expect(await verifyPassword('pw-0', bare)).toBe(true);
  });

  it('$pv=p1$ verifies under the PASSWORD_PEPPER_PREVIOUS entry for p1', async () => {
    const underB = await hashUnder(PEPPER_B, 'pw-1');
    vi.stubEnv('PASSWORD_PEPPER', PEPPER_A);
    vi.stubEnv('PASSWORD_PEPPER_PREVIOUS', `p1:${PEPPER_B}`);
    expect(await verifyPassword('pw-1', `$pv=p1$${underB}`)).toBe(true);
    expect(await verifyPassword('pw-x', `$pv=p1$${underB}`)).toBe(false);
    // the same hash under the p0 label does NOT verify (a different pepper)
    expect(await verifyPassword('pw-1', `$pv=p0$${underB}`)).toBe(false);
  });

  it('an unknown id is false, never a throw and never another pepper', async () => {
    const underB = await hashUnder(PEPPER_B, 'pw-2');
    vi.stubEnv('PASSWORD_PEPPER', PEPPER_B); // even the CURRENT pepper matches…
    expect(await verifyPassword('pw-2', `$pv=p1$${underB}`)).toBe(false); // …p1 is not configured
    vi.stubEnv('PASSWORD_PEPPER_PREVIOUS', `p2:${PEPPER_B}`);
    expect(await verifyPassword('pw-2', `$pv=p1$${underB}`)).toBe(false);
  });

  it('a p0 entry in PASSWORD_PEPPER_PREVIOUS never shadows PASSWORD_PEPPER', async () => {
    const underA = await hashUnder(PEPPER_A, 'pw-3');
    const underB = await hashUnder(PEPPER_B, 'pw-3');
    vi.stubEnv('PASSWORD_PEPPER', PEPPER_A);
    vi.stubEnv('PASSWORD_PEPPER_PREVIOUS', `p0:${PEPPER_B}`);
    expect(await verifyPassword('pw-3', `$pv=p0$${underA}`)).toBe(true);
    expect(await verifyPassword('pw-3', `$pv=p0$${underB}`)).toBe(false);
  });

  it('a p0 entry makes PASSWORD_PEPPER_PREVIOUS malformed (as the field ring refuses k0): p1 is not served', async () => {
    const underB = await hashUnder(PEPPER_B, 'pw-6');
    vi.stubEnv('PASSWORD_PEPPER', PEPPER_A);
    vi.stubEnv('PASSWORD_PEPPER_PREVIOUS', `p0:${PEPPER_A},p1:${PEPPER_B}`);
    expect(await verifyPassword('pw-6', `$pv=p1$${underB}`)).toBe(false);
  });

  it('never lets $pv= wrap the unpeppered legacy scrypt form (no downgrade)', async () => {
    const salt = randomBytes(16).toString('hex');
    const legacy = `${salt}:${scryptSync('pw-4', salt, 64).toString('hex')}`;
    expect(await verifyPassword('pw-4', legacy)).toBe(true); // bare legacy still works
    expect(await verifyPassword('pw-4', `$pv=p0$${legacy}`)).toBe(false);
  });

  it.each(['$pv=', '$pv=$', '$pv=p0', '$pv=p0$', '$pv=P0$$argon2id$x', '$pv=p01$$argon2id$x', '$pv=__proto__$$argon2id$x'])(
    'a malformed prefix %j is false, never a throw',
    async (stored) => {
      vi.stubEnv('PASSWORD_PEPPER', PEPPER_A);
      await expect(verifyPassword('pw', stored)).resolves.toBe(false);
    },
  );

  it('a malformed PASSWORD_PEPPER_PREVIOUS never breaks the bare or p0 paths', async () => {
    const underA = await hashUnder(PEPPER_A, 'pw-5');
    vi.stubEnv('PASSWORD_PEPPER', PEPPER_A);
    vi.stubEnv('PASSWORD_PEPPER_PREVIOUS', 'no-colon-here');
    expect(await verifyPassword('pw-5', underA)).toBe(true);
    expect(await verifyPassword('pw-5', `$pv=p0$${underA}`)).toBe(true);
    expect(await verifyPassword('pw-5', `$pv=p1$${underA}`)).toBe(false);
  });
});

describe('needsRehash strips $pv=<id>$ first', () => {
  const GOOD = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g';
  const WEAK = '$argon2id$v=19$m=4096,t=1,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g';

  it('the bare forms behave as on main', () => {
    expect(needsRehash(GOOD)).toBe(false);
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
