import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { isOpaqueTransferId, newTransferId } from '@/lib/id';

// Program-Fix 23: the id is an unauthenticated capability (/pay/<id>), the draft
// id, the rail reference and every prefixed id. It must come from a CSPRNG and
// carry 128 bits. Legacy 8-character ids stay valid — nothing checks the shape
// on a read path, so these tests only pin what a FRESH id looks like.

const ID_RE = /^[A-Za-z0-9_-]{22}$/;

describe('newTransferId — shape', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is 22 unpadded base64url characters that decode to exactly 16 bytes', () => {
    for (let i = 0; i < 50; i++) {
      const id = newTransferId();
      expect(id).toMatch(ID_RE);
      expect(Buffer.from(id, 'base64url')).toHaveLength(16);
      // Round-trip: the 22 characters are the canonical encoding of those bytes.
      expect(Buffer.from(id, 'base64url').toString('base64url')).toBe(id);
    }
  });
});

describe('newTransferId — no PRNG', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never calls Math.random (100 ids)', () => {
    const spy = vi.spyOn(Math, 'random');
    for (let i = 0; i < 100; i++) newTransferId();
    expect(spy).not.toHaveBeenCalled();
  });

  it('the source uses randomBytes(16).toString("base64url") and nothing else', () => {
    const src = readFileSync(new URL('../src/lib/id.ts', import.meta.url), 'utf8');
    expect(src).toContain("randomBytes(16).toString('base64url')");
    expect(src).not.toContain('Math.random');
    expect(src).not.toContain('getRandomValues');
  });
});

describe('newTransferId — distinct and URL/Redis-safe', () => {
  it('100,000 ids are all unique', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100_000; i++) seen.add(newTransferId());
    expect(seen.size).toBe(100_000);
  });

  it('needs no URL encoding and contains no Redis/button delimiter', () => {
    for (let i = 0; i < 200; i++) {
      const id = newTransferId();
      expect(encodeURIComponent(id)).toBe(id);
      expect(id).not.toMatch(/[:|=]/);
    }
  });
});

describe('newTransferId — WhatsApp-safe first character (review S2)', () => {
  // The bot sends /pay/<id> as plain text and WhatsApp can read a leading `_`
  // as an italic marker. The 22nd character is always one of A/Q/g/w (128 bits
  // = 21 sextets + 2 bits, so the last sextet is bb0000), so only the FIRST
  // character can be `_` or `-`; the mint rejects those (2/64, ~0.046 bits).
  it('5,000 ids: none starts with "_" or "-", every one is 22 chars', () => {
    for (let i = 0; i < 5_000; i++) {
      const id = newTransferId();
      expect(id).toHaveLength(22);
      expect(id[0]).not.toMatch(/[_-]/);
      expect(id).toMatch(ID_RE);
    }
  });

  it('the last character is always A, Q, g or w (so a trailing "_"/"-" is impossible)', () => {
    for (let i = 0; i < 2_000; i++) expect(newTransferId()[21]).toMatch(/^[AQgw]$/);
  });
});

describe('isOpaqueTransferId (pack 6 P10)', () => {
  it('true for 1,000 newTransferId() values', () => {
    for (let i = 0; i < 1_000; i++) expect(isOpaqueTransferId(newTransferId())).toBe(true);
  });

  it("false for a legacy 8-char id ('pay12345'), '', 21 and 23 chars, a 22-char string with '=' or '/' or a space, a non-string (cast)", () => {
    const base = 'AbCdEfGhIjKlMnOpQrStUw'; // 22 chars of the alphabet
    expect(isOpaqueTransferId(base)).toBe(true);
    expect(isOpaqueTransferId('pay12345')).toBe(false);
    expect(isOpaqueTransferId('')).toBe(false);
    expect(isOpaqueTransferId(base.slice(0, 21))).toBe(false);
    expect(isOpaqueTransferId(`${base}A`)).toBe(false);
    expect(isOpaqueTransferId(`${base.slice(0, 21)}=`)).toBe(false);
    expect(isOpaqueTransferId(`${base.slice(0, 21)}/`)).toBe(false);
    expect(isOpaqueTransferId(`${base.slice(0, 10)} ${base.slice(11)}`)).toBe(false);
    expect(isOpaqueTransferId(`${base}\n`)).toBe(false);
    expect(isOpaqueTransferId(12345 as unknown as string)).toBe(false);
    expect(isOpaqueTransferId(null as unknown as string)).toBe(false);
    expect(isOpaqueTransferId(undefined as unknown as string)).toBe(false);
  });
});
