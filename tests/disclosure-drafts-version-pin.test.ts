import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import * as drafts from '@/lib/legal/disclosure-drafts';

// Program-Fix 15 PR B (review r1) — the pay page posts DISCLOSURE_DRAFT_VERSION
// with the customer's acknowledgement, and the audit row records it. That id
// only means something if it identifies ONE exact wording. This pin hashes
// every customer-facing string the module exports (functions evaluated on fixed
// samples), keyed by the version. Change a word ⇒ this fails until the author
// bumps the version (keeping the old id in PREVIOUS_DISCLOSURE_VERSIONS) and
// re-pins the hash below.

const PINNED: Record<string, string> = {
  'disclosure-draft-2026-09-23b': '88354122c339faf2ac33444bba29afdbd2056744e267cc6a948e2566569e4703',
};

function canonicalWording(): string {
  const { DISCLOSURE_DRAFT_VERSION: _v, PREVIOUS_DISCLOSURE_VERSIONS: _p, ...rest } = drafts;
  void _v;
  void _p;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(rest).sort()) {
    const value = (rest as Record<string, unknown>)[key];
    out[key] =
      typeof value === 'function'
        ? [0, 1, 2, 5].map((n) => (value as (x: never) => string)((key === 'dateAvailableEstimate' ? n : `<${n}>`) as never))
        : value;
  }
  return JSON.stringify(out);
}

describe('disclosure-drafts wording is pinned to its version', { retry: 0 }, () => {
  it('the hash of the wording matches the pin for DISCLOSURE_DRAFT_VERSION', () => {
    const hash = createHash('sha256').update(canonicalWording()).digest('hex');
    const pinned = PINNED[drafts.DISCLOSURE_DRAFT_VERSION];
    expect(
      hash,
      `src/lib/legal/disclosure-drafts.ts wording changed (sha256 ${hash}) but DISCLOSURE_DRAFT_VERSION ` +
        `('${drafts.DISCLOSURE_DRAFT_VERSION}') was not bumped. Bump the version, move the old id into ` +
        'PREVIOUS_DISCLOSURE_VERSIONS, and pin the new hash in tests/disclosure-drafts-version-pin.test.ts.',
    ).toBe(pinned);
  });

  it('the current version is not also listed as a previous one', () => {
    expect(drafts.PREVIOUS_DISCLOSURE_VERSIONS).not.toContain(drafts.DISCLOSURE_DRAFT_VERSION);
  });
});
