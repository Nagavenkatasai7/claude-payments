/**
 * Fix pack 6 T28 (R48, P19): the risk warning and its tick on the DRAFT pay page.
 * The repo has no DOM test environment, so PayForm is checked through its static
 * markup (as tests/pay-form-esign.test.ts) plus source pins on the two b2c bodies:
 *   - riskWarning false or absent -> markup byte-identical;
 *   - riskWarning true -> RISK_WARNING_TEXT and the tick (name="riskAck") inside
 *     data-testid="risk-ack", ABOVE the E-SIGN block and the disclosure ack;
 *   - the ACH (b2b) form never renders it; the e2e absent check uses the exact label.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PayForm } from '@/app/pay/[transferId]/pay-form';
import { RISK_ACK_LABEL, RISK_WARNING_TEXT } from '@/lib/legal/risk-warning';
import { ESIGN_CONSENT_VERSION } from '@/lib/legal/esign-consent';

const summary = { destAmount: 17000, destCurrency: 'INR', sourceAmount: 200, sourceCurrency: 'USD', sourceTotalCharge: 200 };

type Opts = {
  needsBankDetails?: boolean;
  fundingMethod?: string;
  esignVersion?: string | null;
  disclosureVersion?: string | null;
  riskWarning?: boolean;
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
      ...(o.riskWarning !== undefined ? { riskWarning: o.riskWarning } : {}),
    }),
  );
}

// React escapes apostrophes and quotes in text; compare against the escaped form.
const esc = (s: string) => renderToStaticMarkup(createElement('span', null, s)).slice(6, -7);

function expectRiskBlock(html: string): void {
  expect(html).toContain('data-testid="risk-ack"');
  const block = html.slice(html.indexOf('data-testid="risk-ack"'));
  const end = block.indexOf('</div>');
  const inner = block.slice(0, end);
  expect(inner).toContain(esc(RISK_WARNING_TEXT));
  expect(inner).toMatch(/<input[^>]*type="checkbox"[^>]*name="riskAck"/);
  expect(inner).toContain(esc(RISK_ACK_LABEL));
}

describe('PayForm riskWarning (pack 6 T28, P19)', () => {
  it('riskWarning true (SimplePayForm): the markup holds RISK_WARNING_TEXT, an input name="riskAck" inside data-testid="risk-ack" with RISK_ACK_LABEL, and the Pay button is disabled', () => {
    const html = payForm({ riskWarning: true, disclosureVersion: 'v1' });
    expectRiskBlock(html);
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Pay now<\/button>/);
  });

  it('riskWarning true (BankDetailsPayForm, needsBankDetails): the same block is rendered', () => {
    const html = payForm({ needsBankDetails: true, riskWarning: true, disclosureVersion: 'v1' });
    expect(html).toContain('Step 1 of 2');
    expectRiskBlock(html);
  });

  it('order: risk-ack comes before esign-consent, which comes before the disclosure ack', () => {
    const withEsign = payForm({ riskWarning: true, disclosureVersion: 'v1', esignVersion: ESIGN_CONSENT_VERSION });
    const risk = withEsign.indexOf('data-testid="risk-ack"');
    const esign = withEsign.indexOf('data-testid="esign-consent"');
    const ack = withEsign.indexOf('name="disclosureAck"');
    expect(risk).toBeGreaterThan(-1);
    expect(esign).toBeGreaterThan(risk);
    expect(ack).toBeGreaterThan(esign);
    const noEsign = payForm({ riskWarning: true, disclosureVersion: 'v1', esignVersion: null });
    expect(noEsign).not.toContain('esign-consent');
    expect(noEsign.indexOf('data-testid="risk-ack"')).toBeGreaterThan(-1);
    expect(noEsign.indexOf('name="disclosureAck"')).toBeGreaterThan(noEsign.indexOf('data-testid="risk-ack"'));
    // BankDetails: the block heads the details step, before the E-SIGN block.
    const bank = payForm({ needsBankDetails: true, riskWarning: true, esignVersion: ESIGN_CONSENT_VERSION });
    expect(bank.indexOf('data-testid="esign-consent"')).toBeGreaterThan(bank.indexOf('data-testid="risk-ack"'));
  });

  for (const needsBankDetails of [false, true]) {
    for (const esignVersion of [null, ESIGN_CONSENT_VERSION]) {
      it(`riskWarning false or absent: markup byte-identical to a render without the prop (${needsBankDetails ? 'BankDetails' : 'Simple'}, esign ${esignVersion ? 'set' : 'null'})`, () => {
        const base = payForm({ needsBankDetails, disclosureVersion: 'v1', esignVersion });
        expect(payForm({ needsBankDetails, disclosureVersion: 'v1', esignVersion, riskWarning: false })).toBe(base);
        expect(base).not.toContain('risk-ack');
        expect(base).not.toContain('riskAck');
        expect(base).not.toContain(esc(RISK_ACK_LABEL));
      });
    }
  }

  it('the ACH (b2b) form never renders it, even with riskWarning true', () => {
    const base = payForm({ fundingMethod: 'ach_pull' });
    const html = payForm({ fundingMethod: 'ach_pull', riskWarning: true });
    expect(html).toBe(base);
    expect(html).not.toContain('risk-ack');
    expect(html).not.toContain(esc(RISK_WARNING_TEXT));
  });

  it('the text names no staff, no check and no rule', () => {
    expect(RISK_WARNING_TEXT).not.toMatch(/smartremit staff|compliance|aml|review/i);
    expect(RISK_WARNING_TEXT).not.toMatch(/smartremit|staff|check|review|hold|aml|compliance/i);
  });
});

describe('pay-form.tsx source pins (pack 6 T28)', () => {
  const src = readFileSync('src/app/pay/[transferId]/pay-form.tsx', 'utf8');
  it('both b2c bodies spread riskAckBody; the ACH body and request_otp do not', () => {
    expect(src.match(/\.\.\.riskAckBody\(riskWarning, riskTicked\)/g)).toHaveLength(2);
    expect(src).toContain("body: JSON.stringify({ action: 'request_otp' }),");
    const ach = src.slice(src.indexOf('function AchDebitPayForm'));
    expect(ach).not.toContain('riskAck');
    expect(ach).not.toContain('riskWarning');
  });
  it('riskMissing joins both submit guards and both Pay disabled lists', () => {
    expect(src).toMatch(/if \(ackMissing \|\| esignMissing \|\| riskMissing \|\| holderMissing \|\| origMissing\) return;/);
    expect(src).toMatch(/if \(ackMissing \|\| esignMissing \|\| riskMissing\) return;/);
    expect(src.match(/ackMissing \|\| esignMissing \|\| riskMissing/g)?.length).toBeGreaterThanOrEqual(4);
  });
});

describe('the e2e absent check (pack 6 T28)', () => {
  it('expectNoPack6Text in tests/e2e/pay-page-smoke.spec.ts checks risk-ack and the exact RISK_ACK_LABEL', () => {
    const spec = readFileSync('tests/e2e/pay-page-smoke.spec.ts', 'utf8');
    const start = spec.indexOf('async function expectNoPack6Text');
    const fn = spec.slice(start, spec.indexOf('\n}\n', start));
    expect(fn).toContain("await expect(page.getByTestId('risk-ack')).toHaveCount(0);");
    expect(fn).toContain(`await expect(page.getByText('${RISK_ACK_LABEL}')).toHaveCount(0);`);
    expect(spec.match(/await expectNoPack6Text\(page\);/g)).toHaveLength(4);
  });
});
