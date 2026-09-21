import { describe, it, expect } from 'vitest';
import { shortCommitSha, versionBody } from '@/lib/deploy-version';

// GET /api/version is what the post-deploy smoke polls to know the rolling
// release reached 100%. Its whole contract: the first 7 chars of the commit
// SHA this deployment was built from, or 'unknown' — and nothing else.

const FULL = '6269fda3c1b2e4f5a6b7c8d9e0f1a2b3c4d5e6f7';

describe('shortCommitSha', () => {
  it('returns the first 7 chars of a full 40-char SHA', () => {
    expect(shortCommitSha(FULL)).toBe('6269fda');
  });

  it('lowercases so it matches `git rev-parse --short` / the workflow cut', () => {
    expect(shortCommitSha(FULL.toUpperCase())).toBe('6269fda');
  });

  it('trims surrounding whitespace', () => {
    expect(shortCommitSha(`  ${FULL}\n`)).toBe('6269fda');
  });

  it("returns 'unknown' when the env var is missing or empty", () => {
    expect(shortCommitSha(undefined)).toBe('unknown');
    expect(shortCommitSha('')).toBe('unknown');
    expect(shortCommitSha('   ')).toBe('unknown');
  });

  it("returns 'unknown' for anything that is not a hex commit SHA (never echoes arbitrary env content)", () => {
    expect(shortCommitSha('not-a-sha')).toBe('unknown');
    expect(shortCommitSha('abc12')).toBe('unknown'); // too short to be a commit
    expect(shortCommitSha('zzzzzzzzzz')).toBe('unknown');
    expect(shortCommitSha(`${FULL}0`)).toBe('unknown'); // 41 chars
    expect(shortCommitSha('<script>alert(1)</script>')).toBe('unknown');
  });
});

describe('versionBody', () => {
  it('exposes ONLY the short sha — no env names, deployment id or region', () => {
    const body = versionBody(FULL);
    expect(body).toEqual({ sha: '6269fda' });
    expect(Object.keys(body)).toEqual(['sha']);
  });

  it("reports 'unknown' when the build has no commit SHA", () => {
    expect(versionBody(undefined)).toEqual({ sha: 'unknown' });
  });
});
