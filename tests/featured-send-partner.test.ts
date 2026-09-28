import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { freshDb } from './helpers-db';
import { partners, partnerSites } from '@/db/schema';
import type { Db } from '@/db/client';
import { readFeaturedSendConfig, resolveFeaturedSendPartner } from '@/lib/featured-send-partner';

// Home-Send H1: the home-page "Send with <partner>" button appears ONLY for a valid
// featured partner (env-configured, active, not the demo tenant, with a servable
// partner_sites slug). Every doubt — and every error — resolves to null: no button.

const ENV = (over: Record<string, string | undefined> = {}) => ({ FEATURED_SEND_PARTNER_ID: 'acme', ...over });
const throwingDb = () =>
  new Proxy({}, { get: () => { throw new Error('db down'); } }) as unknown as Db;

describe('readFeaturedSendConfig', () => {
  it('unset or blank partner id ⇒ null', () => {
    expect(readFeaturedSendConfig({})).toBeNull();
    expect(readFeaturedSendConfig({ FEATURED_SEND_PARTNER_ID: '' })).toBeNull();
    expect(readFeaturedSendConfig({ FEATURED_SEND_PARTNER_ID: '   ' })).toBeNull();
  });
  it('mode defaults to test; only the exact value "live" is live', () => {
    expect(readFeaturedSendConfig(ENV())).toEqual({ partnerId: 'acme', mode: 'test' });
    expect(readFeaturedSendConfig(ENV({ FEATURED_SEND_MODE: 'test' }))?.mode).toBe('test');
    expect(readFeaturedSendConfig(ENV({ FEATURED_SEND_MODE: 'live' }))?.mode).toBe('live');
    for (const m of ['LIVE', ' live', 'prod', 'true', '1', '']) {
      expect({ m, mode: readFeaturedSendConfig(ENV({ FEATURED_SEND_MODE: m }))?.mode }).toEqual({ m, mode: 'test' });
    }
  });
  it('trims the partner id', () => {
    expect(readFeaturedSendConfig({ FEATURED_SEND_PARTNER_ID: ' acme ' })?.partnerId).toBe('acme');
  });
});

describe('resolveFeaturedSendPartner', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
    await db.insert(partners).values([
      { id: 'acme', name: 'Acme Internal', displayName: 'Acme Pay', status: 'active' },
      { id: 'off', name: 'Off', displayName: 'Off Pay', status: 'suspended' },
      { id: 'noslug', name: 'No Slug', displayName: 'No Slug Pay', status: 'active' },
      { id: 'nosite', name: 'No Site', displayName: 'No Site Pay', status: 'active' },
    ]);
    await db.insert(partnerSites).values([
      { partnerId: 'acme', slug: 'acme-pay' },
      { partnerId: 'off', slug: 'off-pay' },
      { partnerId: 'noslug', slug: null, accentColor: '#0e7490' },
      { partnerId: 'default', slug: 'demo' },
    ]);
  });
  afterEach(() => vi.restoreAllMocks());

  it('valid partner ⇒ { displayName, slug, mode } (test by default), no legal name when none is configured', async () => {
    expect(await resolveFeaturedSendPartner({ env: ENV(), db })).toEqual({
      displayName: 'Acme Pay',
      slug: 'acme-pay',
      mode: 'test',
    });
    expect(await resolveFeaturedSendPartner({ env: ENV({ FEATURED_SEND_MODE: 'live' }), db })).toEqual({
      displayName: 'Acme Pay',
      slug: 'acme-pay',
      mode: 'live',
    });
  });

  it('carries the configured licensed entity as the legal name, and never the partner id', async () => {
    await db.update(partners).set({ supportConfig: { disclosure: { licensedEntity: 'Acme Money Services LLC' } } });
    const got = await resolveFeaturedSendPartner({ env: ENV(), db });
    expect(got).toEqual({ displayName: 'Acme Pay', legalName: 'Acme Money Services LLC', slug: 'acme-pay', mode: 'test' });
    expect(JSON.stringify(got)).not.toContain('"acme"');
  });

  it('unset env ⇒ null WITHOUT touching the db', async () => {
    expect(await resolveFeaturedSendPartner({ env: {}, db: throwingDb() })).toBeNull();
  });

  it('unknown, inactive, demo, no-site and no-slug partners ⇒ null', async () => {
    for (const id of ['ghost', 'off', 'default', 'nosite', 'noslug']) {
      expect({ id, got: await resolveFeaturedSendPartner({ env: ENV({ FEATURED_SEND_PARTNER_ID: id }), db }) }).toEqual({
        id,
        got: null,
      });
    }
  });

  it('a slug that is not servable ⇒ null (defence in depth over the DB check)', async () => {
    const getSite = vi.fn(async () => ({ slug: 'Bad.Slug', accentColor: null }));
    expect(await resolveFeaturedSendPartner({ env: ENV(), db, getSite })).toBeNull();
    const reserved = vi.fn(async () => ({ slug: 'xn--acme', accentColor: null }));
    expect(await resolveFeaturedSendPartner({ env: ENV(), db, getSite: reserved })).toBeNull();
  });

  it('a db error ⇒ null, logged without throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await resolveFeaturedSendPartner({ env: ENV(), db: throwingDb() })).toBeNull();
    expect(warn.mock.calls.length + error.mock.calls.length).toBe(1);
  });
});
