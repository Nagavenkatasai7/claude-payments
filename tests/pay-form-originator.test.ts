/**
 * Fix pack 5 T21b (P19, P31): PayForm's sender address / date-of-birth fields.
 * The repo has no DOM test environment, so the form is checked through its
 * static markup and the pure helpers its two b2c bodies use:
 *   - a field shows only when required and not on file; the ACH (b2b) form never asks;
 *   - the pay body carries senderAddress / senderDob only for a shown field;
 *   - a 400 fieldErrors.senderAddress | senderDob shows the FIXED copy under the field.
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  OriginatorFields,
  PayForm,
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
