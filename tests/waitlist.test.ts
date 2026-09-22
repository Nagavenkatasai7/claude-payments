import { describe, it, expect } from 'vitest';
import {
  WAITLIST_CONSENT_TEXT,
  WAITLIST_CONSENT_VERSION,
  WAITLIST_CONSENT_VALUE,
  normalizeEmail,
  toE164,
  parseWaitlistSignup,
  maskEmail,
  initialOf,
  csvCell,
  waitlistCsv,
} from '@/lib/waitlist';
import { WAITLIST_DESTINATIONS, WAITLIST_DESTINATION_CODES, PARTNER_CORRIDORS } from '@/app/landing/corridors';

const ALLOWED = new Set(['IN', 'MX', 'GB']);

function form(fields: Record<string, string | string[]>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) v.forEach((x) => f.append(k, x));
    else f.set(k, v);
  }
  return f;
}

const VALID = {
  full_name: '  Asha Patel ',
  email: 'Asha.Patel@Example.COM',
  phone: '+1 (555) 123-4567',
  location: 'Fairfax, VA',
  destinations: ['IN', 'MX'],
  consent: 'yes',
};

describe('consent constants', () => {
  it('pins the consent copy and its version (stored on every row)', () => {
    expect(WAITLIST_CONSENT_TEXT).toBe(
      'I agree to receive SmartRemit updates by WhatsApp and email. I can opt out anytime.',
    );
    expect(WAITLIST_CONSENT_VERSION).toBe('v1');
  });
});

describe('the destination list is derived from the landing corridor list (no second list)', () => {
  it('is PARTNER_CORRIDORS minus the "Other" escape hatch', () => {
    expect(WAITLIST_DESTINATIONS).toEqual(PARTNER_CORRIDORS.filter((c) => c.value !== 'Other'));
    expect(WAITLIST_DESTINATION_CODES.has('IN')).toBe(true);
    expect(WAITLIST_DESTINATION_CODES.has('Other')).toBe(false);
  });
});

describe('normalizeEmail / toE164', () => {
  it('lowercases and trims email', () => {
    expect(normalizeEmail('  Asha.Patel@Example.COM ')).toBe('asha.patel@example.com');
  });
  it('turns the common US formats into one E.164 string', () => {
    expect(toE164('+1 (555) 123-4567')).toBe('+15551234567');
    expect(toE164('15551234567')).toBe('+15551234567');
    expect(toE164('(555) 123-4567')).toBe('+15551234567'); // 10 digits ⇒ assumed US
    expect(toE164('+91 98765 43210')).toBe('+919876543210');
  });
  it('rejects too-short / too-long / non-numeric input', () => {
    expect(toE164('12-34')).toBeNull();
    expect(toE164('+1234567890123456')).toBeNull(); // 16 digits > E.164 max 15
    expect(toE164('abc')).toBeNull();
    expect(toE164('')).toBeNull();
  });
  it('rejects a leading 0 or 00 outright (trunk prefixes / international dialling prefixes are not E.164)', () => {
    expect(toE164('0044 7911 123456')).toBeNull(); // 00 + UK
    expect(toE164('00919876543210')).toBeNull(); // 00 + IN
    expect(toE164('07911 123456')).toBeNull(); // UK national format
    expect(toE164('0555 123 4567')).toBeNull(); // 11 digits, leading 0
  });
  it('rejects a bare 10-digit number starting with 0 or 1 (not a valid NANP number)', () => {
    expect(toE164('0555123456')).toBeNull();
    expect(toE164('1555123456')).toBeNull();
    expect(toE164('(571) 555-0123')).toBe('+15715550123');
  });
  it('dedupe equivalence: "+1 (571) 555-0123" and "5715550123" normalise to the same E.164', () => {
    expect(toE164('+1 (571) 555-0123')).toBe('+15715550123');
    expect(toE164('5715550123')).toBe('+15715550123');
    expect(toE164('1-571-555-0123')).toBe('+15715550123');
  });
});

describe('parseWaitlistSignup', () => {
  it('accepts a valid form, normalising every field', () => {
    const r = parseWaitlistSignup(form(VALID), ALLOWED);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      fullName: 'Asha Patel',
      email: 'asha.patel@example.com',
      phone: '+15551234567',
      location: 'Fairfax, VA',
      destinations: ['IN', 'MX'],
      utmSource: undefined,
      utmCampaign: undefined,
    });
  });

  it.each([
    ['missing name', { full_name: '' }],
    ['one-char name', { full_name: 'A' }],
    ['bad email', { email: 'nope' }],
    ['bad phone', { phone: '12-34' }],
    ['missing location', { location: '' }],
    ['no destinations', { destinations: [] }],
    ['only unknown destinations', { destinations: ['XX', 'Other'] }],
    ['consent unchecked', { consent: '' }],
    ['consent=no', { consent: 'no' }],
    ['consent=on (not the checkbox value)', { consent: 'on' }],
    ['consent=true', { consent: 'true' }],
    ['consent=YES (case differs)', { consent: 'YES' }],
    ['phone with 00 prefix', { phone: '00919876543210' }],
    ['10-digit phone starting with 1', { phone: '1555123456' }],
  ])('rejects %s', (_label, over) => {
    expect(parseWaitlistSignup(form({ ...VALID, ...over }), ALLOWED).ok).toBe(false);
  });

  it('consent counts ONLY when the value is exactly the checkbox value', () => {
    expect(WAITLIST_CONSENT_VALUE).toBe('yes');
    expect(parseWaitlistSignup(form({ ...VALID, consent: WAITLIST_CONSENT_VALUE }), ALLOWED).ok).toBe(true);
  });

  it('drops destinations outside the allowed set and dedupes', () => {
    const r = parseWaitlistSignup(form({ ...VALID, destinations: ['IN', 'XX', 'IN', 'GB'] }), ALLOWED);
    expect(r.ok && r.value.destinations).toEqual(['IN', 'GB']);
  });

  it('caps lengths at the edge (name 120, email 320, location 120, utm 64)', () => {
    const r = parseWaitlistSignup(
      form({
        ...VALID,
        full_name: 'N'.repeat(500),
        location: 'L'.repeat(500),
        utm_source: 'S'.repeat(500),
        utm_campaign: 'C'.repeat(500),
      }),
      ALLOWED,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.fullName).toHaveLength(120);
    expect(r.value.location).toHaveLength(120);
    expect(r.value.utmSource).toHaveLength(64);
    expect(r.value.utmCampaign).toHaveLength(64);
    expect(parseWaitlistSignup(form({ ...VALID, email: `${'a'.repeat(400)}@x.co` }), ALLOWED).ok).toBe(false);
  });

  it('strips control characters from free text and utm fields', () => {
    const r = parseWaitlistSignup(
      form({ ...VALID, full_name: 'Asha\u0000 Patel\n', location: 'Fair\u0007fax', utm_source: 'news\rletter' }),
      ALLOWED,
    );
    expect(r.ok && r.value.fullName).toBe('Asha Patel');
    expect(r.ok && r.value.location).toBe('Fairfax');
    expect(r.ok && r.value.utmSource).toBe('newsletter');
  });
});

describe('masks (what the admin list shows — never the value)', () => {
  it('maskEmail keeps the first char and the domain', () => {
    expect(maskEmail('asha.patel@gmail.com')).toBe('a***@gmail.com');
    expect(maskEmail('a@b.co')).toBe('a***@b.co');
  });
  it('initialOf is the first letter of the name, upper-cased, with a dot', () => {
    expect(initialOf('asha patel')).toBe('A.');
    expect(initialOf('')).toBe('');
  });
});

describe('CSV export', () => {
  it('quotes cells and neutralises formula-leading characters (= + - @, tab, CR)', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('+15551234567')).toBe("\"'+15551234567\"");
    expect(csvCell('=1+1')).toBe("\"'=1+1\"");
    expect(csvCell('-x')).toBe("\"'-x\"");
    expect(csvCell('@x')).toBe("\"'@x\"");
  });

  it('renders the header + one CRLF row per signup with the decrypted fields', () => {
    const csv = waitlistCsv([
      {
        id: 'wl_1',
        fullName: 'Asha Patel',
        email: 'asha@example.com',
        phone: '+15551234567',
        location: 'Fairfax, VA',
        destinations: ['IN', 'MX'],
        consentAt: '2026-09-21T10:00:00.000Z',
        consentTextVersion: 'v1',
        utmSource: 'x',
        utmCampaign: undefined,
        createdAt: '2026-09-21T10:00:00.000Z',
      },
    ]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(
      'id,full_name,email,phone,location,destinations,consent_at,consent_text_version,utm_source,utm_campaign,created_at',
    );
    expect(lines[1]).toBe(
      'wl_1,Asha Patel,asha@example.com,"\'+15551234567","Fairfax, VA",IN|MX,2026-09-21T10:00:00.000Z,v1,x,,2026-09-21T10:00:00.000Z',
    );
  });
});
