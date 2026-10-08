import { describe, it, expect } from 'vitest';
import {
  COMMISSION_MAX_CENTS,
  findReferralCodeInText,
  formatUsdCents,
  generateReferralCode,
  newReferralPartnerId,
  normalizeReferralCode,
  parseCommissionUsd,
  parsePlumPortalUrl,
  parseReferralPartnerFields,
  parseStatementMonth,
  REFERRAL_CODE_RE,
  referralPortalLink,
  referralStatementCsv,
  referralWhatsAppLink,
} from '@/lib/referrals';

// Batch B4: the pure helpers for referral partners (codes, links, inputs, statement CSV).

describe('referral codes', () => {
  it('normalizeReferralCode accepts REF- plus 6 letters or digits, any case, trimmed', () => {
    expect(normalizeReferralCode('REF-7KQ4MX')).toBe('REF-7KQ4MX');
    expect(normalizeReferralCode(' ref-tana01 ')).toBe('REF-TANA01');
    for (const bad of ['REF-7KQ4M', 'REF-7KQ4MXX', 'REF7KQ4MX', 'XYZ-7KQ4MX', 'REF-7KQ 4M', 'REF-7KQ4M!', '', 42, null, undefined]) {
      expect(normalizeReferralCode(bad), String(bad)).toBeNull();
    }
  });

  it('findReferralCodeInText finds the first standalone code in a message', () => {
    expect(findReferralCodeInText('Hi SmartRemit, my referral code is REF-7KQ4MX.')).toBe('REF-7KQ4MX');
    expect(findReferralCodeInText('ref-abc123 please')).toBe('REF-ABC123');
    expect(findReferralCodeInText('REF-AAAAAA and REF-BBBBBB')).toBe('REF-AAAAAA');
    expect(findReferralCodeInText('send 200 to mom')).toBeNull();
    expect(findReferralCodeInText('XREF-7KQ4MX')).toBeNull(); // not standalone
    expect(findReferralCodeInText('REF-7KQ4MXY')).toBeNull(); // too long
    expect(findReferralCodeInText('')).toBeNull();
  });

  it('generateReferralCode makes a valid code from an unambiguous alphabet', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const c = generateReferralCode();
      expect(c).toMatch(REFERRAL_CODE_RE);
      expect(c.slice(4)).not.toMatch(/[01IO]/);
      seen.add(c);
    }
    expect(seen.size).toBeGreaterThan(190);
  });

  it('newReferralPartnerId is rp_ plus url-safe characters', () => {
    expect(newReferralPartnerId()).toMatch(/^rp_[A-Za-z0-9_-]{12}$/);
  });
});

describe('referral links', () => {
  it('the WhatsApp link is wa.me to the given number with the code in the prefilled text', () => {
    const link = referralWhatsAppLink('REF-7KQ4MX', '15556298293');
    expect(link.startsWith('https://wa.me/15556298293?text=')).toBe(true);
    const text = decodeURIComponent(link.split('?text=')[1]);
    expect(text).toContain('REF-7KQ4MX');
    expect(text).toContain('SmartRemit');
    expect(findReferralCodeInText(text)).toBe('REF-7KQ4MX');
  });

  it('the portal link adds ?ref=<code> to the portal sign-in address', () => {
    expect(referralPortalLink('REF-TANA01', 'https://send.smartremit.ai/portal/login')).toBe(
      'https://send.smartremit.ai/portal/login?ref=REF-TANA01',
    );
  });
});

describe('admin inputs', () => {
  it('parseCommissionUsd: empty is 0; dollars with up to 2 decimals to cents; bounded', () => {
    expect(parseCommissionUsd('')).toEqual({ ok: true, cents: 0 });
    expect(parseCommissionUsd(null)).toEqual({ ok: true, cents: 0 });
    expect(parseCommissionUsd('1')).toEqual({ ok: true, cents: 100 });
    expect(parseCommissionUsd('1.5')).toEqual({ ok: true, cents: 150 });
    expect(parseCommissionUsd(' 0.07 ')).toEqual({ ok: true, cents: 7 });
    expect(parseCommissionUsd(String(COMMISSION_MAX_CENTS / 100))).toEqual({ ok: true, cents: COMMISSION_MAX_CENTS });
    for (const bad of ['-1', '1.234', 'abc', '1e3', String(COMMISSION_MAX_CENTS / 100 + 1), '$1']) {
      expect(parseCommissionUsd(bad).ok, bad).toBe(false);
    }
  });

  it('parseReferralPartnerFields: a clean name is required; contact is optional and bounded', () => {
    expect(parseReferralPartnerFields({ name: ' TANA ', contact: ' events@tana.org ' })).toEqual({
      ok: true, name: 'TANA', contact: 'events@tana.org',
    });
    expect(parseReferralPartnerFields({ name: 'Acme Travel', contact: '' })).toEqual({ ok: true, name: 'Acme Travel', contact: '' });
    expect(parseReferralPartnerFields({ name: '', contact: '' }).ok).toBe(false);
    expect(parseReferralPartnerFields({ name: 'A <b>', contact: '' }).ok).toBe(false);
    expect(parseReferralPartnerFields({ name: 'A', contact: 'x'.repeat(161) }).ok).toBe(false);
    expect(parseReferralPartnerFields({ name: 'A', contact: 'line\nbreak' }).ok).toBe(false);
  });

  it('parsePlumPortalUrl: empty clears; https only; no credentials; bounded', () => {
    expect(parsePlumPortalUrl('')).toEqual({ ok: true, url: null });
    expect(parsePlumPortalUrl('  ')).toEqual({ ok: true, url: null });
    expect(parsePlumPortalUrl('https://smartremit.plum.example/rewards')).toEqual({
      ok: true, url: 'https://smartremit.plum.example/rewards',
    });
    for (const bad of [
      'http://plum.example', 'javascript:alert(1)', 'https://user:pw@plum.example', 'ftp://x', 'not a url',
      `https://plum.example/${'a'.repeat(500)}`, 'https://',
    ]) {
      expect(parsePlumPortalUrl(bad).ok, bad).toBe(false);
    }
  });
});

describe('statement month and CSV', () => {
  const NOW = new Date('2026-10-08T12:00:00Z');

  it('parseStatementMonth: YYYY-MM to a half-open UTC window; default is the current month', () => {
    expect(parseStatementMonth('2026-09', NOW)).toEqual({
      month: '2026-09', from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-10-01T00:00:00Z'),
    });
    expect(parseStatementMonth(undefined, NOW).month).toBe('2026-10');
    expect(parseStatementMonth('2026-12', NOW).to).toEqual(new Date('2027-01-01T00:00:00Z'));
    for (const bad of ['2026-13', '2026-9', 'x', '2026-00']) expect(parseStatementMonth(bad, NOW).month).toBe('2026-10');
  });

  it('formatUsdCents prints dollars with two decimals', () => {
    expect(formatUsdCents(0)).toBe('0.00');
    expect(formatUsdCents(150)).toBe('1.50');
    expect(formatUsdCents(123456)).toBe('1234.56');
  });

  it('the CSV holds only the referral partner name, contact and amounts (formula cells guarded)', () => {
    const csv = referralStatementCsv('2026-09', [
      { name: 'TANA', contact: 'events@tana.org', deliveredCount: 3, commissionCents: 100 },
      { name: '=HYPERLINK("x")', contact: '', deliveredCount: 0, commissionCents: 0 },
    ]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('month,referral_partner,contact,delivered_transfers,commission_per_transfer_usd,commission_total_usd');
    expect(lines[1]).toBe('"2026-09","TANA","events@tana.org",3,"1.00","3.00"');
    expect(lines[2]).toBe('"2026-09","\'=HYPERLINK(""x"")","",0,"0.00","0.00"');
    expect(csv.endsWith('\r\n')).toBe(true);
  });
});
