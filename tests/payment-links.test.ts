import { describe, it, expect } from 'vitest';
import {
  LINK_TTL_DAYS,
  isExcelMangledNumber,
  isFormulaLike,
  isLinkTokenShape,
  linkDisplayStatus,
  linkExpiresAt,
  linkPayability,
  linkQuote,
  newLinkToken,
  parseInrAmount,
  parseLinkInput,
  parsePurpose,
} from '@/lib/payment-links';
import { QuoteError } from '@/lib/fx';

// Batch B2: the pure checks behind a payment link (single create and every CSV
// row share parseLinkInput). Amounts are RUPEES (owner answer 7); a USD estimate
// above $500 is a warning (owner answer 8: the first-3-days new-customer cap).

const good = { name: 'Asha Patel', phone: '+1 (415) 555-0100', amount: '25,000', reference: 'INV-2026/001', purpose: 'education' };
const USD_PER_INR = 1 / 85; // ₹85 = $1

describe('parseLinkInput', () => {
  it('accepts a clean row and normalises it', () => {
    const r = parseLinkInput(good, { usdPerInr: USD_PER_INR });
    expect(r).toEqual({
      ok: true,
      value: { customerName: 'Asha Patel', customerPhone: '14155550100', amountInr: 25000, reference: 'INV-2026/001', purpose: 'education' },
      warnings: [],
    });
  });

  it('purpose is required, and must be one of the eight purposes', () => {
    for (const purpose of ['', '   ', undefined, 'groceries']) {
      const r = parseLinkInput({ ...good, purpose }, { usdPerInr: USD_PER_INR });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.errors.purpose).toBeTruthy();
    }
  });

  it('purpose accepts the code or the English label, any case', () => {
    expect(parsePurpose('family_support')).toBe('family_support');
    expect(parsePurpose('Family support')).toBe('family_support');
    expect(parsePurpose(' MEDICAL ')).toBe('medical');
    expect(parsePurpose('drugs')).toBeNull();
  });

  it('name: required, clean, at most 80 characters', () => {
    expect(parseLinkInput({ ...good, name: '' }).ok).toBe(false);
    expect(parseLinkInput({ ...good, name: 'A<script>' }).ok).toBe(false);
    expect(parseLinkInput({ ...good, name: 'x'.repeat(81) }).ok).toBe(false);
  });

  it('phone: an Excel-mangled number is named as such', () => {
    const r = parseLinkInput({ ...good, phone: '1.41556E+10' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.phone).toMatch(/Excel/);
    expect(isExcelMangledNumber('1.41E+10')).toBe(true);
    expect(isExcelMangledNumber('14155550100')).toBe(false);
  });

  it('phone: too short or not a number', () => {
    expect(parseLinkInput({ ...good, phone: '12345' }).ok).toBe(false);
    expect(parseLinkInput({ ...good, phone: 'call me' }).ok).toBe(false);
  });

  it('formula-like cells are refused (= + - @), but a +phone is a phone', () => {
    expect(isFormulaLike('=HYPERLINK("x")')).toBe(true);
    expect(isFormulaLike('@SUM(A1)')).toBe(true);
    expect(isFormulaLike('-2+3')).toBe(true);
    expect(isFormulaLike('+cmd')).toBe(true);
    expect(isFormulaLike('\t=1')).toBe(true);
    expect(isFormulaLike('Asha')).toBe(false);
    for (const field of ['name', 'amount', 'reference', 'purpose'] as const) {
      const r = parseLinkInput({ ...good, [field]: '=1+1' });
      expect(r.ok, field).toBe(false);
      expect(!r.ok && r.errors[field], field).toMatch(/start with/);
    }
    expect(parseLinkInput({ ...good, phone: '=14155550100' }).ok).toBe(false);
    expect(parseLinkInput({ ...good, phone: '+14155550100' }).ok).toBe(true);
  });

  it('reference: the order-reference charset, 1–64 characters', () => {
    expect(parseLinkInput({ ...good, reference: '' }).ok).toBe(false);
    expect(parseLinkInput({ ...good, reference: 'has space' }).ok).toBe(false);
    expect(parseLinkInput({ ...good, reference: 'x'.repeat(65) }).ok).toBe(false);
  });

  it('amount: rupees, commas allowed, at most 2 decimals, positive', () => {
    expect(parseInrAmount('1,50,000')).toBe(150000);
    expect(parseInrAmount('1500.5')).toBe(1500.5);
    expect(parseInrAmount('₹ 2,000')).toBe(2000);
    expect(parseInrAmount('1500.555')).toBeNull();
    expect(parseInrAmount('0')).toBeNull();
    expect(parseInrAmount('abc')).toBeNull();
    expect(parseInrAmount('')).toBeNull();
    expect(parseInrAmount('100000000')).toBeNull(); // over ₹1 crore
  });

  it('amount: the USD estimate must sit inside $10–$2,999', () => {
    expect(parseLinkInput({ ...good, amount: '500' }, { usdPerInr: USD_PER_INR }).ok).toBe(false); // ≈ $5.88
    expect(parseLinkInput({ ...good, amount: '300000' }, { usdPerInr: USD_PER_INR }).ok).toBe(false); // ≈ $3,529
  });

  it('amount above the $500 new-customer daily cap is a WARNING, not an error', () => {
    const r = parseLinkInput({ ...good, amount: '50000' }, { usdPerInr: USD_PER_INR }); // ≈ $588
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/\$500/);
  });

  it('without a rate there is no USD check and no warning', () => {
    expect(parseLinkInput({ ...good, amount: '300000' })).toMatchObject({ ok: true, warnings: [] });
  });
});

describe('tokens and expiry', () => {
  it('a token is 128 random bits, URL-safe, and unique', () => {
    const a = newLinkToken();
    const b = newLinkToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a).not.toBe(b);
    expect(isLinkTokenShape(a)).toBe(true);
    expect(isLinkTokenShape('short')).toBe(false);
    expect(isLinkTokenShape('../../etc/passwd-xxxxxx')).toBe(false);
  });

  it('a link expires 7 days after it is made', () => {
    const now = new Date('2026-10-08T12:00:00Z');
    expect(LINK_TTL_DAYS).toBe(7);
    expect(linkExpiresAt(now).toISOString()).toBe('2026-10-15T12:00:00.000Z');
  });
});

describe('linkPayability / linkDisplayStatus', () => {
  const now = new Date();
  const future = new Date(now.getTime() + 3_600_000);
  const past = new Date(now.getTime() - 1000);

  it('open and unexpired ⇒ open; expired ⇒ inactive', () => {
    expect(linkPayability({ status: 'open', expiresAt: future }, null, now)).toBe('open');
    expect(linkPayability({ status: 'open', expiresAt: past }, null, now)).toBe('inactive');
  });

  it('used with no transfer yet (a crash mid-mint) or an unpaid transfer ⇒ resume', () => {
    expect(linkPayability({ status: 'used', expiresAt: future }, null, now)).toBe('resume');
    expect(linkPayability({ status: 'used', expiresAt: future }, 'awaiting_payment', now)).toBe('resume');
  });

  it('used and paid, cancelled, expired ⇒ inactive', () => {
    expect(linkPayability({ status: 'used', expiresAt: future }, 'paid', now)).toBe('inactive');
    expect(linkPayability({ status: 'used', expiresAt: future }, 'cancelled', now)).toBe('inactive');
    expect(linkPayability({ status: 'used', expiresAt: past }, null, now)).toBe('inactive');
    expect(linkPayability({ status: 'cancelled', expiresAt: future }, null, now)).toBe('inactive');
    expect(linkPayability({ status: 'expired', expiresAt: future }, null, now)).toBe('inactive');
  });

  it('display status for the partner list', () => {
    expect(linkDisplayStatus({ status: 'open', expiresAt: future }, null, now)).toBe('open');
    expect(linkDisplayStatus({ status: 'open', expiresAt: past }, null, now)).toBe('expired');
    expect(linkDisplayStatus({ status: 'expired', expiresAt: past }, null, now)).toBe('expired');
    expect(linkDisplayStatus({ status: 'cancelled', expiresAt: future }, null, now)).toBe('cancelled');
    expect(linkDisplayStatus({ status: 'used', expiresAt: future }, 'delivered', now)).toBe('paid');
    expect(linkDisplayStatus({ status: 'used', expiresAt: future }, 'in_review', now)).toBe('paid');
    expect(linkDisplayStatus({ status: 'used', expiresAt: future }, 'awaiting_payment', now)).toBe('processing');
    expect(linkDisplayStatus({ status: 'used', expiresAt: future }, null, now)).toBe('processing');
    expect(linkDisplayStatus({ status: 'used', expiresAt: future }, 'blocked', now)).toBe('not_paid');
  });
});

describe('linkQuote (the rupee amount is exact)', () => {
  it('the payee gets the exact rupees; USD rounds UP to the cent; flat fee by funding method', () => {
    const q = linkQuote(25000, { toInr: 85 }, 'bank_transfer');
    expect(q.amountInr).toBe(25000);
    expect(q.amountUsd).toBe(294.12); // 294.1176… rounded up
    expect(q.feeUsd).toBe(1.99);
    expect(q.totalChargeUsd).toBe(296.11);
    expect(q.fxRate).toBe(85);
    expect(linkQuote(25000, { toInr: 85 }, 'debit_card').feeUsd).toBe(2.99);
  });

  it('an exact cent stays exact (no spurious round-up)', () => {
    expect(linkQuote(8500, { toInr: 85 }, 'bank_transfer').amountUsd).toBe(100);
  });

  it('refuses outside $10–$2,999', () => {
    expect(() => linkQuote(500, { toInr: 85 }, 'bank_transfer')).toThrow(QuoteError);
    expect(() => linkQuote(300000, { toInr: 85 }, 'bank_transfer')).toThrow(QuoteError);
  });

  it('refuses a bad rate', () => {
    expect(() => linkQuote(25000, { toInr: 0 }, 'bank_transfer')).toThrow(QuoteError);
    expect(() => linkQuote(25000, { toInr: Number.NaN }, 'bank_transfer')).toThrow(QuoteError);
  });
});
