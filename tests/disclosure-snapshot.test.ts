// Fix pack 4 T7 (C16): the per-payment disclosure snapshot builder, pure.
import { describe, expect, it } from 'vitest';
import {
  buildDisclosureSnapshot,
  disclosureProviderKind,
  parseDisclosureSnapshot,
} from '../src/lib/remittance-disclosure';
import type { ResolvedDisclosure } from '../src/lib/partner-config';
import type { Transfer } from '../src/lib/types';
import type { DisclosureSnapshotInput } from '../src/lib/payment-evidence';
import { DISCLOSURE_DRAFT_VERSION, dateAvailableEstimate } from '../src/lib/legal/disclosure-drafts';

const NOW = Date.now();
const HASH = 'dh1:' + 'c'.repeat(64);
const SHOWN = 'dh1:' + 'd'.repeat(64);

function transfer(o: Partial<Transfer> = {}): Transfer {
  return {
    id: 'tx_snap_0001',
    phone: '+15551230001',
    amountUsd: 100,
    feeUsd: 5,
    totalChargeUsd: 105,
    fxRate: 83.505,
    amountInr: 8350.5,
    recipientName: 'Priya Sharma',
    recipientPhone: '+919876543210',
    payoutMethod: 'bank',
    payoutDestination: '000011112222 HDFC0000001',
    fundingMethod: 'card',
    complianceStatus: 'cleared',
    complianceReasons: [],
    status: 'awaiting_payment',
    createdAt: new Date(NOW - 5 * 60_000).toISOString(),
    sourceCountry: 'US',
    sourceCurrency: 'USD',
    destinationCountry: 'IN',
    destinationCurrency: 'INR',
    partnerId: 'acme',
    amountSource: 100,
    feeSource: 5,
    totalChargeSource: 105,
    ...o,
  } as Transfer;
}

function disclosure(o: Partial<ResolvedDisclosure> = {}): ResolvedDisclosure {
  return {
    demo: false,
    configured: true,
    licensedEntity: 'Acme Money Services LLC',
    licenseIds: ['NMLS 000000', 'CA 12345', 'NY 67890'],
    phone: '+1 800 555 0100',
    website: 'https://acme.example',
    stateRegulator: { name: 'State Department of Financial Services', phone: '+1 800 555 0199', website: 'https://dfs.example' },
    deliveryBusinessDays: 1,
    partnerApproved: true,
    hash: HASH,
    ...o,
  };
}

const ACKED_AT = NOW - 30_000;
function input(o: Partial<DisclosureSnapshotInput> = {}): DisclosureSnapshotInput {
  return { surface: 'transfer', version: DISCLOSURE_DRAFT_VERSION, shownHash: SHOWN, acknowledgedAt: ACKED_AT, ...o };
}

const build = (t = transfer(), d = disclosure(), i = input()) =>
  buildDisclosureSnapshot({ transfer: t, disclosure: d, input: i, now: NOW });

describe('buildDisclosureSnapshot (C16)', () => {
  it('figures come from the transfer', () => {
    const snap = build(
      transfer({ amountSource: 200, feeSource: 7.5, totalChargeSource: 207.5, sourceCurrency: 'USD', amountInr: 16701, destinationCurrency: 'INR', fxRate: 83.505 }),
    );
    expect(snap.figures).toEqual({
      amountSource: 200,
      feeSource: 7.5,
      totalChargeSource: 207.5,
      sourceCurrency: 'USD',
      amountDest: 16701,
      destinationCurrency: 'INR',
      fxRate: 83.505,
    });
  });

  it('provider: kind via the providerBlock rule and the configured details', () => {
    const d = disclosure();
    const snap = build(transfer(), d);
    expect(snap.provider).toEqual({
      kind: 'configured',
      licensedEntity: 'Acme Money Services LLC',
      licenceIds: ['NMLS 000000', 'CA 12345', 'NY 67890'],
      phone: '+1 800 555 0100',
      website: 'https://acme.example',
      regulator: 'State Department of Financial Services',
      approved: true,
    });
    expect(snap.provider.kind).toBe(disclosureProviderKind(d));
  });

  it('provider: no regulator -> null; unapproved -> approved false', () => {
    const snap = build(transfer(), disclosure({ stateRegulator: null, partnerApproved: false }));
    expect(snap.provider.regulator).toBeNull();
    expect(snap.provider.approved).toBe(false);
  });

  it('demo -> kind demo, entity null; pending -> kind pending', () => {
    const demo = disclosure({ demo: true, configured: false, licensedEntity: null, licenseIds: [], phone: null, website: null, stateRegulator: null, partnerApproved: false, hash: null });
    const sd = build(transfer(), demo);
    expect(sd.provider).toEqual({ kind: 'demo', licensedEntity: null, licenceIds: [], phone: null, website: null, regulator: null, approved: false });
    expect(sd.configHash).toBeNull();
    const pending = disclosure({ configured: false, licensedEntity: 'Acme', partnerApproved: false });
    const sp = build(transfer(), pending);
    expect(sp.provider.kind).toBe('pending');
    expect(sp.provider.kind).toBe(disclosureProviderKind(pending));
    expect(sp.provider.licensedEntity).toBe('Acme');
  });

  it('configHash = d.hash; shownHash, version and surface from input; v = 1', () => {
    const snap = build(transfer(), disclosure(), input({ surface: 'link', shownHash: null, version: 'some-version' }));
    expect(snap.v).toBe(1);
    expect(snap.configHash).toBe(HASH);
    expect(snap.shownHash).toBeNull();
    expect(snap.version).toBe('some-version');
    expect(snap.surface).toBe('link');
    expect(build().shownHash).toBe(SHOWN);
    expect(build().surface).toBe('transfer');
  });

  it('deliveryBusinessDays: stored 3 wins over the partner 1; stored 0 stays 0; absent -> the partner value', () => {
    const d = disclosure({ deliveryBusinessDays: 1 });
    const s3 = build(transfer({ deliveryBusinessDays: 3 }), d);
    expect(s3.deliveryBusinessDays).toBe(3);
    expect(s3.dateAvailable).toBe(dateAvailableEstimate(3));
    const s0 = build(transfer({ deliveryBusinessDays: 0 }), d);
    expect(s0.deliveryBusinessDays).toBe(0);
    expect(s0.dateAvailable).toBe(dateAvailableEstimate(0));
    const sAbsent = build(transfer(), disclosure({ deliveryBusinessDays: 2 }));
    expect(sAbsent.deliveryBusinessDays).toBe(2);
    expect(sAbsent.dateAvailable).toBe(dateAvailableEstimate(2));
  });

  it('acknowledgedAt is the ISO of input.acknowledgedAt; a non-finite one falls back to now', () => {
    expect(build().acknowledgedAt).toBe(new Date(ACKED_AT).toISOString());
    expect(build(transfer(), disclosure(), input({ acknowledgedAt: Number.NaN })).acknowledgedAt).toBe(new Date(NOW).toISOString());
    expect(build(transfer(), disclosure(), input({ acknowledgedAt: Number.POSITIVE_INFINITY })).acknowledgedAt).toBe(
      new Date(NOW).toISOString(),
    );
  });

  it('holds no customer data and stays under 2048 bytes with three licence ids', () => {
    const t = transfer();
    const json = JSON.stringify(build(t));
    for (const v of [t.recipientName, t.phone, t.recipientPhone, t.payoutDestination, '****2222', '0001']) {
      expect(json).not.toContain(v);
    }
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThan(2048);
  });

  it('round trips through parseDisclosureSnapshot and through JSON (the jsonb round trip)', () => {
    for (const snap of [build(), build(transfer({ deliveryBusinessDays: 0 }), disclosure({ stateRegulator: null }))]) {
      expect(parseDisclosureSnapshot(snap)).toEqual(snap);
      expect(parseDisclosureSnapshot(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
    }
  });

  it('destinationCurrency falls back to INR when the row has none', () => {
    const t = transfer();
    delete (t as Partial<Transfer>).destinationCurrency;
    expect(build(t).figures.destinationCurrency).toBe('INR');
  });
});
