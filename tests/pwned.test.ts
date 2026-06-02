import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { isPwnedPassword } from '@/lib/pwned';

function sha1Upper(s: string): string {
  return createHash('sha1').update(s).digest('hex').toUpperCase();
}

/** Build a HIBP range-response body where `password` is present with `count`. */
function rangeBodyFor(password: string, count: number, extras: string[] = []): string {
  const full = sha1Upper(password);
  const suffix = full.slice(5);
  const lines = [...extras, `${suffix}:${count}`];
  return lines.join('\r\n');
}

function fakeFetch(body: string, ok = true, status = 200) {
  return vi.fn(async (_url: string) => ({
    ok,
    status,
    async text() {
      return body;
    },
  })) as unknown as typeof fetch;
}

describe('isPwnedPassword', () => {
  it('queries the correct 5-char prefix range endpoint', async () => {
    const pw = 'password';
    const fetchImpl = fakeFetch(rangeBodyFor(pw, 9999999));
    await isPwnedPassword(pw, fetchImpl);
    const calledUrl = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as string;
    const prefix = sha1Upper(pw).slice(0, 5);
    expect(calledUrl).toBe(`https://api.pwnedpasswords.com/range/${prefix}`);
  });

  it('returns true when the 35-char suffix appears in the range body', async () => {
    const pw = 'password';
    const fetchImpl = fakeFetch(
      rangeBodyFor(pw, 42, ['0000000000000000000000000000000000A:5', '1111111111111111111111111111111111B:3']),
    );
    expect(await isPwnedPassword(pw, fetchImpl)).toBe(true);
  });

  it('returns false when the suffix is absent from the range body', async () => {
    const fetchImpl = fakeFetch(
      ['ABCDEF0000000000000000000000000000A:5', 'FEDCBA1111111111111111111111111111B:3'].join('\r\n'),
    );
    expect(await isPwnedPassword('totally-unique-passphrase-xyz', fetchImpl)).toBe(false);
  });

  it('is case-insensitive on the suffix comparison', async () => {
    const pw = 'password';
    const suffix = sha1Upper(pw).slice(5).toLowerCase(); // lowercased line from server
    const fetchImpl = fakeFetch(`${suffix}:7`);
    expect(await isPwnedPassword(pw, fetchImpl)).toBe(true);
  });

  it('fails open (returns false) on a network error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    expect(await isPwnedPassword('password', fetchImpl)).toBe(false);
  });

  it('fails open (returns false) on a non-OK HTTP status', async () => {
    const fetchImpl = fakeFetch('', false, 503);
    expect(await isPwnedPassword('password', fetchImpl)).toBe(false);
  });
});
