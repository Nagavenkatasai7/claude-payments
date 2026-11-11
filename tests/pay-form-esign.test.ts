/**
 * Fix pack 6 T7a (R46, P8): PayForm's E-SIGN consent tick. The repo has no DOM
 * test environment, so the form is checked through its static markup and the
 * pure body helper its two b2c bodies use:
 *   - no esignVersion -> the markup is byte-identical to today's;
 *   - esignVersion set -> the consent block (title, every text line, the tick box)
 *     renders ABOVE the disclosure slot on the Simple path and on the BankDetails
 *     details step; Continue waits for the tick; the ACH form never asks;
 *   - the pay body carries esignConsentVersion only when ticked; request_otp is unchanged.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EsignConsent, PayForm } from '@/app/pay/[transferId]/pay-form';
import { esignConsentBody } from '@/lib/pay-outcome';
import {
  ESIGN_CONSENT_LABEL,
  ESIGN_CONSENT_TEXT,
  ESIGN_CONSENT_TITLE,
  ESIGN_CONSENT_VERSION,
} from '@/lib/legal/esign-consent';

const summary = { destAmount: 17000, destCurrency: 'INR', sourceAmount: 200, sourceCurrency: 'USD', sourceTotalCharge: 200 };
const SLOT_MARK = 'data-testid="slot-mark"';
const slot = createElement('section', { 'data-testid': 'slot-mark' }, 'Reg E disclosure here');

type Opts = {
  needsBankDetails?: boolean;
  fundingMethod?: string;
  esignVersion?: string | null;
  withSlot?: boolean;
  disclosureVersion?: string | null;
};

function payForm(o: Opts): string {
  return renderToStaticMarkup(
    createElement(PayForm, {
      transferId: 'tr_1',
      destinationCountry: 'IN',
      needsBankDetails: o.needsBankDetails ?? false,
      recipientName: 'Mom',
      fundingMethod: o.fundingMethod ?? 'bank_transfer',
      summary,
      ...(o.disclosureVersion !== undefined ? { disclosureVersion: o.disclosureVersion } : {}),
      ...(o.esignVersion !== undefined ? { esignVersion: o.esignVersion } : {}),
      ...(o.withSlot ? { disclosureSlot: slot } : {}),
    }),
  );
}

// React escapes apostrophes and quotes in text; compare against the escaped form.
const esc = (s: string) => renderToStaticMarkup(createElement('span', null, s)).slice(6, -7);

function expectBlockAboveSlot(html: string): void {
  expect(html).toContain('data-testid="esign-consent"');
  expect(html).toContain(esc(ESIGN_CONSENT_TITLE));
  for (const line of ESIGN_CONSENT_TEXT) expect(html).toContain(esc(line));
  expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*name="esignConsent"/);
  expect(html).toContain(esc(ESIGN_CONSENT_LABEL));
  const block = html.indexOf('data-testid="esign-consent"');
  const slotAt = html.indexOf(SLOT_MARK);
  expect(slotAt).toBeGreaterThan(-1);
  expect(block).toBeLessThan(slotAt);
}

describe('PayForm without esignVersion: markup unchanged (P8)', () => {
  for (const needsBankDetails of [false, true]) {
    const path = needsBankDetails ? 'BankDetails' : 'Simple';
    it(`${path}: prop absent or null renders exactly the markup with neither esignVersion nor disclosureSlot`, () => {
      const base = payForm({ needsBankDetails, disclosureVersion: 'v1' });
      expect(payForm({ needsBankDetails, disclosureVersion: 'v1', esignVersion: null })).toBe(base);
      expect(base).not.toContain('esign-consent');
      expect(base).not.toContain('name="esignConsent"');
    });
  }
});

describe('PayForm with esignVersion: the consent block above the disclosure slot (P8)', () => {
  it('Simple path: title, every text line, the tick box and its label, above the slot', () => {
    const html = payForm({ esignVersion: ESIGN_CONSENT_VERSION, withSlot: true, disclosureVersion: 'v1' });
    expectBlockAboveSlot(html);
    // Pay is disabled (no code yet, and no tick).
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Pay now<\/button>/);
  });

  it('BankDetails details step: the block above the slot', () => {
    const html = payForm({ needsBankDetails: true, esignVersion: ESIGN_CONSENT_VERSION, withSlot: true });
    expect(html).toContain('Step 1 of 2');
    expectBlockAboveSlot(html);
  });

  it('the slot renders without the block when esignVersion is null', () => {
    const html = payForm({ esignVersion: null, withSlot: true });
    expect(html).toContain(SLOT_MARK);
    expect(html).not.toContain('esign-consent');
  });

  it('BankDetails details step: Continue is disabled while the box is unticked, only when esignVersion is set', () => {
    const asked = payForm({ needsBankDetails: true, esignVersion: ESIGN_CONSENT_VERSION });
    expect(asked).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Continue<\/button>/);
    const notAsked = payForm({ needsBankDetails: true });
    expect(notAsked).toMatch(/<button type="submit" class="[^"]*">Continue<\/button>/);
  });

  it('the ACH form never renders the block, even with esignVersion set', () => {
    const html = payForm({ fundingMethod: 'ach_pull', esignVersion: ESIGN_CONSENT_VERSION, withSlot: true });
    expect(html).toContain('Authorize ACH bank debit');
    expect(html).not.toContain('esign-consent');
    expect(html).not.toContain('name="esignConsent"');
    expect(html).toBe(payForm({ fundingMethod: 'ach_pull' }));
  });

  it('EsignConsent renders the checked state it is given', () => {
    const on = renderToStaticMarkup(createElement(EsignConsent, { checked: true, onChange: () => {} }));
    expect(on).toMatch(/name="esignConsent"[^>]*checked=""/);
    const off = renderToStaticMarkup(createElement(EsignConsent, { checked: false, onChange: () => {} }));
    expect(off).not.toContain('checked=""');
  });
});

describe('the pay body (P4, P8)', () => {
  it('esignConsentBody: unticked is {}, ticked carries the version, no version is {}', () => {
    expect(esignConsentBody(ESIGN_CONSENT_VERSION, false)).toEqual({});
    expect(esignConsentBody(ESIGN_CONSENT_VERSION, true)).toEqual({ esignConsentVersion: ESIGN_CONSENT_VERSION });
    expect(esignConsentBody(null, true)).toEqual({});
  });

  it('both b2c bodies spread esignConsentBody beside disclosureAckBody; request_otp stays { action: request_otp }', () => {
    const src = readFileSync('src/app/pay/[transferId]/pay-form.tsx', 'utf8');
    const spreads = src.match(/\.\.\.esignConsentBody\(esignVersion, esignTicked\)/g) ?? [];
    expect(spreads).toHaveLength(2);
    expect(src).toContain("body: JSON.stringify({ action: 'request_otp' }),");
    expect(src.match(/action: 'request_otp'/g)).toHaveLength(1);
  });
});

describe('the e2e absent check (P8)', () => {
  it('the literal in tests/e2e/pay-page-smoke.spec.ts equals ESIGN_CONSENT_LABEL', () => {
    const spec = readFileSync('tests/e2e/pay-page-smoke.spec.ts', 'utf8');
    const fn = spec.slice(spec.indexOf('async function expectNoPack6Text'));
    expect(fn).toContain("getByTestId('esign-consent')");
    const m = fn.match(/getByText\('([^']+)'\)/);
    expect(m?.[1]).toBe(ESIGN_CONSENT_LABEL);
    // Called in the four dead-link tests.
    expect(spec.match(/await expectNoPack6Text\(page\);/g)).toHaveLength(4);
  });
});
