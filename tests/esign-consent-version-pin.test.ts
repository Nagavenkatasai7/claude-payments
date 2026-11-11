import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import * as esign from '@/lib/legal/esign-consent';

// Fix pack 6 T2 (R46, P3) — the pay page posts ESIGN_CONSENT_VERSION with the
// customer's E-SIGN consent, and the customer row and the audit row record it.
// That id only means something if it identifies ONE exact wording. This pin
// hashes every export of the module except the version (the portal card's
// withdrawal words included, P9), keyed by the version. Change a word => this
// fails until the author bumps the version and re-pins the hash below.

const PINNED: Record<string, string> = {
  'esign-2026-11.1-draft': 'e9b151ebc65e0807298c6703e8b33d8605bbed4c9504d82edec42b22fbe484b5',
};

function canonicalWording(): string {
  const { ESIGN_CONSENT_VERSION: _v, ...rest } = esign;
  void _v;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(rest).sort()) out[key] = (rest as Record<string, unknown>)[key];
  return JSON.stringify(out);
}

function allLines(): string[] {
  return [esign.ESIGN_CONSENT_TITLE, esign.ESIGN_CONSENT_LABEL, ...esign.ESIGN_CONSENT_TEXT, ...esign.ESIGN_WITHDRAW_COPY];
}

describe('esign-consent wording is pinned to its version', { retry: 0 }, () => {
  it('the hash of the wording matches the pin for ESIGN_CONSENT_VERSION', () => {
    const hash = createHash('sha256').update(canonicalWording()).digest('hex');
    const pinned = PINNED[esign.ESIGN_CONSENT_VERSION];
    expect(
      hash,
      `src/lib/legal/esign-consent.ts wording changed (sha256 ${hash}) but ESIGN_CONSENT_VERSION ` +
        `('${esign.ESIGN_CONSENT_VERSION}') was not bumped. Bump the version and pin the new hash in ` +
        'tests/esign-consent-version-pin.test.ts.',
    ).toBe(pinned);
  });

  it('the version says draft (P20)', () => {
    expect(esign.ESIGN_CONSENT_VERSION).toMatch(/draft/);
  });

  it('exports exactly the P3 names, and the line lists are frozen', () => {
    expect(Object.keys(esign).sort()).toEqual([
      'ESIGN_CONSENT_LABEL',
      'ESIGN_CONSENT_TEXT',
      'ESIGN_CONSENT_TITLE',
      'ESIGN_CONSENT_VERSION',
      'ESIGN_WITHDRAW_COPY',
    ]);
    expect(esign.ESIGN_CONSENT_TITLE).toBe('Electronic records');
    expect(esign.ESIGN_CONSENT_LABEL).toBe(
      'I agree to get the disclosures, receipts and notices for my transfers electronically.',
    );
    expect(Object.isFrozen(esign.ESIGN_CONSENT_TEXT)).toBe(true);
    expect(Object.isFrozen(esign.ESIGN_WITHDRAW_COPY)).toBe(true);
    expect(esign.ESIGN_CONSENT_TEXT.length).toBeGreaterThan(0);
    expect(esign.ESIGN_WITHDRAW_COPY.length).toBeGreaterThan(0);
  });

  it('the wording never claims approval or names SmartRemit as the provider of the money', () => {
    for (const line of allLines()) {
      expect(line).not.toMatch(/approv/i);
      expect(line).not.toMatch(/SmartRemit (sends|moves|transfers|is licensed)/i);
      expect(line).not.toMatch(/compliance|sanction|\bAML\b|risk|review|held|\bcheck/i);
    }
  });

  it('the withdrawal route names the provider as well as Profile', () => {
    const profileLines = esign.ESIGN_CONSENT_TEXT.filter((l) => /Profile/.test(l));
    expect(profileLines.length).toBeGreaterThan(0);
    for (const line of profileLines) expect(line).toMatch(/provider named on your receipt/);
    for (const line of esign.ESIGN_WITHDRAW_COPY) {
      if (/Profile/.test(line)) expect(line).toMatch(/provider named on your receipt/);
    }
  });

  it('the text covers the records, where, what you need, the re-ask, paper copies and duration', () => {
    const text = esign.ESIGN_CONSENT_TEXT.join('\n');
    expect(text).toMatch(/disclosures, receipts and notices/);
    expect(text).toMatch(/pay page/);
    expect(text).toMatch(/WhatsApp/);
    expect(text).toMatch(/web browser/);
    expect(text).toMatch(/asks? (you )?(for consent )?again/);
    expect(text).toMatch(/paper cop/);
    expect(text).toMatch(/until you withdraw/);
    const withdraw = esign.ESIGN_WITHDRAW_COPY.join('\n');
    expect(withdraw).toMatch(/again/);
    expect(withdraw).toMatch(/already paid/);
    expect(withdraw).toMatch(/provider named on your receipt/);
  });
});
