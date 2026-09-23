import { describe, expect, it } from 'vitest';
import { findIcloudDuplicates, isIcloudDuplicate } from '../scripts/check-icloud-dups.mjs';

// Program-Fix 40 (build-08, ui-14, docs-09): iCloud sync creates "<name> 2.ext"
// files and "<name> 3" dirs. PR #285 removed the tracked ones; this guard (a
// step in ci.yml's lint job) stops the next one from being committed.

describe('isIcloudDuplicate', () => {
  it.each([
    'src/app/page 3.tsx',
    'public/about-poster 2.svg',
    'dir 2/x.ts',
    'a/b 12/c.ts',
    'notes 2',
    'src/lib/rate 2.test.ts',
  ])('flags %s', (p) => {
    expect(isIcloudDuplicate(p)).toBe(true);
  });

  it.each([
    'src/lib/v2.ts',
    'src/app/page.tsx',
    'docs/Section10.md',
    'drizzle/0002_x.sql',
    'public/og-1200x630.png',
    'docs/Section 10 notes.md',
  ])('does not flag %s', (p) => {
    expect(isIcloudDuplicate(p)).toBe(false);
  });
});

describe('findIcloudDuplicates', () => {
  it('returns exactly the duplicate paths, in order', () => {
    expect(
      findIcloudDuplicates(['src/app/page.tsx', 'src/app/page 3.tsx', 'src/lib/v2.ts', 'dir 2/x.ts']),
    ).toEqual(['src/app/page 3.tsx', 'dir 2/x.ts']);
  });

  it('returns [] for a clean list', () => {
    expect(findIcloudDuplicates(['a.ts', 'b/c.tsx'])).toEqual([]);
  });
});
