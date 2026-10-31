import { describe, it, expect } from 'vitest';
import {
  redactSensitive,
  luhnValid,
  abaValid,
  verhoeffValid,
  ibanValid,
  REDACTION_LABELS,
  REDACTION_NOTICES,
  redactionNotice,
} from '@/lib/inbound-redact';
import { newTransferId } from '@/lib/id';

// R49 part 1: card, bank account, routing, IFSC, SSN/ITIN, PAN, Aadhaar and
// IBAN numbers a customer types are hidden BEFORE the text reaches the model,
// Redis, the outbox, the permanent log or the logs. Phones, amounts, dates,
// codes and ids must survive byte for byte: hiding a recipient's phone would
// break the add-recipient flow.

const hidden = (text: string) => redactSensitive(text);

describe('checksums', () => {
  it('Luhn', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('371449635398431')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
  });
  it('ABA routing', () => {
    expect(abaValid('021000021')).toBe(true);
    expect(abaValid('011000015')).toBe(true);
    expect(abaValid('123456789')).toBe(false);
    expect(abaValid('12345678')).toBe(false);
  });
  it('Verhoeff', () => {
    expect(verhoeffValid('2363')).toBe(true);
    expect(verhoeffValid('2364')).toBe(false);
    expect(verhoeffValid('234567890125')).toBe(true);
    expect(verhoeffValid('234567890123')).toBe(false);
  });
  it('IBAN mod-97', () => {
    expect(ibanValid('GB82WEST12345698765432')).toBe(true);
    expect(ibanValid('DE89370400440532013000')).toBe(true);
    expect(ibanValid('GB82WEST12345698765433')).toBe(false);
  });
});

describe('redactSensitive hides sensitive numbers', () => {
  const cases: Array<[string, string, string]> = [
    // [input, expected text, kind]
    ['my card is 4111 1111 1111 1111', `my card is ${REDACTION_LABELS.card}`, 'card'],
    ['4111-1111-1111-1111', REDACTION_LABELS.card, 'card'],
    ['4111111111111111 exp 12/29', `${REDACTION_LABELS.card} exp 12/29`, 'card'],
    ['amex 371449635398431', `amex ${REDACTION_LABELS.card}`, 'card'],
    ['amex 3714 496353 98431', `amex ${REDACTION_LABELS.card}`, 'card'],
    ['mastercard 5500 0055 5555 5559.', `mastercard ${REDACTION_LABELS.card}.`, 'card'],
    ['123-45-6789', REDACTION_LABELS.ssn, 'ssn'],
    ['my SSN is 123 45 6789', `my SSN is ${REDACTION_LABELS.ssn}`, 'ssn'],
    ['ssn 123456789', `ssn ${REDACTION_LABELS.ssn}`, 'ssn'],
    ['my ITIN: 912-70-1234', `my ITIN: ${REDACTION_LABELS.ssn}`, 'ssn'],
    ['PAN ABCDE1234F', `PAN ${REDACTION_LABELS.pan}`, 'pan'],
    ['pan is abcpe1234f', `pan is ${REDACTION_LABELS.pan}`, 'pan'],
    ['2345 6789 0125', REDACTION_LABELS.aadhaar, 'aadhaar'],
    ['2345-6789-0125', REDACTION_LABELS.aadhaar, 'aadhaar'],
    ['my aadhaar 234567890125', `my aadhaar ${REDACTION_LABELS.aadhaar}`, 'aadhaar'],
    ['aadhar card number: 234567890125', `aadhar card number: ${REDACTION_LABELS.aadhaar}`, 'aadhaar'],
    ['मेरा आधार 234567890125 है', `मेरा आधार ${REDACTION_LABELS.aadhaar} है`, 'aadhaar'],
    ['GB82WEST12345698765432', REDACTION_LABELS.iban, 'iban'],
    ['iban: GB82 WEST 1234 5698 7654 32 thanks', `iban: ${REDACTION_LABELS.iban} thanks`, 'iban'],
    ['de89370400440532013000', REDACTION_LABELS.iban, 'iban'],
    ['account 123456', `account ${REDACTION_LABELS.account}`, 'account'],
    ['acct no. 9876543210', `acct no. ${REDACTION_LABELS.account}`, 'account'],
    ['mera khata number 50100123456789 hai', `mera khata number ${REDACTION_LABELS.account} hai`, 'account'],
    ['खाता 50100123456789', `खाता ${REDACTION_LABELS.account}`, 'account'],
    ['acc no: 5010 0123 4567 89', `acc no: ${REDACTION_LABELS.account}`, 'account'],
    ['cuenta 0123456789', `cuenta ${REDACTION_LABELS.account}`, 'account'],
  ];
  for (const [input, expected, kind] of cases) {
    it(`${kind}: ${input}`, () => {
      const r = hidden(input);
      expect(r.text).toBe(expected);
      expect(r.kinds).toContain(kind);
    });
  }

  it('IFSC and the account number in the same message', () => {
    const r = hidden('IFSC HDFC0001234 a/c 50100123456789');
    expect(r.text).toBe(`IFSC ${REDACTION_LABELS.ifsc} a/c ${REDACTION_LABELS.account}`);
    expect(r.kinds).toEqual(['ifsc', 'account']);
  });

  it('a bare account number in a message with an IFSC', () => {
    const r = hidden('details: 50100123456789, hdfc0001234');
    expect(r.text).toBe(`details: ${REDACTION_LABELS.account}, ${REDACTION_LABELS.ifsc}`);
  });

  it('routing and account', () => {
    const r = hidden('routing 021000021 account 123456789');
    expect(r.text).toBe(`routing ${REDACTION_LABELS.routing} account ${REDACTION_LABELS.account}`);
    expect(r.kinds).toEqual(['routing', 'account']);
  });

  it('an account number next to a routing number with no account keyword', () => {
    const r = hidden('ABA 011000015 and 4400123456');
    expect(r.text).toBe(`ABA ${REDACTION_LABELS.routing} and ${REDACTION_LABELS.account}`);
  });

  it('a card number after an amount in the same digit run', () => {
    // "500 4111 1111 1111 1111" is one digit run; the card window inside it is found.
    const r = hidden('pay 500 4111 1111 1111 1111');
    expect(r.text).toBe(`pay 500 ${REDACTION_LABELS.card}`);
  });

  it('several kinds in one message, each label once per number', () => {
    const r = hidden('card 4111111111111111 and ssn 123-45-6789 and PAN ABCPE1234F');
    expect(r.text).toBe(`card ${REDACTION_LABELS.card} and ssn ${REDACTION_LABELS.ssn} and PAN ${REDACTION_LABELS.pan}`);
    expect(r.kinds).toEqual(['card', 'ssn', 'pan']);
  });

  it('is idempotent: a redacted text has nothing left to hide', () => {
    const once = hidden('IFSC HDFC0001234 a/c 50100123456789, card 4111 1111 1111 1111').text;
    const twice = hidden(once);
    expect(twice.text).toBe(once);
    expect(twice.kinds).toEqual([]);
  });

  it('labels carry no digits (the reply guard and the 7-digit log mask never see them as figures)', () => {
    for (const label of Object.values(REDACTION_LABELS)) expect(label).not.toMatch(/\d/);
  });
});

describe('redactSensitive leaves phones, amounts, dates, codes and ids alone', () => {
  const untouched = [
    '+91 98765 43210',
    '919876543210',
    '9876543210',
    '+1 (555) 123-4567',
    '15551234567',
    '+44 7911 123456',
    '+919876543210',
    'send $1,000',
    'send ₹25,000 to mom',
    '1.5 lakh',
    '2500',
    'send 2500 to 919876543210',
    '1,00,000',
    'send ₹1,00,000 please',
    '$12,345.67',
    '2026-10-30',
    '30/10/2026',
    'my code is 123456',
    'REF-AB12CD',
    'REF-TANA01',
    'Her number is +91 98765 43210 and she lives in Pune',
    'send 100000 rupees',
    'the transfer id is 4f9Xk2_mQ8sLp0aZr1bC3w',
    // Luhn-invalid 16 digits, Verhoeff-invalid 4-4-4, ABA-invalid routing.
    '4111 1111 1111 1112',
    '2345 6789 0123',
    'routing 123456789',
    // A 12-digit Indian phone with a country code next to "aadhaar" is not a Verhoeff-valid Aadhaar.
    'my aadhaar is linked to 919876543210',
    // Without a keyword or an IFSC/routing number, a bare digit run is never an account number.
    '50100123456789',
    'my account says pending, my mom is 9876543210',
    'how much is 5000 USD in INR?',
    'error code 131056',
  ];
  for (const text of untouched) {
    it(`unchanged: ${text}`, () => {
      const r = hidden(text);
      expect(r.text).toBe(text);
      expect(r.kinds).toEqual([]);
    });
  }

  it('random 22-character transfer ids survive', () => {
    for (let i = 0; i < 500; i++) {
      const id = newTransferId();
      expect(hidden(`status of ${id}?`).text).toBe(`status of ${id}?`);
    }
  });

  it('a phone in a message with an IFSC is not taken for an account number', () => {
    const r = hidden('IFSC HDFC0001234, her WhatsApp is 919876543210 or 9876543210 or +91 98765 43210');
    expect(r.text).toBe(`IFSC ${REDACTION_LABELS.ifsc}, her WhatsApp is 919876543210 or 9876543210 or +91 98765 43210`);
  });

  it('an amount in a message with an IFSC is not taken for an account number', () => {
    const r = hidden('send ₹10000000 to IFSC HDFC0001234');
    expect(r.text).toBe(`send ₹10000000 to IFSC ${REDACTION_LABELS.ifsc}`);
  });

  it('non-string and empty input', () => {
    expect(redactSensitive('')).toEqual({ text: '', kinds: [] });
    expect(redactSensitive(undefined as unknown as string)).toEqual({ text: '', kinds: [] });
  });

  it('a long hostile message finishes fast', () => {
    const t = performance.now();
    redactSensitive('1 '.repeat(20_000) + 'a/c ' + '9'.repeat(5000) + ' HDFC0001234 '.repeat(500));
    expect(performance.now() - t).toBeLessThan(1500);
  });
});

describe('redaction notice', () => {
  it('one line per language, no digits, points to the secure page', () => {
    for (const lang of ['en', 'hinglish', 'es'] as const) {
      const n = REDACTION_NOTICES[lang];
      expect(n).not.toMatch(/\n/);
      expect(n).not.toMatch(/\d/);
      expect(n.length).toBeLessThanOrEqual(200);
    }
    expect(REDACTION_NOTICES.en).toMatch(/secure/i);
  });
  it('falls back to English', () => {
    expect(redactionNotice('en')).toBe(REDACTION_NOTICES.en);
    expect(redactionNotice('xx' as never)).toBe(REDACTION_NOTICES.en);
  });
});

// Review fixes (PR1): a bounded keyword filler, more separators for cards and
// SSNs, and phones and amounts kept out of the unkeyed rules.
describe('redactSensitive stays fast on hostile keyword fillers (no exponential backtracking)', () => {
  it('an adversarial a/c + "nonono…" segment finishes in under 50 ms', () => {
    const seg = 'a/c' + 'no'.repeat(27) + 'x 1 ';
    redactSensitive('warm up');
    const t = performance.now();
    redactSensitive(seg);
    expect(performance.now() - t).toBeLessThan(50);
  });

  it.each(['a/c', 'ssn', 'uid', 'cvv'])('4,096 characters of repeated %s segments finish in under 250 ms', (kw) => {
    const seg = kw + 'no'.repeat(27) + 'x 1 ';
    const text = seg.repeat(Math.ceil(4096 / seg.length)).slice(0, 4096);
    const t = performance.now();
    redactSensitive(text);
    expect(performance.now() - t).toBeLessThan(250);
  });

  it('the keyword fillers still work', () => {
    expect(hidden('account no. 123456').text).toBe(`account no. ${REDACTION_LABELS.account}`);
    expect(hidden('a/c number is 50100123456789').text).toBe(`a/c number is ${REDACTION_LABELS.account}`);
    expect(hidden('aadhaar card no: 234567890125').text).toBe(`aadhaar card no: ${REDACTION_LABELS.aadhaar}`);
    expect(hidden('cvv no 123').text).toBe(`cvv no ${REDACTION_LABELS.cvv}`);
    expect(hidden('ssn nº 123456789').text).toBe(`ssn nº ${REDACTION_LABELS.ssn}`);
  });
});

describe('redactSensitive hides cards and SSNs written with other separators and digits', () => {
  const cards: Array<[string, string]> = [
    ['my card 4111\n1111\n1111\n1111', 'my card '],
    ['Card: 4111 1111\n1111 1111', 'Card: '],
    ['my card 4111 1111 1111 1111', 'my card '],
    ['my card 4111  1111  1111  1111', 'my card '],
    ['my card 4111 1111 1111 1111', 'my card '],
    ['my card 4111​1111​1111​1111', 'my card '],
    ['my card 4111, 1111, 1111, 1111', 'my card '],
    ['my card 4111.1111.1111.1111', 'my card '],
    ['my card 4111  1111  1111  1111', 'my card '],
    ['my card 4 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1', 'my card '],
    ['my card ４１１１ １１１１ １１１１ １１１１', 'my card '],
    ['my card ४१११ ११११ ११११ ११११', 'my card '],
  ];
  it.each(cards)('card: %j', (input, lead) => {
    const r = hidden(input);
    expect(r.text).toBe(`${lead}${REDACTION_LABELS.card}`);
    expect(r.kinds).toEqual(['card']);
  });

  it.each([
    ['my ssn is 123.45.6789', 'my ssn is '],
    ['my ssn is 123 - 45 - 6789', 'my ssn is '],
    ['ssn 123 45 6789', 'ssn '],
  ])('ssn: %j', (input, lead) => {
    const r = hidden(input);
    expect(r.text).toBe(`${lead}${REDACTION_LABELS.ssn}`);
    expect(r.kinds).toEqual(['ssn']);
  });

  it('acc followed straight by a number is an account keyword', () => {
    expect(hidden('acc 50100123456789').text).toBe(`acc ${REDACTION_LABELS.account}`);
    expect(hidden('according to you 50100123456789').kinds).toEqual([]);
  });

  it('keeps the text around the hidden number byte for byte', () => {
    expect(hidden('card 4111​1111​1111​1111 thanks​!').text).toBe(`card ${REDACTION_LABELS.card} thanks​!`);
    expect(hidden('पहले ४१११ ११११ ११११ ११११ फिर').text).toBe(`पहले ${REDACTION_LABELS.card} फिर`);
  });
});

describe('redactSensitive keeps phones and amounts that sit next to bank details', () => {
  it.each([
    ['routing 021000021, recipient phone 415 555 2671', `routing ${REDACTION_LABELS.routing}, recipient phone 415 555 2671`],
    ['IFSC HDFC0001234 her whatsapp 447911123456', `IFSC ${REDACTION_LABELS.ifsc} her whatsapp 447911123456`],
    ['IFSC HDFC0001234, mobile number: 4155552671', `IFSC ${REDACTION_LABELS.ifsc}, mobile number: 4155552671`],
    ['IFSC HDFC0001234 sent on 20261031', `IFSC ${REDACTION_LABELS.ifsc} sent on 20261031`],
  ])('%j', (input, expected) => {
    expect(hidden(input).text).toBe(expected);
  });

  it.each(['amounts 2000 1500 3000', 'send 500 25 1000', 'pay 2345 6789 0125 rupees', 'amounts: 2000, 1500, 3000', 'send 2000 1500 3000'])(
    'unchanged: %j',
    (text) => {
      const r = hidden(text);
      expect(r.text).toBe(text);
      expect(r.kinds).toEqual([]);
    },
  );

  it('every three-amount list after "amounts" stays whole', () => {
    let changed = 0;
    for (let a = 2000; a <= 3000; a += 100) for (let b = 1000; b <= 2000; b += 100) for (const c of [3000, 4500]) {
      if (hidden(`amounts ${a} ${b} ${c}`).kinds.length > 0) changed++;
    }
    expect(changed).toBe(0);
  });
});
