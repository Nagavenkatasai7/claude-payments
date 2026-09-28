import { describe, it, expect } from 'vitest';
import { findHexLiterals } from './helpers-ui-scan';

// M4's shared site shell lives in src/components/site. Registering it in NEW_UI_ROOTS puts it
// under tests/ds-no-hex.test.ts (hex) with every other new-UI root; this pins the registration
// so a later edit cannot silently drop the shell out of the scan.
describe('the M4 site shell is a registered new-UI root (SPEC §1.1)', () => {
  it('src/components/site is in NEW_UI_ROOTS', async () => {
    const { NEW_UI_ROOTS } = await import('@/lib/ui/new-ui-roots');
    expect(NEW_UI_ROOTS).toContain('src/components/site');
  });
  it('and it is hex-free', () => {
    expect(findHexLiterals('src/components/site')).toEqual([]);
  });
});

// M4 PR-3: the MDX blocks (src/components/docs) are a registered new-UI root too, and the root
// mdx-components.tsx (a single FILE, which the directory walker cannot take) is scanned here.
describe('the M4 docs blocks and mdx-components.tsx are hex-free (SPEC §1.1)', () => {
  it('src/components/docs is in NEW_UI_ROOTS', async () => {
    const { NEW_UI_ROOTS } = await import('@/lib/ui/new-ui-roots');
    expect(NEW_UI_ROOTS).toContain('src/components/docs');
  });
  it('src/mdx-components.tsx carries no hex literal', async () => {
    const { readFileSync } = await import('node:fs');
    expect(readFileSync('src/mdx-components.tsx', 'utf8').match(/(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g)).toBeNull();
  });
});
