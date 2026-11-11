import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Partner } from '@/lib/types';
import { resolvePartnerDisclosure } from '@/lib/partner-config';
import { addBusinessDays, buildReceiptDisclosure } from '@/lib/remittance-disclosure';
import { ReceiptDisclosureCard } from '@/app/account/receipt/[transferId]/disclosure-card';

// Program-Fix 15 PR B — the receipt's Reg E block (12 CFR 1005.31(b)(2)):
// date available, the provider of record from the partner's own config (demo
// tenant ⇒ the demo note), the state regulator, the CFPB contact, the rights
// summary and, while open, the 30-minute cancellation line. Relative dates only.

const NOW = Date.now();
const FULL = {
  licensedEntity: 'Acme Money Services LLC',
  licenseIds: ['NMLS 000000', 'ST 1'],
  phone: '+1 800 555 0100',
  website: 'https://acme.example',
  stateRegulator: { name: 'State Department of Financial Services', phone: '+1 800 555 0199', website: 'https://regulator.example' },
};
const partner = (over: Partial<Partner>): Partner =>
  ({ id: 'acme', name: 'Acme', countries: ['US'], status: 'active', createdAt: '', updatedAt: '', ...over }) as Partner;

function transfer(over: Record<string, unknown> = {}) {
  return {
    transferType: 'b2c' as const, status: 'paid', amountSource: 100, feeSource: 2.99, totalChargeSource: 102.99,
    sourceCurrency: 'USD', amountInr: 8323.46, destinationCurrency: 'INR', fxRate: 83.23456,
    paidAt: new Date(NOW - 5 * 60_000).toISOString(), ...over,
  };
}

function html(p: Partner | null, over: Record<string, unknown> = {}): string {
  const d = buildReceiptDisclosure(transfer(over), resolvePartnerDisclosure(p), NOW);
  if (!d) throw new Error('expected a disclosure');
  return renderToStaticMarkup(createElement(ReceiptDisclosureCard, { disclosure: d }));
}

describe('ReceiptDisclosureCard', { retry: 0 }, () => {
  it('a configured partner: provider, licences, contacts, regulator, CFPB, rights and links', () => {
    const out = html(partner({ supportConfig: { disclosure: FULL } }));
    for (const s of [
      'Transfer disclosure',
      'Draft disclosure — for counsel review',
      'Date available',
      'On or about',
      'Acme Money Services LLC',
      'NMLS 000000, ST 1',
      '+1 800 555 0100',
      'href="https://acme.example"',
      'State Department of Financial Services',
      'href="https://regulator.example"',
      'Consumer Financial Protection Bureau',
      'href="https://www.consumerfinance.gov/complaint"',
      '855-411-2372',
      'cancel for a full refund within 30 minutes',
      'href="/legal#remittance-rights"',
      'href="/terms"',
      'href="/privacy"',
    ]) {
      expect(out).toContain(s);
    }
    expect(out).not.toContain('Demonstration');
  });

  it('inside the window on a paid transfer: the cancellation line with a time', () => {
    expect(html(partner({ supportConfig: { disclosure: FULL } }))).toMatch(/To cancel, reply in the WhatsApp chat or contact the licensed provider of your transfer before \d{1,2}:\d{2}\s?[AP]M UTC/);
  });

  it('past the window, or delivered: no cancellation line', () => {
    expect(html(null, { paidAt: new Date(NOW - 45 * 60_000).toISOString() })).not.toContain('To cancel,');
    expect(html(null, { status: 'delivered', deliveredAt: new Date(NOW).toISOString() })).not.toContain('To cancel,');
  });

  it('the demo tenant: the demo note, no Provider row, and never SmartRemit', () => {
    const out = html(partner({ id: 'default', name: 'SmartRemit Default', supportConfig: { disclosure: FULL } }));
    expect(out).toContain('(Demonstration: no licensed partner is attached and no real money moves.)');
    expect(out).not.toContain('>Provider<');
    expect(out).not.toContain('Acme Money Services LLC');
    expect(out).not.toMatch(/SmartRemit/);
    expect(out).toContain('855-411-2372'); // the CFPB contact is always shown
    expect(out).not.toMatch(/contact the provider/i); // no provider is named on the demo
    expect(out).toContain('To cancel, reply in the WhatsApp chat'); // inside the window
  });

  it('cancelled or blocked: no date-available estimate, but the rights and CFPB rows stay', () => {
    for (const status of ['cancelled', 'blocked']) {
      const out = html(null, { status });
      expect(out).not.toContain('Date available');
      expect(out).not.toContain('(estimate)');
      expect(out).not.toContain('To cancel,');
      expect(out).toContain('855-411-2372');
      expect(out).toContain('href="/legal#remittance-rights"');
    }
  });

  it('an unconfigured real partner: brand + pending line', () => {
    const out = html(partner({ displayName: 'Bare Remit' }));
    expect(out).toContain('Bare Remit');
    expect(out).toContain('Partner licensing details pending (draft).');
  });

  it('a stored 4 renders the On or about date four business days after paidAt (pack 4 C21)', () => {
    const fmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    const paidAt = new Date(NOW - 5 * 60_000).toISOString();
    const out = html(partner({ supportConfig: { disclosure: { ...FULL, deliveryEstimate: { businessDays: 1 } } } }), {
      paidAt,
      deliveryBusinessDays: 4,
    });
    expect(out).toContain(`On or about ${fmt.format(addBusinessDays(Date.parse(paidAt), 4))} (estimate)`);
  });
});

// Fix pack 4 T18 (C22 b): the optional provider line, inside the card before the rows.
describe('ReceiptDisclosureCard provider line', { retry: 0 }, () => {
  const LINE = 'Payments by Acme Money Services LLC, licensed by State Department of Financial Services';
  const disclosure = () => {
    const d = buildReceiptDisclosure(transfer(), resolvePartnerDisclosure(partner({ supportConfig: { disclosure: FULL } })), NOW);
    if (!d) throw new Error('expected a disclosure');
    return d;
  };

  it('providerLine given -> one provider-line with the exact text, inside the card', () => {
    const out = renderToStaticMarkup(createElement(ReceiptDisclosureCard, { disclosure: disclosure(), providerLine: LINE }));
    expect(out.split('data-testid="provider-line"')).toHaveLength(2);
    expect(out).toMatch(new RegExp(`<p data-testid="provider-line"[^>]*>${LINE}</p>`));
    const line = out.indexOf('data-testid="provider-line"');
    expect(line).toBeGreaterThan(out.indexOf('data-disclosure-version'));
    expect(line).toBeGreaterThan(out.indexOf('Transfer disclosure'));
    expect(line).toBeLessThan(out.indexOf('<dl'));
  });

  it('providerLine undefined, null or empty -> byte-identical to the render without the prop', () => {
    const d = disclosure();
    const base = renderToStaticMarkup(createElement(ReceiptDisclosureCard, { disclosure: d }));
    for (const providerLine of [undefined, null, '']) {
      expect(renderToStaticMarkup(createElement(ReceiptDisclosureCard, { disclosure: d, providerLine }))).toBe(base);
    }
    expect(base).not.toContain('provider-line');
  });
});
