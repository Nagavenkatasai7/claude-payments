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
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EsignConsent, PayForm } from '@/app/pay/[transferId]/pay-form';
import { LinkPayForm } from '@/app/pay/l/[token]/link-pay-form';
import { esignConsentBody } from '@/lib/pay-outcome';
import {
  ESIGN_CONSENT_LABEL,
  ESIGN_CONSENT_TEXT,
  ESIGN_CONSENT_TITLE,
  ESIGN_CONSENT_VERSION,
} from '@/lib/legal/esign-consent';

// LinkPayForm calls useRouter (router.refresh on a lapsed rate); no app router mounts here.
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh: () => {} }),
}));

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

// Fix pack 6 T7b (P8): the payment-link form. Links are never exempt (P5).
describe('LinkPayForm: the consent block above the chosen disclosure (pack 6 T7b, P8)', () => {
  type LinkProps = Parameters<typeof LinkPayForm>[0];
  const linkBase: LinkProps = {
    token: 'AAAAAAAAAAAAAAAAAAAAAA',
    options: [
      { method: 'bank_transfer', label: 'Bank transfer', amountUsd: 294.12, feeUsd: 1.99, totalUsd: 296.11 },
      { method: 'debit_card', label: 'Debit card', amountUsd: 294.12, feeUsd: 2.99, totalUsd: 297.11 },
    ],
    disclosures: {
      bank_transfer: createElement('section', { 'data-testid': 'slot-mark' }, 'bank disclosure'),
      debit_card: createElement('section', { 'data-testid': 'card-mark' }, 'card disclosure'),
    },
    disclosureVersion: 'v1',
    quoteLockedAt: '2026-10-08T12:00:00.000Z',
    receipt: { payeeName: 'Sunrise Public School', reference: 'INV-1', amountInr: 25000 },
    approvingName: 'Sunrise Public School',
    disclosureHash: null,
  };
  const linkForm = (o: Partial<LinkProps> = {}) => renderToStaticMarkup(createElement(LinkPayForm, { ...linkBase, ...o }));

  it('esignVersion set -> the block ABOVE the chosen disclosure node (the first option), not the other one; Pay disabled', () => {
    const html = linkForm({ esignVersion: ESIGN_CONSENT_VERSION });
    expectBlockAboveSlot(html);
    expect(html).not.toContain('card-mark');
    expect(html.split('data-testid="esign-consent"')).toHaveLength(2);
    // Directly above the disclosure: after the money panel.
    expect(html.indexOf('Paying with')).toBeLessThan(html.indexOf('data-testid="esign-consent"'));
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Pay \$296\.11<\/button>/);
  });

  it('esignVersion set with no disclosure for the method: the block still renders, before the code button', () => {
    const html = linkForm({ esignVersion: ESIGN_CONSENT_VERSION, disclosures: {} });
    expect(html).toContain('data-testid="esign-consent"');
    expect(html.indexOf('data-testid="esign-consent"')).toBeLessThan(html.indexOf('Send confirmation code to WhatsApp'));
  });

  it('esignVersion absent or null -> markup unchanged', () => {
    const base = linkForm();
    expect(linkForm({ esignVersion: null })).toBe(base);
    expect(base).not.toContain('esign-consent');
    expect(base).not.toContain('name="esignConsent"');
    expect(base).toContain('slot-mark');
  });

  it('the pay body spreads esignConsentBody beside disclosureAckBody; request_otp stays { action: request_otp }', () => {
    const src = readFileSync('src/app/pay/l/[token]/link-pay-form.tsx', 'utf8');
    expect(src.match(/\.\.\.esignConsentBody\(esignVersion, esignTicked\)/g)).toHaveLength(1);
    const ack = src.indexOf('...disclosureAckBody(');
    const es = src.indexOf('...esignConsentBody(');
    expect(es).toBeGreaterThan(ack);
    expect(src.slice(ack, es).split('\n')).toHaveLength(2); // the next line
    expect(src).toContain("body: JSON.stringify({ action: 'request_otp' }),");
    expect(src.match(/action: 'request_otp'/g)).toHaveLength(1);
    // The pay guard and the Pay button both wait for the tick.
    expect(src).toMatch(/if \(ackMissing \|\| esignMissing \|\| origMissing \|\| !chosen\) return;/);
    expect(src).toMatch(/disabled=\{status === 'paying' \|\| !sent \|\| code\.length !== 6 \|\| ackMissing \|\| esignMissing \|\| origMissing\}/);
    // EsignConsent comes from the transfer pay form (no second copy of the block).
    expect(src).toMatch(/import \{[^}]*\bEsignConsent\b[^}]*\} from '@\/app\/pay\/\[transferId\]\/pay-form';/);
  });
});
