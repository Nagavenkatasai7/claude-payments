import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// UI redesign M3-14: /partner/integrations/api-keys. Admin only (finance → /partner); the SESSION
// tenant's keys only; no plaintext and no key hash ever reach the HTML (a key is shown once, from
// the create action's result, never from the page); the live option is locked before go-live;
// viewing writes nothing.

const redis = fakeRedis();
let db: Db;
const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers({ host: 'smartremit.ai' }),
}));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error('REDIRECT:' + p);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => actual.createPartnerStore(db) };
});
vi.mock('@/lib/partner-api-key', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-api-key')>('@/lib/partner-api-key');
  return { ...actual, getPartnerApiKeyStore: () => actual.createPartnerApiKeyStore(db) };
});

import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { apiKeys, auditEvents, partnerGoLive } from '@/db/schema';
import { createApiKeyRepo } from '@/db/repos/api-key-repo';
import { t } from '@/lib/i18n';
import ApiKeysPage from '@/app/partner/(app)/integrations/api-keys/page';
import IntegrationsPage from '@/app/partner/(app)/integrations/page';

const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
async function signInAs(o: Partial<Staff>): Promise<void> {
  const s: Staff = { username: 'pa-admin', name: 'A', role: 'admin', permissions: perms, passwordHash: 'x', createdAt: new Date().toISOString(), partnerId: 'pa', ...o };
  await getAuthStore().saveStaff(s);
  cookieJar.set(SESSION_COOKIE, await getAuthStore().createSession(s.username));
}
const render = async () => renderToStaticMarkup(await ApiKeysPage());
const decode = (html: string) => html.replaceAll('&amp;', '&').replaceAll('&#x27;', "'").replaceAll('&quot;', '"');

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  db = await freshDb();
  await seedPartner(db, 'pa', 'Partner A');
  await seedPartner(db, 'pb', 'Partner B');
});

describe('/partner/integrations/api-keys: the gate', () => {
  it('anonymous → /login; platform → /admin-dashboard; agent, support, finance → /partner', async () => {
    await expect(ApiKeysPage()).rejects.toThrow('REDIRECT:/login');
    await signInAs({ username: 'plat', partnerId: undefined });
    await expect(ApiKeysPage()).rejects.toThrow('REDIRECT:/admin-dashboard');
    for (const role of ['agent', 'support', 'finance'] as const) {
      await signInAs({ username: `pa-${role}`, role });
      await expect(ApiKeysPage()).rejects.toThrow('REDIRECT:/partner');
    }
  });
});

describe('/partner/integrations/api-keys: listing', () => {
  it('lists A’s keys by last 4, mode and scopes; never a plaintext, a hash, or a B key', async () => {
    const repo = createApiKeyRepo(db);
    const a1 = await repo.issue('pa', 'test');
    const a2 = await repo.issue('pa', 'live');
    await repo.revoke(a2.keyId, 'pa');
    const b1 = await repo.issue('pb', 'test');
    await signInAs({});
    const html = decode(await render());
    const hashes = (await db.select({ h: apiKeys.keyHash }).from(apiKeys)).map((r) => r.h);
    for (const s of [a1.plaintext, a2.plaintext, b1.plaintext, a1.plaintext.slice(8), ...hashes]) expect(html).not.toContain(s);
    expect(html).not.toContain(b1.keyId);
    expect(html).toContain(a1.keyId);
    expect(html).toContain(`••••${a1.last4}`);
    expect(html).toContain(t('partner.keys.mode.test'));
    expect(html).toContain('transactions:write');
    expect(html).toContain(t('partner.keys.status.active'));
    expect(html).toMatch(new RegExp(t('partner.keys.status.revoked', { when: '__' }).split('__')[0]));
    // A revoked key offers no rotate / revoke controls: exactly one active row's controls.
    expect(html.match(new RegExp(`>${t('partner.keys.rotate')}<`, 'g'))).toHaveLength(1);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
  });
  it('no keys → the empty state', async () => {
    await signInAs({});
    const html = decode(await render());
    expect(html).toContain(t('partner.keys.empty'));
  });
});

describe('/partner/integrations/api-keys: go-live', () => {
  it('before go-live the live option is locked and explained', async () => {
    await signInAs({});
    const html = decode(await render());
    expect(html).toContain(t('partner.keys.liveLocked'));
    expect(html).toMatch(/<input[^>]*value="live"[^>]*disabled=""|<input[^>]*disabled=""[^>]*value="live"/);
  });
  it('after go-live the live option is available', async () => {
    await db.insert(partnerGoLive).values({ partnerId: 'pa', approvedAt: new Date(), approvedBy: 'system:0028-backfill' });
    await signInAs({});
    const html = decode(await render());
    expect(html).not.toContain(t('partner.keys.liveLocked'));
    expect(html).not.toMatch(/<input[^>]*value="live"[^>]*disabled=""|<input[^>]*disabled=""[^>]*value="live"/);
  });
  it('B’s approval does not unlock A', async () => {
    await db.insert(partnerGoLive).values({ partnerId: 'pb', approvedAt: new Date(), approvedBy: 'system:0028-backfill' });
    await signInAs({});
    expect(decode(await render())).toContain(t('partner.keys.liveLocked'));
  });
});

describe('/partner/integrations/api-keys: side effects', () => {
  it('viewing writes no audit row', async () => {
    await createApiKeyRepo(db).issue('pa', 'test');
    await signInAs({});
    await render();
    expect(await db.select().from(auditEvents)).toEqual([]);
  });
});

describe('/partner/integrations hub', () => {
  it('the API keys tab links to the page', async () => {
    await signInAs({});
    const html = decode(renderToStaticMarkup(await IntegrationsPage()));
    expect(html).toContain('href="/partner/integrations/api-keys"');
  });
});
