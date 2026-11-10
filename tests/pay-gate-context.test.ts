/**
 * Fix pack 4 T9 (C12): the pre-verify gate context of the pay and link routes.
 * readPayGateContext reads the owner (never for the default tenant) and the
 * rail's provider type (never for a sandbox transfer), and decides whether the
 * R18 acknowledgement is mandatory. It never throws: anything unexpected is
 * the SAFE context (not mandatory; the authoritative gates still run later).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { freshDb, seedPartner } from './helpers-db';
import { approveDisclosureForTest, certifyPartnerForTest } from './helpers-live';
import { setRailProviderType } from './helpers-sanctions';

let db: Awaited<ReturnType<typeof freshDb>>;

// Reads are observed, and can be made to throw for one partner id only.
const reads = vi.hoisted(() => ({ owner: [] as string[], rail: [] as string[], ownerThrowFor: null as string | null, railThrowFor: null as string | null }));
vi.mock('@/db/repos/partner-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/partner-repo')>();
  return {
    ...real,
    createPartnerRepo: (...a: Parameters<typeof real.createPartnerRepo>) => {
      const r = real.createPartnerRepo(...a);
      return {
        ...r,
        getPartner: async (id: string) => {
          reads.owner.push(id);
          if (reads.ownerThrowFor === id) throw new Error('owner-read-leak postgres://user:pw@host/db');
          return r.getPartner(id);
        },
      };
    },
  };
});
vi.mock('@/db/repos/integrations-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/integrations-repo')>();
  return {
    ...real,
    createIntegrationsRepo: (...a: Parameters<typeof real.createIntegrationsRepo>) => {
      const r = real.createIntegrationsRepo(...a);
      return {
        ...r,
        paymentProviderType: async (id: string) => {
          reads.rail.push(id);
          if (reads.railThrowFor === id) throw new Error('rail-read-leak postgres://user:pw@host/db');
          return r.paymentProviderType(id);
        },
      };
    },
  };
});

import { readPayGateContext, SAFE_PAY_GATE_CONTEXT } from '@/lib/pay-gate-context';
import { resolvePartnerDisclosure } from '@/lib/partner-config';

const ctxFor = (o: Partial<Parameters<typeof readPayGateContext>[1]> = {}) =>
  readPayGateContext(db, { ownerId: 'acme', railPartnerId: 'acme', environment: 'live', transferType: 'b2c', ...o });

beforeEach(async () => {
  db = await freshDb();
  reads.owner = [];
  reads.rail = [];
  reads.ownerThrowFor = null;
  reads.railThrowFor = null;
});

describe('readPayGateContext (C12)', { retry: 0 }, () => {
  it('default owner, no integrations row -> not real money, not mandatory, owner null, ownerReadFailed false; no owner read', async () => {
    const c = await ctxFor({ ownerId: 'default', railPartnerId: 'default' });
    expect(c.owner).toBeNull();
    expect(c.ownerReadFailed).toBe(false);
    expect(c.railProviderType).toBeNull();
    expect(c.realMoneyKnown).toBe(false);
    expect(c.realMoneyForField).toBe(false);
    expect(c.ownerCertified).toBe(false);
    expect(c.mandatory).toBe(false);
    expect(c.disclosure).toEqual(resolvePartnerDisclosure(null));
    expect(c.disclosure?.demo).toBe(true);
    expect(reads.owner).toEqual([]);
  });

  it('certified owner on a mock rail -> ownerCertified, mandatory (not real money)', async () => {
    await seedPartner(db, 'acme');
    await certifyPartnerForTest(db, 'acme');
    await setRailProviderType(db, 'acme', 'mock');
    const c = await ctxFor();
    expect(c.owner?.id).toBe('acme');
    expect(c.ownerCertified).toBe(true);
    expect(c.railProviderType).toBe('mock');
    expect(c.realMoneyKnown).toBe(false);
    expect(c.realMoneyForField).toBe(false);
    expect(c.mandatory).toBe(true);
  });

  it('uncertified owner on http -> realMoneyKnown, realMoneyForField, mandatory', async () => {
    await seedPartner(db, 'acme');
    await setRailProviderType(db, 'acme', 'http');
    const c = await ctxFor();
    expect(c.ownerCertified).toBe(false);
    expect(c.realMoneyKnown).toBe(true);
    expect(c.realMoneyForField).toBe(true);
    expect(c.mandatory).toBe(true);
  });

  it('the rail partner decides real money (routed): owner mock, routed rail http', async () => {
    await seedPartner(db, 'acme');
    await seedPartner(db, 'railp');
    await setRailProviderType(db, 'acme', 'mock');
    await setRailProviderType(db, 'railp', 'http');
    const c = await ctxFor({ railPartnerId: 'railp' });
    expect(reads.rail).toEqual(['railp']);
    expect(c.realMoneyKnown).toBe(true);
    expect(c.mandatory).toBe(true);
  });

  it('non-default owner, rail type read fails -> realMoneyKnown false, realMoneyForField true, mandatory only if certified', async () => {
    await seedPartner(db, 'acme');
    reads.railThrowFor = 'acme';
    const uncertified = await ctxFor();
    expect(uncertified.railProviderType).toBeUndefined();
    expect(uncertified.realMoneyKnown).toBe(false);
    expect(uncertified.realMoneyForField).toBe(true);
    expect(uncertified.mandatory).toBe(false);
    await certifyPartnerForTest(db, 'acme');
    const certified = await ctxFor();
    expect(certified.realMoneyKnown).toBe(false);
    expect(certified.mandatory).toBe(true);
  });

  it('DEFAULT owner, rail type read fails -> realMoneyForField false (critic M3)', async () => {
    reads.railThrowFor = 'default';
    const c = await ctxFor({ ownerId: 'default', railPartnerId: 'default' });
    expect(c.railProviderType).toBeUndefined();
    expect(c.realMoneyKnown).toBe(false);
    expect(c.realMoneyForField).toBe(false);
    expect(c.mandatory).toBe(false);
  });

  it('owner read throws -> ownerReadFailed, owner null, disclosure null, never throws; the log carries no connection string', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seedPartner(db, 'acme');
    await setRailProviderType(db, 'acme', 'http');
    reads.ownerThrowFor = 'acme';
    const c = await ctxFor();
    expect(c.ownerReadFailed).toBe(true);
    expect(c.owner).toBeNull();
    expect(c.disclosure).toBeNull();
    expect(c.ownerCertified).toBe(false);
    expect(c.realMoneyKnown).toBe(true);
    expect(c.mandatory).toBe(true); // real money: the null disclosure then refuses (not_available)
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('postgres://');
    expect(logged).not.toContain('pw@');
    warn.mockRestore();
  });

  it('b2b -> mandatory false, even for a certified owner on http', async () => {
    await seedPartner(db, 'acme');
    await certifyPartnerForTest(db, 'acme');
    await setRailProviderType(db, 'acme', 'http');
    const c = await ctxFor({ transferType: 'b2b' });
    expect(c.ownerCertified).toBe(true);
    expect(c.realMoneyKnown).toBe(true);
    expect(c.mandatory).toBe(false);
  });

  it('test environment -> not real money, and no rail read', async () => {
    await seedPartner(db, 'acme');
    await setRailProviderType(db, 'acme', 'http');
    const c = await ctxFor({ environment: 'test' });
    expect(reads.rail).toEqual([]);
    expect(c.railProviderType).toBeNull();
    expect(c.realMoneyKnown).toBe(false);
    expect(c.realMoneyForField).toBe(false);
    expect(c.mandatory).toBe(false);
  });

  it('a draft (environment undefined) on http is real money', async () => {
    await seedPartner(db, 'acme');
    await setRailProviderType(db, 'acme', 'http');
    const c = await ctxFor({ environment: undefined });
    expect(c.realMoneyKnown).toBe(true);
    expect(c.mandatory).toBe(true);
  });

  it('disclosure = resolvePartnerDisclosure(owner), with partnerApproved and hash from T5', async () => {
    await seedPartner(db, 'acme');
    const before = await ctxFor();
    expect(before.disclosure?.partnerApproved).toBe(false);
    await approveDisclosureForTest(db, 'acme');
    const c = await ctxFor();
    expect(c.disclosure).toEqual(resolvePartnerDisclosure(c.owner));
    expect(c.disclosure?.partnerApproved).toBe(true);
    expect(c.disclosure?.hash).toMatch(/^dh1:[0-9a-f]{64}$/);
  });

  it('no usable db handle (a route spec stub) -> fails soft: not mandatory, never a throw', async () => {
    const c = await readPayGateContext(undefined as unknown as typeof db, {
      ownerId: 'acme', railPartnerId: 'acme', environment: 'live', transferType: 'b2c',
    });
    expect(c.ownerReadFailed).toBe(true);
    expect(c.disclosure).toBeNull();
    expect(c.realMoneyKnown).toBe(false);
    expect(c.mandatory).toBe(false);
  });

  it('SAFE_PAY_GATE_CONTEXT is the contract value', () => {
    expect(SAFE_PAY_GATE_CONTEXT).toEqual({
      owner: null, ownerReadFailed: true, railProviderType: undefined, disclosure: null,
      ownerCertified: false, realMoneyKnown: false, realMoneyForField: false, mandatory: false,
    });
  });
});
