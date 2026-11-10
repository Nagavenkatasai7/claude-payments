// Fix pack 4 T7 (C16): the one approved provider line, pure.
import { describe, expect, it } from 'vitest';
import { PROVIDER_LINE_TEMPLATE, providerLineFor } from '../src/lib/legal/provider-line';
import { resolvePartnerDisclosure, type ResolvedDisclosure } from '../src/lib/partner-config';
import type { Partner } from '../src/lib/types';
import { approvedDisclosureConfig } from './helpers-live';

const ENTITY = 'Acme Money Services LLC';
const REGULATOR = 'State Department of Financial Services';

function d(o: Partial<ResolvedDisclosure> = {}): ResolvedDisclosure {
  return {
    demo: false,
    configured: true,
    licensedEntity: ENTITY,
    licenseIds: ['NMLS 000000', 'CA 12345'],
    phone: '+1 800 555 0100',
    website: 'https://acme.example',
    stateRegulator: { name: REGULATOR, phone: '+1 800 555 0199', website: 'https://dfs.example' },
    deliveryBusinessDays: 1,
    partnerApproved: true,
    hash: 'dh1:' + 'e'.repeat(64),
    ...o,
  };
}

type PartnerLike = Pick<Partner, 'id' | 'supportConfig' | 'displayName' | 'brandName'>;

describe('providerLineFor (C16)', () => {
  it('PROVIDER_LINE_TEMPLATE is pinned', () => {
    expect(PROVIDER_LINE_TEMPLATE).toBe('Payments by {entity}, licensed by {regulator}');
  });

  it('the template has no SmartRemit', () => {
    expect(PROVIDER_LINE_TEMPLATE).not.toMatch(/smartremit/i);
  });

  it('approved + entity + regulator -> exactly the line', () => {
    expect(providerLineFor(d())).toBe(
      'Payments by Acme Money Services LLC, licensed by State Department of Financial Services',
    );
  });

  it('a real partner with an approved stored block reads the line (resolvePartnerDisclosure)', () => {
    const p: PartnerLike = { id: 'acme', supportConfig: { disclosure: approvedDisclosureConfig() }, displayName: 'Acme', brandName: 'Acme' };
    expect(providerLineFor(resolvePartnerDisclosure(p))).toBe(`Payments by ${ENTITY}, licensed by ${REGULATOR}`);
  });

  it('null for null / undefined, demo, default, pending, unapproved, no regulator, blank values', () => {
    expect(providerLineFor(null)).toBeNull();
    expect(providerLineFor(undefined)).toBeNull();
    expect(providerLineFor(d({ demo: true }))).toBeNull();
    const def: PartnerLike = { id: 'default', supportConfig: { disclosure: approvedDisclosureConfig() }, displayName: 'Default', brandName: 'Default' };
    expect(providerLineFor(resolvePartnerDisclosure(def))).toBeNull();
    expect(providerLineFor(d({ configured: false }))).toBeNull();
    expect(providerLineFor(d({ partnerApproved: false }))).toBeNull();
    expect(providerLineFor(d({ stateRegulator: null }))).toBeNull();
    expect(providerLineFor(d({ licensedEntity: null }))).toBeNull();
    expect(providerLineFor(d({ licensedEntity: ' \n\t ' }))).toBeNull();
    expect(providerLineFor(d({ stateRegulator: { name: '   ', phone: null, website: null } }))).toBeNull();
  });

  it('whitespace is flattened and the ends trimmed', () => {
    const line = providerLineFor(
      d({
        licensedEntity: '  Acme\nMoney \t Services   LLC ',
        stateRegulator: { name: '\tState  Department\r\nof Financial Services  ', phone: null, website: null },
      }),
    );
    expect(line).toBe('Payments by Acme Money Services LLC, licensed by State Department of Financial Services');
  });

  it('never contains a licence id, a phone or a URL even when the block has them', () => {
    const line = providerLineFor(d())!;
    for (const v of ['NMLS', 'CA 12345', '555', 'https://', 'acme.example', 'dfs.example']) {
      expect(line).not.toContain(v);
    }
  });

  it('an entity or regulator naming SmartRemit (any case) -> null', () => {
    expect(providerLineFor(d({ licensedEntity: 'smartremit inc.' }))).toBeNull();
    expect(providerLineFor(d({ licensedEntity: 'SmartRemit Money LLC' }))).toBeNull();
    expect(providerLineFor(d({ stateRegulator: { name: 'SMARTREMIT authority', phone: null, website: null } }))).toBeNull();
  });

  it('a value containing a placeholder is never re-substituted', () => {
    expect(providerLineFor(d({ licensedEntity: 'Acme {regulator}' }))).toBe(
      `Payments by Acme {regulator}, licensed by ${REGULATOR}`,
    );
  });
});
