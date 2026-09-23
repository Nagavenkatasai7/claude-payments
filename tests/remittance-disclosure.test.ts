import { describe, it, expect } from 'vitest';
import type { Partner } from '@/lib/types';

// Program-Fix 15 PR B — the Reg E disclosure module (12 CFR 1005.31):
// the per-partner provider resolver, the pre-payment disclosure (pay page) and
// the receipt disclosure. Every label is a DRAFT for counsel. The licensed
// partner is the provider of record; the demo tenant (brand SmartRemit, no
// licensed partner) shows DEMO_NO_PARTNER_NOTE and never names SmartRemit as
// the transmitter. Imports are dynamic so each test fails on its own while red.

const NOW = Date.parse('2026-09-23T12:00:00.000Z');

function partner(over: Partial<Partner> = {}): Partner {
  return {
    id: 'acme', name: 'Acme', countries: ['US'], status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const FULL = {
  licensedEntity: 'Acme Money Services LLC',
  licenseIds: ['NMLS 000000'],
  phone: '+1 800 555 0100',
  website: 'https://acme.example',
  stateRegulator: { name: 'State Department of Financial Services', phone: '+1 800 555 0199', website: 'https://regulator.example' },
  deliveryEstimate: { businessDays: 2 },
};

const cfg = () => import('@/lib/partner-config');
const mod = () => import('@/lib/remittance-disclosure');
const drafts = () => import('@/lib/legal/drafts');
const dd = () => import('@/lib/legal/disclosure-drafts');

describe('resolvePartnerDisclosure', () => {
  it('no partner ⇒ demo: no licensed entity, nothing invented', async () => {
    const { resolvePartnerDisclosure } = await cfg();
    expect(resolvePartnerDisclosure(null)).toEqual({
      demo: true,
      configured: false,
      licensedEntity: null,
      licenseIds: [],
      phone: null,
      website: null,
      stateRegulator: null,
      deliveryBusinessDays: 1,
    });
  });

  it('the default tenant is ALWAYS demo, even with disclosure fields saved on it', async () => {
    const { resolvePartnerDisclosure } = await cfg();
    const r = resolvePartnerDisclosure(partner({ id: 'default', name: 'SmartRemit Default', supportConfig: { disclosure: FULL } }));
    expect(r.demo).toBe(true);
    expect(r.licensedEntity).toBeNull();
    expect(r.configured).toBe(false);
    expect(r.phone).toBeNull();
    expect(r.website).toBeNull();
    expect(r.stateRegulator).toBeNull();
  });

  it('a configured partner resolves every supplied field', async () => {
    const { resolvePartnerDisclosure } = await cfg();
    expect(resolvePartnerDisclosure(partner({ displayName: 'Acme Send', supportConfig: { disclosure: FULL } }))).toEqual({
      demo: false,
      configured: true,
      licensedEntity: 'Acme Money Services LLC',
      licenseIds: ['NMLS 000000'],
      phone: '+1 800 555 0100',
      website: 'https://acme.example',
      stateRegulator: { name: 'State Department of Financial Services', phone: '+1 800 555 0199', website: 'https://regulator.example' },
      deliveryBusinessDays: 2,
    });
  });

  it('an unconfigured real partner falls back to its brand, configured:false', async () => {
    const { resolvePartnerDisclosure } = await cfg();
    const r = resolvePartnerDisclosure(partner({ displayName: 'Acme Send' }));
    expect(r).toMatchObject({ demo: false, configured: false, licensedEntity: 'Acme Send', deliveryBusinessDays: 1 });
  });

  it('an unconfigured real partner with no brand never falls back to "SmartRemit"', async () => {
    const { resolvePartnerDisclosure } = await cfg();
    const r = resolvePartnerDisclosure(partner({}));
    expect(r.licensedEntity).toBeNull();
    expect(r.configured).toBe(false);
    expect(r.demo).toBe(false);
  });

  it('validates the untyped jsonb: non-https URLs, junk types and bad numbers are dropped', async () => {
    const { resolvePartnerDisclosure } = await cfg();
    const junk = {
      licensedEntity: 42,
      licenseIds: 'NMLS 1',
      phone: ['x'],
      website: 'javascript:alert(1)',
      stateRegulator: { name: '', website: 'http://plain.example' },
      deliveryEstimate: { businessDays: 99 },
    } as unknown as NonNullable<Partner['supportConfig']>['disclosure'];
    const r = resolvePartnerDisclosure(partner({ displayName: 'Acme Send', supportConfig: { disclosure: junk } }));
    expect(r).toEqual({
      demo: false,
      configured: false,
      licensedEntity: 'Acme Send',
      licenseIds: [],
      phone: null,
      website: null,
      stateRegulator: null,
      deliveryBusinessDays: 1,
    });
  });

  it('a regulator website that is not https is dropped but the name stays', async () => {
    const { resolvePartnerDisclosure } = await cfg();
    const r = resolvePartnerDisclosure(
      partner({ supportConfig: { disclosure: { ...FULL, stateRegulator: { name: 'Regulator', website: 'http://r.example' } } } }),
    );
    expect(r.stateRegulator).toEqual({ name: 'Regulator', phone: null, website: null });
  });
});

describe('formatFxRate', () => {
  it('shows 2 to 4 decimals, rounded, never more', async () => {
    const { formatFxRate } = await mod();
    expect(formatFxRate(83.2)).toBe('83.20');
    expect(formatFxRate(83.23456)).toBe('83.2346');
    expect(formatFxRate(0.011834)).toBe('0.0118');
    expect(formatFxRate(1)).toBe('1.00');
  });

  it('formats the rate line in the existing "1 SRC = x DEST" convention', async () => {
    const { formatRateLine } = await mod();
    expect(formatRateLine(83.23456, 'USD', 'INR')).toBe('1 USD = 83.2346 INR');
  });
});

const VIEW = {
  transferType: 'b2c' as const,
  sourceAmount: 100,
  sourceFee: 2.99,
  sourceTotalCharge: 102.99,
  sourceCurrency: 'USD',
  destAmount: 8323.46,
  destCurrency: 'INR',
  fxRate: 83.23456,
};

describe('buildPrepaymentDisclosure (§1005.31(b)(1))', () => {
  it('B2B ⇒ null: a business is not a consumer "sender" (§1005.30)', async () => {
    const { buildPrepaymentDisclosure } = await mod();
    const { resolvePartnerDisclosure } = await cfg();
    expect(buildPrepaymentDisclosure({ ...VIEW, transferType: 'b2b' }, resolvePartnerDisclosure(partner({ supportConfig: { disclosure: FULL } })))).toBeNull();
  });

  it('carries every pre-payment field with the amounts it was given (never recomputed)', async () => {
    const { buildPrepaymentDisclosure } = await mod();
    const { resolvePartnerDisclosure } = await cfg();
    const { DISCLOSURE_DRAFT_VERSION, THIRD_PARTY_FEE_STATEMENT } = await dd();
    const d = buildPrepaymentDisclosure(VIEW, resolvePartnerDisclosure(partner({ supportConfig: { disclosure: FULL } })))!;
    expect(d.version).toBe(DISCLOSURE_DRAFT_VERSION);
    expect(d.lines).toEqual([
      { label: 'Transfer amount', value: '$100.00' },
      { label: 'Transfer fees', value: '$2.99' },
      { label: 'Total', value: '$102.99', strong: true },
      { label: 'Exchange rate', value: '1 USD = 83.2346 INR' },
      { label: 'Total to recipient', value: '₹8,323.46', strong: true },
      { label: 'Date available', value: 'Within 2 business days of payment (estimate)' },
    ]);
    expect(d.thirdPartyFeeNote).toBe(THIRD_PARTY_FEE_STATEMENT);
    expect(d.links.map((l) => l.href)).toEqual(['/legal#remittance-rights', '/legal#licensing', '/terms', '/privacy']);
  });

  it('a zero fee is shown as an amount, not hidden', async () => {
    const { buildPrepaymentDisclosure } = await mod();
    const { resolvePartnerDisclosure } = await cfg();
    const d = buildPrepaymentDisclosure({ ...VIEW, sourceFee: 0, sourceTotalCharge: 100 }, resolvePartnerDisclosure(null))!;
    expect(d.lines.find((l) => l.label === 'Transfer fees')?.value).toBe('$0.00');
  });

  it('the demo tenant: provider block is the demo note, never "SmartRemit"', async () => {
    const { buildPrepaymentDisclosure } = await mod();
    const { resolvePartnerDisclosure } = await cfg();
    const { DEMO_NO_PARTNER_NOTE } = await drafts();
    const d = buildPrepaymentDisclosure(VIEW, resolvePartnerDisclosure(partner({ id: 'default' })))!;
    expect(d.provider).toEqual({ kind: 'demo', name: null, note: DEMO_NO_PARTNER_NOTE, licenseIds: [], phone: null, website: null, stateRegulator: null });
    expect(JSON.stringify(d)).not.toMatch(/SmartRemit/);
  });

  it('an unconfigured real partner: its brand plus the pending line', async () => {
    const { buildPrepaymentDisclosure } = await mod();
    const { resolvePartnerDisclosure } = await cfg();
    const { PARTNER_DETAILS_PENDING } = await dd();
    const d = buildPrepaymentDisclosure(VIEW, resolvePartnerDisclosure(partner({ displayName: 'Acme Send' })))!;
    expect(d.provider).toMatchObject({ kind: 'pending', name: 'Acme Send', note: PARTNER_DETAILS_PENDING });
  });

  it('a configured partner: the licensed entity and its contacts, no note', async () => {
    const { buildPrepaymentDisclosure } = await mod();
    const { resolvePartnerDisclosure } = await cfg();
    const d = buildPrepaymentDisclosure(VIEW, resolvePartnerDisclosure(partner({ supportConfig: { disclosure: FULL } })))!;
    expect(d.provider).toEqual({
      kind: 'configured',
      name: 'Acme Money Services LLC',
      note: null,
      licenseIds: ['NMLS 000000'],
      phone: '+1 800 555 0100',
      website: 'https://acme.example',
      stateRegulator: { name: 'State Department of Financial Services', phone: '+1 800 555 0199', website: 'https://regulator.example' },
    });
  });
});

function transfer(over: Record<string, unknown> = {}) {
  return {
    transferType: 'b2c' as const,
    status: 'paid' as const,
    amountSource: 100,
    feeSource: 2.99,
    totalChargeSource: 102.99,
    sourceCurrency: 'USD',
    amountInr: 8323.46,
    destinationCurrency: 'INR',
    fxRate: 83.23456,
    paidAt: new Date(NOW - 10 * 60_000).toISOString(), // relative: 10 minutes ago
    ...over,
  };
}

describe('buildReceiptDisclosure (§1005.31(b)(2))', () => {
  it('B2B ⇒ null', async () => {
    const { buildReceiptDisclosure } = await mod();
    const { resolvePartnerDisclosure } = await cfg();
    expect(buildReceiptDisclosure(transfer({ transferType: 'b2b' }), resolvePartnerDisclosure(null), NOW)).toBeNull();
  });

  it('adds the CFPB contact and the rights summary', async () => {
    const { buildReceiptDisclosure } = await mod();
    const { resolvePartnerDisclosure } = await cfg();
    const { CFPB_CONTACT, RIGHTS_SUMMARY } = await dd();
    const d = buildReceiptDisclosure(transfer(), resolvePartnerDisclosure(partner({ supportConfig: { disclosure: FULL } })), NOW)!;
    expect(d.cfpb).toEqual(CFPB_CONTACT);
    expect(d.rightsSummary).toBe(RIGHTS_SUMMARY);
    expect(d.provider.kind).toBe('configured');
  });

  it('date available is paid date + N business days, skipping the weekend (estimate)', async () => {
    const { buildReceiptDisclosure } = await mod();
    const { resolvePartnerDisclosure } = await cfg();
    // A Friday payment + 1 business day ⇒ Monday.
    const friday = '2026-09-25T15:00:00.000Z';
    const d = buildReceiptDisclosure(transfer({ paidAt: friday }), resolvePartnerDisclosure(null), Date.parse(friday) + 60_000)!;
    expect(d.lines.find((l) => l.label === 'Date available')?.value).toBe('On or about Sep 28, 2026 (estimate)');
  });

  it('a delivered transfer states the delivery date', async () => {
    const { buildReceiptDisclosure } = await mod();
    const { resolvePartnerDisclosure } = await cfg();
    const d = buildReceiptDisclosure(
      transfer({ status: 'delivered', deliveredAt: new Date(NOW - 5 * 60_000).toISOString() }),
      resolvePartnerDisclosure(null),
      NOW,
    )!;
    expect(d.lines.find((l) => l.label === 'Date available')?.value).toBe('Delivered Sep 23, 2026');
  });

  it('an unpaid transfer states the relative estimate', async () => {
    const { buildReceiptDisclosure } = await mod();
    const { resolvePartnerDisclosure } = await cfg();
    const d = buildReceiptDisclosure(transfer({ status: 'awaiting_payment', paidAt: undefined }), resolvePartnerDisclosure(null), NOW)!;
    expect(d.lines.find((l) => l.label === 'Date available')?.value).toBe('Within 1 business day of payment (estimate)');
  });

  it('cancelDeadline = paidAt + 30 min while paid and inside the window; null otherwise', async () => {
    const { buildReceiptDisclosure } = await mod();
    const { resolvePartnerDisclosure } = await cfg();
    const r = resolvePartnerDisclosure(null);
    const paidAt = new Date(NOW - 10 * 60_000).toISOString();
    expect(buildReceiptDisclosure(transfer({ paidAt }), r, NOW)!.cancelDeadline).toBe(new Date(NOW + 20 * 60_000).toISOString());
    expect(buildReceiptDisclosure(transfer({ paidAt: new Date(NOW - 31 * 60_000).toISOString() }), r, NOW)!.cancelDeadline).toBeNull();
    expect(buildReceiptDisclosure(transfer({ status: 'delivered', paidAt }), r, NOW)!.cancelDeadline).toBeNull();
    expect(buildReceiptDisclosure(transfer({ status: 'in_review', paidAt }), r, NOW)!.cancelDeadline).toBeNull();
  });
});

describe('isDisclosureAckVersion (the optional pay POST field)', () => {
  it('accepts ONLY known versions: the current one plus the retained previous ones (review r1)', async () => {
    const { isDisclosureAckVersion } = await mod();
    const { DISCLOSURE_DRAFT_VERSION, PREVIOUS_DISCLOSURE_VERSIONS } = await dd();
    expect(isDisclosureAckVersion(DISCLOSURE_DRAFT_VERSION)).toBe(true);
    for (const v of PREVIOUS_DISCLOSURE_VERSIONS) expect(isDisclosureAckVersion(v)).toBe(true);
    // Well-formed but never shipped ⇒ no ack (an ack must name wording that exists).
    expect(isDisclosureAckVersion('disclosure-draft-2026-10-01')).toBe(false);
    expect(isDisclosureAckVersion('draft-2026-09-23b')).toBe(false); // the legal-pages id, not a disclosure id
  });

  it('refuses junk, non-strings and oversize values', async () => {
    const { isDisclosureAckVersion } = await mod();
    for (const v of [undefined, null, 1, '', ' ', 'x'.repeat(65), 'has space', '<script>', 'ÜBER', { v: 1 }]) {
      expect(isDisclosureAckVersion(v)).toBe(false);
    }
  });
});

describe('disclosureProviderKind (the ack meta)', () => {
  it('maps the resolver to demo | pending | configured', async () => {
    const { disclosureProviderKind } = await mod();
    const { resolvePartnerDisclosure } = await cfg();
    expect(disclosureProviderKind(resolvePartnerDisclosure(null))).toBe('demo');
    expect(disclosureProviderKind(resolvePartnerDisclosure(partner({ id: 'default' })))).toBe('demo');
    expect(disclosureProviderKind(resolvePartnerDisclosure(partner({ displayName: 'Acme Send' })))).toBe('pending');
    expect(disclosureProviderKind(resolvePartnerDisclosure(partner({ supportConfig: { disclosure: FULL } })))).toBe('configured');
  });
});

describe('the disclosure drafts', () => {
  it('claim no sign-off and never name SmartRemit as a licensed transmitter', async () => {
    const d = await dd();
    const text = JSON.stringify(d) + [0, 1, 2].map((n) => d.dateAvailableEstimate(n)).join(' ') + d.cancelWindowLine('3:00 PM');
    expect(text).not.toMatch(/approv/i);
    expect(text).not.toMatch(/smartremit/i);
    expect(d.DISCLOSURE_DRAFT_BADGE).toMatch(/draft/i);
  });
});
