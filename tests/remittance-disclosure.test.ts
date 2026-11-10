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
      partnerApproved: false,
      hash: null,
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
      partnerApproved: false,
      hash: expect.stringMatching(/^dh1:[0-9a-f]{64}$/),
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
      partnerApproved: false,
      hash: expect.stringMatching(/^dh1:[0-9a-f]{64}$/),
    });
  });

  // Fix pack 4 T5 (C11): the approval stamp. A block is partner-approved only when it is
  // configured (a licensed entity) and its stamp's hash equals the stored block's hash.
  it('a block whose approval.hash equals its hash is partnerApproved; an edited block (hash mismatch) is not', async () => {
    const { resolvePartnerDisclosure } = await cfg();
    const { disclosureHash } = await import('@/lib/disclosure-hash');
    const approval = { by: 'acme.admin', at: new Date().toISOString(), hash: disclosureHash(FULL) };
    const ok = resolvePartnerDisclosure(partner({ supportConfig: { disclosure: { ...FULL, approval } } }));
    expect(ok.partnerApproved).toBe(true);
    expect(ok.hash).toBe(disclosureHash(FULL));
    const edited = resolvePartnerDisclosure(partner({ supportConfig: { disclosure: { ...FULL, phone: '+1 800 555 0101', approval } } }));
    expect(edited.partnerApproved).toBe(false);
    expect(edited.hash).not.toBe(approval.hash);
  });

  it('an approved stamp on an UNCONFIGURED block (no entity) is not approved', async () => {
    const { resolvePartnerDisclosure } = await cfg();
    const { disclosureHash } = await import('@/lib/disclosure-hash');
    const block = { phone: '+1 800 555 0100' };
    const r = resolvePartnerDisclosure(
      partner({ displayName: 'Acme Send', supportConfig: { disclosure: { ...block, approval: { by: 'a', at: new Date().toISOString(), hash: disclosureHash(block) } } } }),
    );
    expect(r.configured).toBe(false);
    expect(r.partnerApproved).toBe(false);
    expect(r.hash).toBe(disclosureHash(block));
  });

  it('the default tenant with a stamped block is never approved and its hash is null', async () => {
    const { resolvePartnerDisclosure } = await cfg();
    const { disclosureHash } = await import('@/lib/disclosure-hash');
    const approval = { by: 'x', at: new Date().toISOString(), hash: disclosureHash(FULL) };
    const r = resolvePartnerDisclosure(partner({ id: 'default', supportConfig: { disclosure: { ...FULL, approval } } }));
    expect(r.partnerApproved).toBe(false);
    expect(r.hash).toBeNull();
  });

  it('no stored block gives hash null and not approved', async () => {
    const { resolvePartnerDisclosure } = await cfg();
    const r = resolvePartnerDisclosure(partner({ displayName: 'Acme Send' }));
    expect(r.hash).toBeNull();
    expect(r.partnerApproved).toBe(false);
  });

  it('a malformed approval (not an object, hash not a string) reads as not approved', async () => {
    const { resolvePartnerDisclosure } = await cfg();
    const { disclosureHash } = await import('@/lib/disclosure-hash');
    const h = disclosureHash(FULL);
    for (const approval of [h, 42, null, ['x'], { hash: 7 }, { hash: { h } }, {}]) {
      const disclosure = { ...FULL, approval } as unknown as NonNullable<Partner['supportConfig']>['disclosure'];
      const r = resolvePartnerDisclosure(partner({ supportConfig: { disclosure } }));
      expect(r.partnerApproved).toBe(false);
      expect(r.hash).toBe(h);
    }
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

// Fix pack 4 (C16, landed by T2 because the transfer repo is typed by it): the stored
// disclosure snapshot's parser. Pure; never throws; returns a fresh object with V1 keys only.
describe('parseDisclosureSnapshot (fix pack 4, C16)', () => {
  const ACK_AT = new Date(Date.now() - 60_000).toISOString();
  const full = () => ({
    v: 1,
    version: 'draft-2026-09',
    configHash: 'abc123',
    shownHash: null,
    figures: {
      amountSource: 100, feeSource: 2.99, totalChargeSource: 102.99, sourceCurrency: 'USD',
      amountDest: 8350.5, destinationCurrency: 'INR', fxRate: 83.505,
    },
    provider: {
      kind: 'configured', licensedEntity: 'Acme Money Services LLC', licenceIds: ['NMLS 000000'],
      phone: '+1 800 555 0100', website: 'https://acme.example', regulator: 'State Dept', approved: true,
    },
    deliveryBusinessDays: 2,
    dateAvailable: 'on or about 2 business days',
    acknowledgedAt: ACK_AT,
    surface: 'transfer',
  });

  it('accepts a full V1 object and returns a fresh object with only V1 keys', async () => {
    const { parseDisclosureSnapshot } = await import('@/lib/remittance-disclosure');
    const raw = { ...full(), extra: 'x', figures: { ...full().figures, junk: 1 }, provider: { ...full().provider, more: 2 } };
    const out = parseDisclosureSnapshot(raw);
    expect(out).toEqual(full());
    expect(out).not.toBe(raw);
    expect(out!.figures).not.toBe(raw.figures);
    expect(out!.provider.licenceIds).not.toBe(raw.provider.licenceIds);
    expect(out).not.toHaveProperty('extra');
    expect(out!.figures).not.toHaveProperty('junk');
    expect(out!.provider).not.toHaveProperty('more');
  });

  it('accepts the demo / pending kinds, the link surface, null provider fields and 0 delivery days', async () => {
    const { parseDisclosureSnapshot } = await import('@/lib/remittance-disclosure');
    const s = { ...full(), surface: 'link', deliveryBusinessDays: 0, configHash: null,
      provider: { kind: 'demo', licensedEntity: null, licenceIds: [], phone: null, website: null, regulator: null, approved: false } };
    expect(parseDisclosureSnapshot(s)).toEqual(s);
    expect(parseDisclosureSnapshot({ ...full(), provider: { ...full().provider, kind: 'pending' } })?.provider.kind).toBe('pending');
  });

  it.each<[string, (s: Record<string, unknown>) => unknown]>([
    ['v !== 1', (s) => ({ ...s, v: 2 })],
    ['v as a string', (s) => ({ ...s, v: '1' })],
    ['an empty version', (s) => ({ ...s, version: '' })],
    ['a numeric configHash', (s) => ({ ...s, configHash: 5 })],
    ['a missing figure', (s) => { const f = { ...(s.figures as object) } as Record<string, unknown>; delete f.fxRate; return { ...s, figures: f }; }],
    ['a non-finite number', (s) => ({ ...s, figures: { ...(s.figures as object), amountSource: Number.POSITIVE_INFINITY } })],
    ['a NaN figure', (s) => ({ ...s, figures: { ...(s.figures as object), feeSource: Number.NaN } })],
    ['a numeric currency', (s) => ({ ...s, figures: { ...(s.figures as object), sourceCurrency: 840 } })],
    ['a bad provider kind', (s) => ({ ...s, provider: { ...(s.provider as object), kind: 'licensed' } })],
    ['a non-string licence id', (s) => ({ ...s, provider: { ...(s.provider as object), licenceIds: [1] } })],
    ['a non-boolean approved', (s) => ({ ...s, provider: { ...(s.provider as object), approved: 'yes' } })],
    ['a missing provider', (s) => { const c = { ...s }; delete c.provider; return c; }],
    ['fractional delivery days', (s) => ({ ...s, deliveryBusinessDays: 1.5 })],
    ['delivery days above 10', (s) => ({ ...s, deliveryBusinessDays: 11 })],
    ['negative delivery days', (s) => ({ ...s, deliveryBusinessDays: -1 })],
    ['a non-date acknowledgedAt', (s) => ({ ...s, acknowledgedAt: 'yesterday-ish' })],
    ['a numeric dateAvailable', (s) => ({ ...s, dateAvailable: 3 })],
    ['a bad surface', (s) => ({ ...s, surface: 'portal' })],
  ])('returns null for %s', async (_n, mutate) => {
    const { parseDisclosureSnapshot } = await import('@/lib/remittance-disclosure');
    expect(parseDisclosureSnapshot(mutate(full() as unknown as Record<string, unknown>))).toBeNull();
  });

  it('returns null for non-object input and never throws', async () => {
    const { parseDisclosureSnapshot } = await import('@/lib/remittance-disclosure');
    for (const raw of [null, undefined, 1, 'x', true, [], [full()]]) {
      expect(parseDisclosureSnapshot(raw)).toBeNull();
    }
    const hostile = { get v() { throw new Error('boom'); } };
    expect(() => parseDisclosureSnapshot(hostile)).not.toThrow();
    expect(parseDisclosureSnapshot(hostile)).toBeNull();
  });
});
