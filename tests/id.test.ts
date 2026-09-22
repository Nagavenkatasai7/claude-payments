import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { newTransferId } from '@/lib/id';

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
