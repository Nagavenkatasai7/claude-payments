import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { PURPOSE_SCAM_WARNING, PURPOSE_SCAM_WARNING_VERSION } from '@/lib/purpose-detail';

// Fix pack 6 T14 (R47, P15, critic P12) — the customer scam warning is a
// placeholder until the first partner's MLRO approves it (index.md "Owner
// steps"). Its version id only means something if it identifies ONE exact
// wording, so the sha256 of PURPOSE_SCAM_WARNING is pinned beside the version.
// Change a word => this fails until the author bumps
// PURPOSE_SCAM_WARNING_VERSION and pins the new hash below.

const PINNED: Record<string, string> = {
  'scam-2026-11.1-draft': '22575c81b882e55e9dfc4fc2df6fd7bd709ff7a137c5123e8e02e041fd68d245',
};

describe('the scam warning wording is pinned to its version', { retry: 0 }, () => {
  it('is version scam-2026-11.1-draft', () => {
    expect(PURPOSE_SCAM_WARNING_VERSION).toBe('scam-2026-11.1-draft');
  });

  it('the hash of the wording matches the pin for PURPOSE_SCAM_WARNING_VERSION', () => {
    const hash = createHash('sha256').update(PURPOSE_SCAM_WARNING).digest('hex');
    expect(
      hash,
      `src/lib/purpose-detail.ts PURPOSE_SCAM_WARNING changed (sha256 ${hash}) but PURPOSE_SCAM_WARNING_VERSION ` +
        `('${PURPOSE_SCAM_WARNING_VERSION}') was not bumped. Bump the version and pin the new hash in ` +
        'tests/scam-warning-version-pin.test.ts.',
    ).toBe(PINNED[PURPOSE_SCAM_WARNING_VERSION]);
  });

  it('the version says draft (P20: a placeholder until the MLRO approves it)', () => {
    expect(PURPOSE_SCAM_WARNING_VERSION).toMatch(/draft/);
  });
});
