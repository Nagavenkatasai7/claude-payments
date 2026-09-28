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
