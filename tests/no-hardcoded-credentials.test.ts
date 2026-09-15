import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The e2e specs run against PRODUCTION (smoke.yml / nightly.yml). A literal
// fallback after `||` or `??` on an E2E_* credential is a live staff login
// committed to a public repository (audit sec-01). Fail the unit suite if one
// ever returns.
const ROOT = join(__dirname, '..');
const SPECS = ['tests/e2e/dashboard-smoke.spec.ts', 'tests/e2e/support-smoke.spec.ts'];
const LITERAL_FALLBACK = /process\.env\.E2E_[A-Z_]+\s*(\|\||\?\?)\s*['"][^'"]+['"]/;

describe('no hardcoded credentials', () => {
  for (const rel of SPECS) {
    it(`${rel} has no literal E2E_* fallback`, () => {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      expect(src).not.toMatch(LITERAL_FALLBACK);
    });
  }
});
