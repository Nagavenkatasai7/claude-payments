import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';
import { EnvKeyProvider } from '@/lib/field-crypto';

// UI redesign M3-13: /partner/integrations and /partner/integrations/whatsapp. Admin only; the
// SESSION tenant only; secrets are write-only (the stored token / app secret / verify token never
// reach the HTML, only "Set" / "Not set"); the phone number id shows its last 4 only; health and
// the last test render by kind through i18n; viewing writes nothing.

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
vi.mock('@/lib/store', async (orig) => {
  const actual = await orig<typeof import('@/lib/store')>();
  return { ...actual, getStore: () => actual.createStore(redis, db) };
});
vi.mock('@/lib/partner-integrations-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-integrations-store')>('@/lib/partner-integrations-store');
  return { ...actual, getPartnerIntegrationsStore: () => actual.createPartnerIntegrationsStore(db, new EnvKeyProvider(Buffer.alloc(32, 7))) };
});

import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { auditEvents } from '@/db/schema';
import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { createStore } from '@/lib/store';
import { env } from '@/lib/env';
import { t } from '@/lib/i18n';
import WhatsappPage from '@/app/partner/(app)/integrations/whatsapp/page';
import IntegrationsPage from '@/app/partner/(app)/integrations/page';

const PN_A = '1234567890123';
const PN_B = '9876543210987';
const SECRETS_A = { token: 'EAA-aaa-token-SECRET', appSecret: 'aaa-app-secret-SECRET', verifyToken: 'aaa-verify-SECRET' };
const SECRETS_B = { token: 'EAA-bbb-token-SECRET', appSecret: 'bbb-app-secret-SECRET', verifyToken: 'bbb-verify-SECRET' };
const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };

async function signInAs(o: Partial<Staff>): Promise<void> {
  const s: Staff = { username: 'pa-admin', name: 'A', role: 'admin', permissions: perms, passwordHash: 'x', createdAt: new Date().toISOString(), partnerId: 'pa', ...o };
  await getAuthStore().saveStaff(s);
  cookieJar.set(SESSION_COOKIE, await getAuthStore().createSession(s.username));
}
const store = () => createPartnerIntegrationsStore(db, new EnvKeyProvider(Buffer.alloc(32, 7)));
const render = async () => renderToStaticMarkup(await WhatsappPage());
const decode = (html: string) => html.replaceAll('&amp;', '&').replaceAll('&#x27;', "'").replaceAll('&quot;', '"');

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  db = await freshDb();
  await seedPartner(db, 'pa', 'Partner A');
  await seedPartner(db, 'pb', 'Partner B');
  await store().saveIntegrations('pb', { kyc: {}, payment: {}, whatsapp: { phoneNumberId: PN_B, ...SECRETS_B } });
});

describe('/partner/integrations/whatsapp: the gate', () => {
  it('anonymous → /login; platform → /admin-dashboard; agent, support, finance → /partner', async () => {
    await expect(WhatsappPage()).rejects.toThrow('REDIRECT:/login');
    await signInAs({ username: 'plat', partnerId: undefined });
    await expect(WhatsappPage()).rejects.toThrow('REDIRECT:/admin-dashboard');
    for (const role of ['agent', 'support', 'finance'] as const) {
      await signInAs({ username: `pa-${role}`, role });
      await expect(WhatsappPage()).rejects.toThrow('REDIRECT:/partner');
      await expect(IntegrationsPage()).rejects.toThrow('REDIRECT:/partner');
    }
  });
});

describe('/partner/integrations/whatsapp: write-only secrets, session tenant only', () => {
  it('an own number: last 4 + "Set" booleans; the stored secrets and B’s config never reach the HTML', async () => {
    await store().saveIntegrations('pa', { kyc: {}, payment: {}, whatsapp: { phoneNumberId: PN_A, ...SECRETS_A } });
    await signInAs({});
    const html = decode(await render());
    for (const s of [...Object.values(SECRETS_A), ...Object.values(SECRETS_B), PN_A, PN_B, PN_B.slice(-4)]) expect(html).not.toContain(s);
    expect(html).toContain(`••••${PN_A.slice(-4)}`);
    expect(html).toContain(t('partner.whatsapp.channel.own'));
    expect(html).toContain(t('partner.whatsapp.set'));
    // The callback URL is THIS tenant's, never B's.
    expect(html).toContain(`${env.appBaseUrl}/api/whatsapp/pa`);
    expect(html).not.toContain('/api/whatsapp/pb');
    // No input is pre-filled with anything stored (write-only fields render empty).
    expect(html).not.toMatch(/name="(token|appSecret|verifyToken|phoneNumberId)"[^>]*value="[^"]+"/);
    // One h1.
    expect(html.match(/<h1\b/g)).toHaveLength(1);
  });

  it('nothing set: the shared number, "Not set" everywhere, no disconnect control', async () => {
    await signInAs({});
    const html = decode(await render());
    expect(html).toContain(t('partner.whatsapp.channel.shared'));
    expect(html).toContain(t('partner.whatsapp.notSet'));
    expect(html).not.toContain(t('partner.whatsapp.disconnect.button'));
  });

  it('health renders by kind through i18n (never the English summary text) and the last test result', async () => {
    await store().saveIntegrations('pa', { kyc: {}, payment: {}, whatsapp: { phoneNumberId: PN_A, token: SECRETS_A.token, appSecret: SECRETS_A.appSecret } });
    const s = createStore(redis, db);
    await s.writeChannelHealth('pa', JSON.stringify({ auth_error: { at: new Date().toISOString(), count: 2, code: 190 } }));
    await s.writeChannelTest('pa', JSON.stringify({ ok: false, at: '2026-09-28T10:11:00.000Z', reason: 'probe_failed', status: 401 }));
    await signInAs({});
    const html = decode(await render());
    expect(html).toContain(t('partner.whatsapp.health.kind.auth_error'));
    expect(html).toContain(t('partner.whatsapp.health.kind.config_warning'));
    expect(html).toContain(t('partner.whatsapp.test.failedStatus', { when: '2026-09-28 10:11 UTC', status: 401 }));
    expect(html).not.toContain('WhatsApp access token was rejected');
  });

  it('B’s health marks and test result never show on A’s page', async () => {
    const s = createStore(redis, db);
    await s.writeChannelHealth('pb', JSON.stringify({ dead_send: { at: new Date().toISOString(), count: 1 } }));
    await s.writeChannelTest('pb', JSON.stringify({ ok: true, at: '2026-09-28T10:11:00.000Z' }));
    await signInAs({});
    const html = decode(await render());
    expect(html).not.toContain(t('partner.whatsapp.health.kind.dead_send'));
    expect(html).toContain(t('partner.whatsapp.test.never'));
    expect(html).toContain(t('partner.whatsapp.health.ok'));
  });

  it('the default tenant (the shared number) sees it is SmartRemit-managed and gets no form', async () => {
    await seedPartner(db, 'default', 'Default');
    await signInAs({ username: 'def-admin', partnerId: 'default' });
    const html = decode(await render());
    expect(html).toContain(t('partner.whatsapp.sharedManaged'));
    expect(html).not.toContain('name="token"');
    expect(html).not.toContain(t('partner.whatsapp.test.run'));
  });

  it('viewing writes no audit row', async () => {
    await signInAs({});
    await render();
    expect(await db.select().from(auditEvents)).toEqual([]);
  });
});

describe('/partner/integrations (the hub)', () => {
  it('links to the WhatsApp and API keys pages; webhooks is text until its page exists', async () => {
    await signInAs({});
    const html = decode(renderToStaticMarkup(await IntegrationsPage()));
    expect(html).toContain('href="/partner/integrations/whatsapp"');
    expect(html).toContain('href="/partner/integrations/api-keys"'); // M3-14
    expect(html).not.toContain('href="/partner/integrations/webhooks"');
    expect(html.match(/<h1\b/g)).toHaveLength(1);
  });
});
