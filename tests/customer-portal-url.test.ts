import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb } from './helpers-db';
import { partners, partnerSites, partnerPortalSettings } from '@/db/schema';
import type { Db } from '@/db/client';
import {
  CUSTOMER_PORTAL_TTL_MS,
  customerHistoryUrl,
  customerPortalOrigin,
  customerTicketUrl,
  legacyCustomerUrl,
  portalUrl,
  resetCustomerPortalOriginCache,
  resolveCustomerPortalOrigin,
} from '@/lib/customer-portal-url';

// One customer portal (Oct 2): where a partner's live customer portal lives, or null. Every doubt
// (flag off, portal not enabled, partner not active, no or bad slug, any error) is null, so the
// caller keeps the legacy /account behaviour.

const throwingDb = () =>
  new Proxy({}, { get: () => { throw new Error('db down'); } }) as unknown as Db;

describe('resolveCustomerPortalOrigin', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
    await db.insert(partners).values([
      { id: 'acme', name: 'Acme', status: 'active' },
      { id: 'off', name: 'Off', status: 'suspended' },
      { id: 'noportal', name: 'No Portal', status: 'active' },
      { id: 'noslug', name: 'No Slug', status: 'active' },
      { id: 'nosite', name: 'No Site', status: 'active' },
    ]);
    await db.insert(partnerSites).values([
      { partnerId: 'acme', slug: 'acme-pay' },
      { partnerId: 'off', slug: 'off-pay' },
      { partnerId: 'noportal', slug: 'no-portal' },
      { partnerId: 'noslug', slug: null },
      { partnerId: 'default', slug: 'send' },
    ]);
    const on = new Date('2026-09-30T00:00:00Z');
    await db.insert(partnerPortalSettings).values([
      { partnerId: 'acme', portalEnabledAt: on },
      { partnerId: 'off', portalEnabledAt: on },
      { partnerId: 'noportal', portalEnabledAt: null },
      { partnerId: 'noslug', portalEnabledAt: on },
      { partnerId: 'nosite', portalEnabledAt: on },
      { partnerId: 'default', portalEnabledAt: on },
    ]);
  });

  it('an enabled, active partner with a slug ⇒ its portal origin', async () => {
    expect(await resolveCustomerPortalOrigin('acme', { enabled: true, db })).toBe('https://acme-pay.smartremit.ai');
    expect(await resolveCustomerPortalOrigin('default', { enabled: true, db })).toBe('https://send.smartremit.ai');
  });

  it('the global portal flag off ⇒ null, with no database read', async () => {
    expect(await resolveCustomerPortalOrigin('acme', { enabled: false, db: throwingDb() })).toBeNull();
  });

  it('portal not enabled, partner suspended, no slug, no site row, unknown partner ⇒ null', async () => {
    for (const id of ['noportal', 'off', 'noslug', 'nosite', 'ghost']) {
      expect({ id, origin: await resolveCustomerPortalOrigin(id, { enabled: true, db }) }).toEqual({ id, origin: null });
    }
  });

  it('a database error ⇒ null (fail back to /account), never a throw', async () => {
    expect(await resolveCustomerPortalOrigin('acme', { enabled: true, db: throwingDb() })).toBeNull();
  });
});

describe('customerPortalOrigin (memo)', () => {
  beforeEach(() => resetCustomerPortalOriginCache());

  it('memoises per partner for the TTL, then resolves again', async () => {
    let calls = 0;
    const resolve = async (id: string) => {
      calls++;
      return id === 'acme' ? 'https://acme-pay.smartremit.ai' : null;
    };
    let t = 1_000;
    const now = () => t;
    expect(await customerPortalOrigin('acme', { resolve, now })).toBe('https://acme-pay.smartremit.ai');
    expect(await customerPortalOrigin('acme', { resolve, now })).toBe('https://acme-pay.smartremit.ai');
    expect(await customerPortalOrigin('other', { resolve, now })).toBeNull();
    expect(calls).toBe(2);
    t += CUSTOMER_PORTAL_TTL_MS;
    await customerPortalOrigin('acme', { resolve, now });
    expect(calls).toBe(3);
  });
});

describe('URL builders', () => {
  it('portalUrl joins an origin and a /portal path', () => {
    expect(portalUrl('https://send.smartremit.ai', '/portal/transfers')).toBe('https://send.smartremit.ai/portal/transfers');
  });

  it('legacyCustomerUrl is the apex /account path', () => {
    expect(legacyCustomerUrl('https://smartremit.ai', '/account/history')).toBe('https://smartremit.ai/account/history');
  });

  it('customerHistoryUrl: portal transfers when live, else /account/history', async () => {
    const live = async () => 'https://acme-pay.smartremit.ai';
    const dark = async () => null;
    expect(await customerHistoryUrl('acme', { origin: live, appBaseUrl: 'https://smartremit.ai' })).toBe(
      'https://acme-pay.smartremit.ai/portal/transfers',
    );
    expect(await customerHistoryUrl('acme', { origin: dark, appBaseUrl: 'https://smartremit.ai' })).toBe(
      'https://smartremit.ai/account/history',
    );
  });

  it('customerTicketUrl: portal ticket when live, else /account/support/<id>; the id is encoded', async () => {
    const live = async () => 'https://acme-pay.smartremit.ai';
    const dark = async () => null;
    expect(await customerTicketUrl('acme', 'T1abc', { origin: live, appBaseUrl: 'https://smartremit.ai' })).toBe(
      'https://acme-pay.smartremit.ai/portal/help/tickets/T1abc',
    );
    expect(await customerTicketUrl('acme', 'T1abc', { origin: dark, appBaseUrl: 'https://smartremit.ai' })).toBe(
      'https://smartremit.ai/account/support/T1abc',
    );
    expect(await customerTicketUrl('acme', 'a/b?c', { origin: live, appBaseUrl: 'https://smartremit.ai' })).toBe(
      'https://acme-pay.smartremit.ai/portal/help/tickets/a%2Fb%3Fc',
    );
  });
});
