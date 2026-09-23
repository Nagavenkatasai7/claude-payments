import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { pwnedPasswordStatus } from '@/lib/pwned';
import {
  assertStaffPasswordPolicy,
  StaffPasswordPolicyError,
  STAFF_PASSWORD_MIN,
  STAFF_PASSWORD_MAX,
} from '@/lib/staff-password';

// Program-Fix 17a — the staff password policy for NEW passwords (create,
// reset, change). Never applied at login: existing passwords keep working.

const clean = async () => 'clean' as const;
const pwned = async () => 'pwned' as const;
const unavailable = async () => 'unavailable' as const;

describe('assertStaffPasswordPolicy', () => {
  it('refuses fewer than 12 characters', async () => {
    await expect(assertStaffPasswordPolicy('elevenchars', { pwnedCheck: clean, failClosed: true })).rejects.toThrow(
      /12 characters/,
    );
    expect(STAFF_PASSWORD_MIN).toBe(12);
  });

  it('refuses more than 128 characters', async () => {
    await expect(
      assertStaffPasswordPolicy('a'.repeat(STAFF_PASSWORD_MAX + 1), { pwnedCheck: clean, failClosed: true }),
    ).rejects.toThrow(/128/);
  });

  it('accepts 12..128 characters that are not breached', async () => {
    await expect(assertStaffPasswordPolicy('twelve chars', { pwnedCheck: clean, failClosed: true })).resolves.toBeUndefined();
    await expect(
      assertStaffPasswordPolicy('a'.repeat(STAFF_PASSWORD_MAX), { pwnedCheck: clean, failClosed: true }),
    ).resolves.toBeUndefined();
  });

  it('refuses a breached password', async () => {
    const err = await assertStaffPasswordPolicy('correct horse battery', { pwnedCheck: pwned, failClosed: false }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(StaffPasswordPolicyError);
    expect(err.message).toMatch(/data breach/);
  });

  it('fail-closed (create / reset): a breach-check outage refuses', async () => {
    await expect(
      assertStaffPasswordPolicy('long enough password', { pwnedCheck: unavailable, failClosed: true }),
    ).rejects.toThrow(/breach check is unavailable/i);
  });

  it('fail-closed also treats a throwing check as an outage', async () => {
    const boom = async () => {
      throw new Error('network');
    };
    await expect(assertStaffPasswordPolicy('long enough password', { pwnedCheck: boom, failClosed: true })).rejects.toThrow(
      /unavailable/i,
    );
  });

  it('fail-open (self-change): an outage allows and logs a warning', async () => {
    const warn = vi.fn();
    await expect(
      assertStaffPasswordPolicy('long enough password', { pwnedCheck: unavailable, failClosed: false, warn }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('length runs before the breach check (no HIBP call for a short password)', async () => {
    const check = vi.fn(clean);
    await expect(assertStaffPasswordPolicy('short', { pwnedCheck: check, failClosed: true })).rejects.toThrow();
    expect(check).not.toHaveBeenCalled();
  });
});

describe('pwnedPasswordStatus (tri-state, used fail-closed by staff create/reset)', () => {
  const pw = 'hunter2hunter2';
  const sha1 = createHash('sha1').update(pw).digest('hex').toUpperCase();

  it('pwned when the suffix is listed', async () => {
    const f = vi.fn(async () => new Response(`${sha1.slice(5)}:12\r\nABC:1`));
    expect(await pwnedPasswordStatus(pw, f as unknown as typeof fetch)).toBe('pwned');
  });
  it('clean when the suffix is absent', async () => {
    const f = vi.fn(async () => new Response('ABC:1'));
    expect(await pwnedPasswordStatus(pw, f as unknown as typeof fetch)).toBe('clean');
  });
  it('unavailable on a non-OK status or a network error', async () => {
    const bad = vi.fn(async () => new Response('x', { status: 503 }));
    expect(await pwnedPasswordStatus(pw, bad as unknown as typeof fetch)).toBe('unavailable');
    const boom = vi.fn(async () => {
      throw new Error('down');
    });
    expect(await pwnedPasswordStatus(pw, boom as unknown as typeof fetch)).toBe('unavailable');
  });
  it('retries ONCE on an outage: a transient 503 then a clean answer is clean', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response('x', { status: 503 }))
      .mockResolvedValueOnce(new Response('ABC:1'));
    expect(await pwnedPasswordStatus(pw, f as unknown as typeof fetch)).toBe('clean');
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('a persistent outage is unavailable after exactly two calls', async () => {
    const f = vi.fn(async () => new Response('x', { status: 503 }));
    expect(await pwnedPasswordStatus(pw, f as unknown as typeof fetch)).toBe('unavailable');
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('passes an abort signal so a hung HIBP call is bounded', async () => {
    const f = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response('ABC:1');
    });
    await pwnedPasswordStatus(pw, f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
