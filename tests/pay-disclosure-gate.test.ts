// Fix pack 4 T7 (C10): the R18 gate rule, pure.
import { describe, expect, it } from 'vitest';
import {
  disclosureGateAtRequest,
  disclosureGateRefusal,
  disclosureMandatory,
} from '../src/lib/pay-disclosure-gate';
import type { ResolvedDisclosure } from '../src/lib/partner-config';
import { DISCLOSURE_DRAFT_VERSION, PREVIOUS_DISCLOSURE_VERSIONS } from '../src/lib/legal/disclosure-drafts';

const HASH = 'dh1:' + 'a'.repeat(64);

function disclosure(o: Partial<ResolvedDisclosure> = {}): ResolvedDisclosure {
  return {
    demo: false,
    configured: true,
    licensedEntity: 'Acme Money Services LLC',
    licenseIds: ['NMLS 000000'],
    phone: '+1 800 555 0100',
    website: 'https://acme.example',
    stateRegulator: { name: 'State Department of Financial Services', phone: null, website: null },
    deliveryBusinessDays: 1,
    partnerApproved: true,
    hash: HASH,
    ...o,
  };
}

describe('disclosureMandatory (C10)', () => {
  it('b2b false whatever else; b2c certified true; b2c real money true; b2c neither false', () => {
    for (const ownerCertified of [true, false]) {
      for (const realMoney of [true, false]) {
        expect(disclosureMandatory({ ownerCertified, realMoney, transferType: 'b2b' })).toBe(false);
      }
    }
    expect(disclosureMandatory({ ownerCertified: true, realMoney: false, transferType: 'b2c' })).toBe(true);
    expect(disclosureMandatory({ ownerCertified: false, realMoney: true, transferType: 'b2c' })).toBe(true);
    expect(disclosureMandatory({ ownerCertified: true, realMoney: true, transferType: 'b2c' })).toBe(true);
    expect(disclosureMandatory({ ownerCertified: false, realMoney: false, transferType: 'b2c' })).toBe(false);
  });
});

describe('disclosureGateRefusal (C10)', () => {
  it('not mandatory -> null for every input (null disclosure, no ack, wrong hash)', () => {
    const inputs = [
      { disclosure: null, ackVersion: null, postedHash: null },
      { disclosure: disclosure({ partnerApproved: false }), ackVersion: null, postedHash: null },
      { disclosure: disclosure(), ackVersion: 'junk', postedHash: 'dh1:wrong' },
      { disclosure: disclosure(), ackVersion: DISCLOSURE_DRAFT_VERSION, postedHash: 'dh1:wrong' },
    ];
    for (const i of inputs) expect(disclosureGateRefusal({ mandatory: false, ...i })).toBeNull();
  });

  it('mandatory + disclosure null (owner read error) -> not_available', () => {
    expect(
      disclosureGateRefusal({ mandatory: true, disclosure: null, ackVersion: DISCLOSURE_DRAFT_VERSION, postedHash: null }),
    ).toBe('not_available');
  });

  it('mandatory + unapproved -> not_available, checked BEFORE the ack', () => {
    const d = disclosure({ partnerApproved: false });
    expect(disclosureGateRefusal({ mandatory: true, disclosure: d, ackVersion: DISCLOSURE_DRAFT_VERSION, postedHash: null })).toBe(
      'not_available',
    );
    // an old tab (no ack, stale hash) on an unapproved block still reads not_available
    expect(disclosureGateRefusal({ mandatory: true, disclosure: d, ackVersion: null, postedHash: 'dh1:old' })).toBe('not_available');
  });

  it('mandatory + approved + ackVersion null / junk / unknown version -> reload_required', () => {
    for (const ackVersion of [null, '', 'junk', 'disclosure-v0-unknown']) {
      expect(disclosureGateRefusal({ mandatory: true, disclosure: disclosure(), ackVersion, postedHash: null })).toBe(
        'reload_required',
      );
    }
  });

  it('DISCLOSURE_DRAFT_VERSION and a retained previous version pass the ack check', () => {
    const versions = [DISCLOSURE_DRAFT_VERSION, ...PREVIOUS_DISCLOSURE_VERSIONS];
    for (const ackVersion of versions) {
      expect(disclosureGateRefusal({ mandatory: true, disclosure: disclosure(), ackVersion, postedHash: null })).toBeNull();
    }
  });

  it('mandatory + approved + ack: hash null passes, equal passes, different -> reload_required', () => {
    const base = { mandatory: true, disclosure: disclosure(), ackVersion: DISCLOSURE_DRAFT_VERSION };
    expect(disclosureGateRefusal({ ...base, postedHash: null })).toBeNull();
    expect(disclosureGateRefusal({ ...base, postedHash: HASH })).toBeNull();
    expect(disclosureGateRefusal({ ...base, postedHash: 'dh1:' + 'b'.repeat(64) })).toBe('reload_required');
  });
});

describe('disclosureGateAtRequest (C10)', () => {
  it('not mandatory -> null; mandatory + null or unapproved -> not_available; mandatory + approved -> null', () => {
    expect(disclosureGateAtRequest({ mandatory: false, disclosure: null })).toBeNull();
    expect(disclosureGateAtRequest({ mandatory: false, disclosure: disclosure({ partnerApproved: false }) })).toBeNull();
    expect(disclosureGateAtRequest({ mandatory: true, disclosure: null })).toBe('not_available');
    expect(disclosureGateAtRequest({ mandatory: true, disclosure: disclosure({ partnerApproved: false }) })).toBe('not_available');
    expect(disclosureGateAtRequest({ mandatory: true, disclosure: disclosure() })).toBeNull();
  });
});
