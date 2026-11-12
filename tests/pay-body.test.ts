import { describe, it, expect } from 'vitest';
import { parsePayBody, validateAccountHolder } from '@/lib/pay-body';

// Fix pack 4 (C13): one pay-body parser for the transfer, link and B2B routes.
const DH = `dh1:${'a'.repeat(64)}`;

describe('parsePayBody', () => {
  it('non-object input (null, \'x\', 42, [], undefined): action null, otp \'\', every field null, present all false; never throws', () => {
    for (const raw of [null, 'x', 42, [], undefined]) {
      for (const surface of ['transfer', 'link', 'b2b'] as const) {
        expect(parsePayBody(raw, surface), `${JSON.stringify(raw)} ${surface}`).toEqual({
          action: null, otp: '', disclosureVersion: null, disclosureHash: null, accountHolder: null,
          senderAddress: null, senderDob: null, esignConsentVersion: null, riskAck: false,
          country: null, fields: null, ach: null, fundingMethod: null, quoteLockedAt: null,
          present: {
            disclosureVersion: false, disclosureHash: false, accountHolder: false, senderAddress: false, senderDob: false,
            esignConsentVersion: false, riskAck: false,
          },
        });
      }
    }
    const throwing = Object.defineProperty({}, 'otp', { enumerable: true, get() { throw new Error('boom'); } });
    expect(() => parsePayBody(throwing, 'transfer')).not.toThrow();
    expect(parsePayBody(throwing, 'transfer').otp).toBe('');
  });

  it("transfer surface: action only for exactly 'request_otp'; otp digits only; country, fields, ach, disclosureVersion, disclosureHash, accountHolder parsed; fundingMethod and quoteLockedAt null", () => {
    expect(parsePayBody({ action: 'request_otp' }, 'transfer').action).toBe('request_otp');
    expect(parsePayBody({ action: 'REQUEST_OTP' }, 'transfer').action).toBeNull();
    expect(parsePayBody({ otp: 123456 }, 'transfer').otp).toBe('123456');
    expect(parsePayBody({ otp: '12 34-56' }, 'transfer').otp).toBe('123456');
    const ach = { routing: '1', account: '2' };
    const p = parsePayBody({
      country: 'IN', fields: { ifsc: 'X' }, ach, disclosureVersion: 'v1', disclosureHash: DH,
      accountHolder: 'Ana', fundingMethod: 'card', quoteLockedAt: 5,
    }, 'transfer');
    expect(p).toMatchObject({
      country: 'IN', fields: { ifsc: 'X' }, ach, disclosureVersion: 'v1', disclosureHash: DH, accountHolder: 'Ana',
      fundingMethod: null, quoteLockedAt: null,
      present: { disclosureVersion: true, disclosureHash: true, accountHolder: true },
    });
  });

  it('link surface: fundingMethod and quoteLockedAt passed through; country, fields, ach and accountHolder null and not present', () => {
    const p = parsePayBody({
      fundingMethod: 'ach', quoteLockedAt: 1234, country: 'IN', fields: { a: 'b' }, ach: { x: 1 },
      accountHolder: 'Ana', disclosureVersion: 'v1', disclosureHash: DH,
    }, 'link');
    expect(p).toMatchObject({
      fundingMethod: 'ach', quoteLockedAt: 1234, country: null, fields: null, ach: null, accountHolder: null,
      disclosureVersion: 'v1', disclosureHash: DH,
      present: { disclosureVersion: true, disclosureHash: true, accountHolder: false },
    });
  });

  it('b2b surface: country and fields; ach, disclosureVersion, disclosureHash, accountHolder null and not present', () => {
    const p = parsePayBody({
      country: 'IN', fields: { a: 'b' }, ach: { x: 1 }, disclosureVersion: 'v1', disclosureHash: DH, accountHolder: 'Ana',
      fundingMethod: 'ach', quoteLockedAt: 1,
    }, 'b2b');
    expect(p).toEqual({
      action: null, otp: '', country: 'IN', fields: { a: 'b' }, ach: null, disclosureVersion: null, disclosureHash: null,
      accountHolder: null, senderAddress: null, senderDob: null, esignConsentVersion: null, riskAck: false,
      fundingMethod: null, quoteLockedAt: null,
      present: {
        disclosureVersion: false, disclosureHash: false, accountHolder: false, senderAddress: false, senderDob: false,
        esignConsentVersion: false, riskAck: false,
      },
    });
  });

  it('disclosureHash: only /^dh1:[0-9a-f]{64}$/ is kept (uppercase hex, another prefix, 63 chars -> null) while present stays true', () => {
    for (const bad of [`dh1:${'A'.repeat(64)}`, `dh2:${'a'.repeat(64)}`, `dh1:${'a'.repeat(63)}`, 42]) {
      const p = parsePayBody({ disclosureHash: bad }, 'transfer');
      expect(p.disclosureHash, String(bad)).toBeNull();
      expect(p.present.disclosureHash).toBe(true);
    }
    expect(parsePayBody({ disclosureHash: DH }, 'link').disclosureHash).toBe(DH);
  });

  it("accountHolder presence: absent -> present false; '' -> '' and present true; '  Ana  ' -> 'Ana'; a non-string -> null with present true", () => {
    expect(parsePayBody({}, 'transfer')).toMatchObject({ accountHolder: null, present: { accountHolder: false } });
    expect(parsePayBody({ accountHolder: '' }, 'transfer')).toMatchObject({ accountHolder: '', present: { accountHolder: true } });
    expect(parsePayBody({ accountHolder: '  Ana  ' }, 'transfer')).toMatchObject({ accountHolder: 'Ana', present: { accountHolder: true } });
    expect(parsePayBody({ accountHolder: 7 }, 'transfer')).toMatchObject({ accountHolder: null, present: { accountHolder: true } });
  });

  it("fix pack 5 (P19): senderAddress / senderDob presence on transfer AND link: absent -> null, present false; '' -> '' present true; '  1 Test St  ' -> '1 Test St'; a non-string -> null present true", () => {
    for (const surface of ['transfer', 'link'] as const) {
      for (const key of ['senderAddress', 'senderDob'] as const) {
        const tag = `${surface} ${key}`;
        expect(parsePayBody({}, surface), tag).toMatchObject({ [key]: null, present: { [key]: false } });
        expect(parsePayBody({ [key]: '' }, surface), tag).toMatchObject({ [key]: '', present: { [key]: true } });
        expect(parsePayBody({ [key]: '  1 Test St  ' }, surface), tag).toMatchObject({ [key]: '1 Test St', present: { [key]: true } });
        expect(parsePayBody({ [key]: 7 }, surface), tag).toMatchObject({ [key]: null, present: { [key]: true } });
      }
    }
  });

  it('fix pack 5 (P19): b2b never parses senderAddress / senderDob: both null and not present even when posted', () => {
    const p = parsePayBody({ senderAddress: '1 Test St', senderDob: '1990-01-02' }, 'b2b');
    expect(p).toMatchObject({ senderAddress: null, senderDob: null, present: { senderAddress: false, senderDob: false } });
  });

  it("fix pack 6 (P4): esignConsentVersion on transfer AND link: absent -> null, present false; a string -> kept as posted (not trimmed, not validated), present true; '' -> '' present true; a non-string -> null present true", () => {
    for (const surface of ['transfer', 'link'] as const) {
      expect(parsePayBody({}, surface), surface).toMatchObject({ esignConsentVersion: null, present: { esignConsentVersion: false } });
      expect(parsePayBody({ esignConsentVersion: 'esign-v1' }, surface), surface).toMatchObject({
        esignConsentVersion: 'esign-v1', present: { esignConsentVersion: true },
      });
      expect(parsePayBody({ esignConsentVersion: '  any thing  ' }, surface).esignConsentVersion, surface).toBe('  any thing  ');
      expect(parsePayBody({ esignConsentVersion: '' }, surface), surface).toMatchObject({ esignConsentVersion: '', present: { esignConsentVersion: true } });
      for (const bad of [7, true, null, { v: 1 }, ['esign-v1']]) {
        expect(parsePayBody({ esignConsentVersion: bad }, surface), `${surface} ${JSON.stringify(bad)}`).toMatchObject({
          esignConsentVersion: null, present: { esignConsentVersion: true },
        });
      }
    }
  });

  it('fix pack 6 (P4): b2b never parses esignConsentVersion (null, not present) even when posted', () => {
    expect(parsePayBody({ esignConsentVersion: 'esign-v1' }, 'b2b')).toMatchObject({
      esignConsentVersion: null, present: { esignConsentVersion: false },
    });
  });

  it('fix pack 6 (P4, T27): riskAck: transfer only; true only for the boolean true; present tells absent from posted', () => {
    expect(parsePayBody({}, 'transfer')).toMatchObject({ riskAck: false, present: { riskAck: false } });
    expect(parsePayBody({ riskAck: true }, 'transfer')).toMatchObject({ riskAck: true, present: { riskAck: true } });
    for (const bad of ['true', 1, false, null]) {
      expect(parsePayBody({ riskAck: bad }, 'transfer'), JSON.stringify(bad)).toMatchObject({
        riskAck: false, present: { riskAck: true },
      });
    }
    for (const surface of ['link', 'b2b'] as const) {
      expect(parsePayBody({ riskAck: true }, surface), surface).toMatchObject({ riskAck: false, present: { riskAck: false } });
    }
  });

  it('fields keeps only string values of a plain object (an array or a non-object -> null)', () => {
    expect(parsePayBody({ fields: { a: 'x', b: 1, c: null, d: 'y' } }, 'transfer').fields).toEqual({ a: 'x', d: 'y' });
    expect(parsePayBody({ fields: ['x'] }, 'transfer').fields).toBeNull();
    expect(parsePayBody({ fields: 'x' }, 'b2b').fields).toBeNull();
    expect(parsePayBody({ country: 5 }, 'transfer').country).toBeNull();
  });
});

describe('validateAccountHolder', () => {
  it('trims and accepts a clean name up to 80 characters; refuses \'\', whitespace, 81 characters and a name with a control or zero-width character', () => {
    expect(validateAccountHolder('  Priya Sharma  ')).toEqual({ ok: true, name: 'Priya Sharma' });
    expect(validateAccountHolder('a'.repeat(80))).toEqual({ ok: true, name: 'a'.repeat(80) });
    for (const bad of ['', '   ', 'a'.repeat(81), 'Pri\u0007ya', 'Pri​ya']) {
      expect(validateAccountHolder(bad), JSON.stringify(bad)).toEqual({ ok: false });
    }
  });
});
