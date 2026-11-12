/**
 * Fix pack 5 T21b (P19, P31): PayForm's sender address / date-of-birth fields.
 * The repo has no DOM test environment, so the form is checked through its
 * static markup and the pure helpers its two b2c bodies use:
 *   - a field shows only when required and not on file; the ACH (b2b) form never asks;
 *   - the pay body carries senderAddress / senderDob only for a shown field;
 *   - a 400 fieldErrors.senderAddress | senderDob shows the FIXED copy under the field.
 */
import { describe, it, expect } from 'vitest';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  OriginatorFields,
  PayForm,
  formatDobInput,
  normalizeDobForBody,
  originatorBody,
  originatorFieldErrors,
  originatorMissing,
  originatorShown,
} from '@/app/pay/[transferId]/pay-form';
import {
  PAY_SENDER_ADDRESS_HINT,
  PAY_SENDER_ADDRESS_INVALID_COPY,
  PAY_SENDER_ADDRESS_LABEL,
  PAY_SENDER_DOB_INVALID_COPY,
  PAY_SENDER_DOB_LABEL,
} from '@/lib/pay-outcome';
import type { OriginatorView } from '@/lib/originator-info';

const BOTH: OriginatorView = { addressRequired: true, addressOnFile: false, dobRequired: true, dobOnFile: false };
const ADDRESS_ONLY: OriginatorView = { addressRequired: true, addressOnFile: false, dobRequired: false, dobOnFile: false };
const ON_FILE: OriginatorView = { addressRequired: true, addressOnFile: true, dobRequired: true, dobOnFile: true };
const NONE: OriginatorView = { addressRequired: false, addressOnFile: true, dobRequired: false, dobOnFile: true };

const summary = { destAmount: 17000, destCurrency: 'INR', sourceAmount: 200, sourceCurrency: 'USD', sourceTotalCharge: 200 };

function payForm(o: { originator?: OriginatorView; needsBankDetails?: boolean; fundingMethod?: string }): string {
  return renderToStaticMarkup(
    createElement(PayForm, {
      transferId: 'tr_1',
      destinationCountry: 'IN',
      needsBankDetails: o.needsBankDetails ?? false,
      recipientName: 'Mom',
      fundingMethod: o.fundingMethod ?? 'bank_transfer',
      summary,
      ...(o.originator ? { originator: o.originator } : {}),
    }),
  );
}

describe('originatorShown / originatorBody / originatorMissing', () => {
  it('shown = required && !onFile, per field', () => {
    expect(originatorShown(BOTH)).toEqual({ address: true, dob: true });
    expect(originatorShown(ADDRESS_ONLY)).toEqual({ address: true, dob: false });
    expect(originatorShown(ON_FILE)).toEqual({ address: false, dob: false });
    expect(originatorShown(NONE)).toEqual({ address: false, dob: false });
    expect(originatorShown({ ...BOTH, addressOnFile: true })).toEqual({ address: false, dob: true });
  });

  it('the body carries only the shown fields, trimmed; nothing when none is shown', () => {
    const values = { address: '  1 Placeholder Road, Town  ', dob: ' 1980-01-02 ' };
    expect(originatorBody({ address: true, dob: true }, values)).toEqual({
      senderAddress: '1 Placeholder Road, Town',
      senderDob: '1980-01-02',
    });
    expect(originatorBody({ address: true, dob: false }, values)).toEqual({ senderAddress: '1 Placeholder Road, Town' });
    expect(originatorBody({ address: false, dob: true }, values)).toEqual({ senderDob: '1980-01-02' });
    expect(originatorBody({ address: false, dob: false }, values)).toEqual({});
  });

  it('missing = a shown field left blank', () => {
    expect(originatorMissing({ address: true, dob: false }, { address: ' ', dob: '' })).toBe(true);
    expect(originatorMissing({ address: true, dob: true }, { address: 'x', dob: '' })).toBe(true);
    expect(originatorMissing({ address: true, dob: true }, { address: 'x', dob: 'y' })).toBe(false);
    expect(originatorMissing({ address: false, dob: false }, { address: '', dob: '' })).toBe(false);
  });
});

// Review round 2 (GB1): the DOB field keeps the number pad (no hyphen key on an
// iPhone), so the field inserts the hyphens as the customer types and the body
// builder turns exactly 8 digits into YYYY-MM-DD. The server stays strict.
describe('formatDobInput / normalizeDobForBody (GB1)', () => {
  it('keeps digits only, at most 8, with hyphens after the 4th and the 6th digit', () => {
    const cases: Array<[string, string]> = [
      ['', ''],
      ['1', '1'],
      ['1980', '1980'],
      ['19800', '1980-0'],
      ['198001', '1980-01'],
      ['1980010', '1980-01-0'],
      ['19800102', '1980-01-02'],
      ['198001029', '1980-01-02'],
      ['1980-01-02', '1980-01-02'],
      ['1980/01/02', '1980-01-02'],
      ['1980.01.02', '1980-01-02'],
      [' 1980 01 02 ', '1980-01-02'],
      ['ab19c80d0102', '1980-01-02'],
      ['abc', ''],
    ];
    for (const [typed, shown] of cases) expect(formatDobInput(typed), JSON.stringify(typed)).toBe(shown);
  });

  it('deleting works: a trailing hyphen left by a backspace goes, digits shrink', () => {
    expect(formatDobInput('1980-')).toBe('1980');
    expect(formatDobInput('1980-01-')).toBe('1980-01');
    expect(formatDobInput('1980-01-0')).toBe('1980-01-0');
    expect(formatDobInput('1980-0')).toBe('1980-0');
  });

  it('the body normaliser: exactly 8 digits -> YYYY-MM-DD; anything else unchanged (trimmed)', () => {
    expect(normalizeDobForBody('19800102')).toBe('1980-01-02');
    expect(normalizeDobForBody(' 19800102 ')).toBe('1980-01-02');
    expect(normalizeDobForBody('1980-01-02')).toBe('1980-01-02');
    for (const v of ['1980010', '198001023', '1980/01/02', '01/02/1980', 'abc', '']) {
      expect(normalizeDobForBody(v), v).toBe(v.trim());
    }
  });

  it('originatorBody sends 8 typed digits as YYYY-MM-DD and leaves a wrong value for the server to refuse', () => {
    expect(originatorBody({ address: false, dob: true }, { address: '', dob: '19800102' })).toEqual({
      senderDob: '1980-01-02',
    });
    expect(originatorBody({ address: false, dob: true }, { address: '', dob: '1980010' })).toEqual({
      senderDob: '1980010',
    });
    expect(originatorBody({ address: false, dob: true }, { address: '', dob: '01/02/1980' })).toEqual({
      senderDob: '01/02/1980',
    });
  });

  function findInput(node: ReactNode, name: string): ReactElement<{ onChange: (e: { target: { value: string } }) => void }> | null {
    if (Array.isArray(node)) {
      for (const n of node) {
        const hit = findInput(n, name);
        if (hit) return hit;
      }
      return null;
    }
    if (!isValidElement(node)) return null;
    const props = node.props as { name?: string; children?: ReactNode };
    if (node.type === 'input' && props.name === name) {
      return node as ReactElement<{ onChange: (e: { target: { value: string } }) => void }>;
    }
    return findInput(props.children, name);
  }

  it('the field formats as typed: onChange hands onDob the hyphenated value', () => {
    const seen: string[] = [];
    const tree = OriginatorFields({
      shown: { address: false, dob: true },
      address: '',
      dob: '',
      onAddress: () => {},
      onDob: (v) => seen.push(v),
    });
    const input = findInput(tree, 'senderDob');
    expect(input).not.toBeNull();
    for (const typed of ['19800102', '1980/01/02', '1980-', '19801']) input!.props.onChange({ target: { value: typed } });
    expect(seen).toEqual(['1980-01-02', '1980-01-02', '1980', '1980-1']);
  });

  it('the payment-link form uses the same field and body builder (the fix reaches it)', () => {
    const src = readFileSync(join(process.cwd(), 'src/app/pay/l/[token]/link-pay-form.tsx'), 'utf8');
    expect(src).toMatch(/from '@\/app\/pay\/\[transferId\]\/pay-form'/);
    expect(src).toContain('...originatorBody(shownOrig, { address: senderAddress, dob: senderDob })');
    expect(src).toContain('<OriginatorFields');
    // the link form builds its body only through originatorBody (no raw senderDob key)
    expect(src).not.toMatch(/senderDob:\s*senderDob/);
  });
});

describe('originatorFieldErrors: a 400 originator_invalid -> the fixed copy', () => {
  it('maps each field to its fixed copy, whatever the server text', () => {
    expect(originatorFieldErrors({ senderAddress: 'server text' })).toEqual({ senderAddress: PAY_SENDER_ADDRESS_INVALID_COPY });
    expect(originatorFieldErrors({ senderDob: 'x' })).toEqual({ senderDob: PAY_SENDER_DOB_INVALID_COPY });
  });

  it('other or missing field errors -> nothing', () => {
    expect(originatorFieldErrors({ accountHolder: 'x' })).toEqual({});
    expect(originatorFieldErrors(undefined)).toEqual({});
    expect(originatorFieldErrors(null)).toEqual({});
    expect(originatorFieldErrors('senderAddress')).toEqual({});
  });
});

describe('OriginatorFields markup', () => {
  const render = (shown: { address: boolean; dob: boolean }, errors = {}) =>
    renderToStaticMarkup(
      createElement(OriginatorFields, { shown, address: '', dob: '', onAddress: () => {}, onDob: () => {}, errors }),
    );

  it('the address input: name, label, hint, maxLength 300, street-address autocomplete, not pre-filled', () => {
    const html = render({ address: true, dob: false });
    expect(html).toContain('name="senderAddress"');
    expect(html).toContain(PAY_SENDER_ADDRESS_LABEL);
    expect(html).toContain(PAY_SENDER_ADDRESS_HINT);
    expect(html).toContain('maxLength="300"');
    expect(html).toContain('autoComplete="street-address"');
    expect(html).toMatch(/name="senderAddress"[^>]*value=""/);
    expect(html).not.toContain('name="senderDob"');
  });

  it('the DOB input: text, YYYY-MM-DD placeholder, numeric keypad, bday autocomplete', () => {
    const html = render({ address: false, dob: true });
    expect(html).toContain('name="senderDob"');
    expect(html).toContain(PAY_SENDER_DOB_LABEL);
    expect(html).toContain('type="text"');
    expect(html).toContain('placeholder="YYYY-MM-DD"');
    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain('autoComplete="bday"');
    expect(html).not.toContain('name="senderAddress"');
  });

  it('nothing shown -> no markup', () => {
    expect(render({ address: false, dob: false })).toBe('');
  });

  it('a field error renders the fixed copy under its field', () => {
    const html = render(
      { address: true, dob: true },
      originatorFieldErrors({ senderAddress: 'bad', senderDob: 'bad' }),
    );
    expect(html).toContain(PAY_SENDER_ADDRESS_INVALID_COPY);
    expect(html).toContain(PAY_SENDER_DOB_INVALID_COPY);
    // Each copy sits after its own input.
    expect(html.indexOf(PAY_SENDER_ADDRESS_INVALID_COPY)).toBeGreaterThan(html.indexOf('name="senderAddress"'));
    expect(html.indexOf(PAY_SENDER_ADDRESS_INVALID_COPY)).toBeLessThan(html.indexOf('name="senderDob"'));
    expect(html.indexOf(PAY_SENDER_DOB_INVALID_COPY)).toBeGreaterThan(html.indexOf('name="senderDob"'));
  });
});

describe('PayForm: which body asks', () => {
  it('SimplePayForm (stored destination) asks the shown fields', () => {
    const html = payForm({ originator: BOTH });
    expect(html).toContain('name="senderAddress"');
    expect(html).toContain('name="senderDob"');
  });

  it('BankDetailsPayForm (step 1) asks the shown fields', () => {
    const html = payForm({ originator: ADDRESS_ONLY, needsBankDetails: true });
    expect(html).toContain('Step 1 of 2');
    expect(html).toContain('name="senderAddress"');
    expect(html).not.toContain('name="senderDob"');
  });

  it('on file, not asked, or no prop -> no field (today\'s form)', () => {
    for (const html of [
      payForm({ originator: ON_FILE }),
      payForm({ originator: NONE }),
      payForm({}),
      payForm({ needsBankDetails: true }),
    ]) {
      expect(html).not.toContain('name="senderAddress"');
      expect(html).not.toContain('name="senderDob"');
    }
  });

  it('the ACH (b2b) form never asks, even when told to', () => {
    const html = payForm({ originator: BOTH, fundingMethod: 'ach_pull' });
    expect(html).not.toContain('name="senderAddress"');
    expect(html).not.toContain('name="senderDob"');
  });
});
