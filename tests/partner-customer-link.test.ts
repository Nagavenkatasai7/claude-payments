import { describe, it, expect, vi, beforeEach } from 'vitest';

const logSpy = vi.hoisted(() => ({ logWarn: vi.fn() }));
vi.mock('@/lib/log', async (orig) => ({ ...(await orig<typeof import('@/lib/log')>()), logWarn: logSpy.logWarn }));

import { partnerCustomerHref, partnerCustomerHrefs, partnerCustomerPath } from '@/app/partner/customer-link';
import { openCustomerRef } from '@/lib/customer-ref';
import { KNOWN_PARTNER_ROLES, type PartnerRole } from '@/lib/partner-access';

// Lost-features restore, review 2.1: the ONE "Open customer" link for /partner (transfer list and
// detail, ticket page). A link only for roles that can open the customer page (admin, agent) and only
// when the customer exists in the SESSION tenant. The href carries a sealed ref, never a phone.
const PHONE = '15551239876';
const OTHER = '15557770000';
const ctx = (role: PartnerRole, partnerId = 'pa') => ({ partnerId, role });

let existing: ReturnType<typeof vi.fn<(partnerId: string, phones: readonly string[]) => Promise<ReadonlySet<string>>>>;
beforeEach(() => {
  logSpy.logWarn.mockClear();
  existing = vi.fn(async (partnerId: string, phones: readonly string[]) =>
    new Set(partnerId === 'pa' ? phones.filter((p) => p === PHONE) : []),
  );
});

const refOf = (href: string) => openCustomerRef(href.slice('/partner/customers/'.length));

describe('partnerCustomerPath', () => {
  it('seals the tenant and phone into the path; no digit run of the phone in the URL', () => {
    const href = partnerCustomerPath('pa', PHONE);
    expect(href.startsWith('/partner/customers/')).toBe(true);
    expect(refOf(href)).toEqual({ partnerId: 'pa', phone: PHONE });
    expect(href).not.toContain(PHONE.slice(-7));
  });
});

describe('partnerCustomerHref', () => {
  it('admin and agent get a link to (session tenant, phone) when the customer exists', async () => {
    for (const role of ['admin', 'agent'] as const) {
      const href = await partnerCustomerHref(ctx(role), PHONE, { existing });
      expect(href, role).not.toBeNull();
      expect(refOf(href!)).toEqual({ partnerId: 'pa', phone: PHONE });
    }
    expect(existing).toHaveBeenCalledWith('pa', [PHONE]);
  });
  it('support and finance never get a link, and nothing is read', async () => {
    for (const role of ['support', 'finance'] as const) expect(await partnerCustomerHref(ctx(role), PHONE, { existing }), role).toBeNull();
    expect(existing).not.toHaveBeenCalled();
  });
  it('no customer row in this tenant → no link (the same phone at another tenant does not count)', async () => {
    expect(await partnerCustomerHref(ctx('admin'), OTHER, { existing })).toBeNull();
    expect(await partnerCustomerHref(ctx('admin', 'pb'), PHONE, { existing })).toBeNull();
  });
  it('an empty or missing phone → no link, nothing read', async () => {
    for (const p of ['', null, undefined]) expect(await partnerCustomerHref(ctx('admin'), p, { existing })).toBeNull();
    expect(existing).not.toHaveBeenCalled();
  });
  it('a failed read → no link (fail closed); the log carries the error name, never the phone', async () => {
    existing.mockRejectedValueOnce(new TypeError(`boom ${PHONE}`));
    expect(await partnerCustomerHref(ctx('admin'), PHONE, { existing })).toBeNull();
    expect(logSpy.logWarn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logSpy.logWarn.mock.calls)).not.toContain(PHONE);
  });
});

describe('partnerCustomerHrefs (the batch form for a list)', () => {
  it('one read for the whole page; links only for existing customers', async () => {
    const map = await partnerCustomerHrefs(ctx('agent'), [PHONE, OTHER, PHONE], { existing });
    expect(existing).toHaveBeenCalledTimes(1);
    expect([...map.keys()]).toEqual([PHONE]);
    expect(refOf(map.get(PHONE)!)).toEqual({ partnerId: 'pa', phone: PHONE });
  });
  it('a caller that already knows which customers exist (its own tenant read) skips the read', async () => {
    const map = await partnerCustomerHrefs(ctx('admin'), [PHONE, OTHER], { known: new Set([OTHER]), existing });
    expect(existing).not.toHaveBeenCalled();
    expect([...map.keys()]).toEqual([OTHER]);
  });
  it('roles without the customer page get an empty map; a failed read gives an empty map', async () => {
    for (const role of KNOWN_PARTNER_ROLES.filter((r) => r !== 'admin' && r !== 'agent')) {
      expect((await partnerCustomerHrefs(ctx(role), [PHONE], { existing })).size, role).toBe(0);
    }
    existing.mockRejectedValueOnce(new Error('down'));
    expect((await partnerCustomerHrefs(ctx('admin'), [PHONE], { existing })).size).toBe(0);
    expect((await partnerCustomerHrefs(ctx('admin'), [], { existing })).size).toBe(0);
  });
});
