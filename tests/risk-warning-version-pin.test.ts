import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as warning from '@/lib/legal/risk-warning';

// Fix pack 6 T21 (R48, P18) — the ONE fixed risk warning a customer sees when a
// risk signal fires, its tick label and the pay refusal copy. The mint records
// RISK_WARNING_VERSION in the `risk.signals` audit row, so the version only
// means something if it identifies ONE exact wording. This pin hashes every
// export except the version, keyed by the version. Change a word => this fails
// until the author bumps RISK_WARNING_VERSION and pins the new hash below.

const PINNED: Record<string, string> = {
  'rw-2026-11.1-draft': '80fea6b621833f73ea49dde73375caef5a121d19055737d7bac0493cca4035e4',
};

function canonicalWording(): string {
  const { RISK_WARNING_VERSION: _v, ...rest } = warning;
  void _v;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(rest).sort()) out[key] = (rest as Record<string, unknown>)[key];
  return JSON.stringify(out);
}

describe('the risk warning wording is pinned to its version', { retry: 0 }, () => {
  it('is version rw-2026-11.1-draft', () => {
    expect(warning.RISK_WARNING_VERSION).toBe('rw-2026-11.1-draft');
  });

  it('the hash of the wording matches the pin for RISK_WARNING_VERSION', () => {
    const hash = createHash('sha256').update(canonicalWording()).digest('hex');
    expect(
      hash,
      `src/lib/legal/risk-warning.ts wording changed (sha256 ${hash}) but RISK_WARNING_VERSION ` +
        `('${warning.RISK_WARNING_VERSION}') was not bumped. Bump the version and pin the new hash in ` +
        'tests/risk-warning-version-pin.test.ts.',
    ).toBe(PINNED[warning.RISK_WARNING_VERSION]);
  });

  it('RISK_WARNING_VERSION ends with -draft (MLRO approval pending)', () => {
    expect(warning.RISK_WARNING_VERSION).toMatch(/-draft$/);
  });

  it('RISK_WARNING_TEXT is at most 300 characters, one paragraph, and never names SmartRemit, staff, a check, a review or a hold', () => {
    const text = warning.RISK_WARNING_TEXT;
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text).not.toMatch(/[\r\n]/);
    expect(text).toBe(text.trim());
    expect(text).not.toMatch(/smartremit|staff|check|review|hold|aml|compliance/i);
  });

  it('the tick label and the pay refusal copy are the fixed texts', () => {
    expect(warning.RISK_ACK_LABEL).toBe('I have read this warning.');
    expect(warning.PAY_RISK_ACK_REQUIRED_COPY).toBe('Tick the box to confirm you have read the warning, then pay.');
  });

  it('exports exactly the four constants (a new export needs this pin updated)', () => {
    expect(Object.keys(warning).sort()).toEqual(
      ['PAY_RISK_ACK_REQUIRED_COPY', 'RISK_ACK_LABEL', 'RISK_WARNING_TEXT', 'RISK_WARNING_VERSION'],
    );
  });

  it('the module has no import (client-safe for the pay form, T28)', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/legal/risk-warning.ts'), 'utf8');
    expect(src).not.toMatch(/^\s*import[\s{*'"]/m);
    expect(src).not.toMatch(/\brequire\s*\(/);
    expect(src).not.toMatch(/\bimport\s*\(/);
    expect(src).not.toMatch(/^\s*export\s[^;]*\sfrom\s/m);
  });
});
