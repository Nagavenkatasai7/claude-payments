import { describe, it, expect, vi, beforeEach } from 'vitest';
import { env } from '@/lib/env';
import { statusCallbackUrl } from '@/lib/partner-integration-urls';
import { renderToStaticMarkup } from 'react-dom/server';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// UI redesign M3-15a: /partner/integrations/webhooks. Admin only (finance → /partner); the SESSION
// tenant's config only; no secret value (current or previous) ever reaches the HTML; a
// SmartRemit-managed rail shows no controls; viewing writes nothing.

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

import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { auditEvents, partnerWebhookDeliveries } from '@/db/schema';
import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { RAIL_SECRET_GRACE_MS } from '@/lib/partner-integrations';
import { t } from '@/lib/i18n';
import WebhooksPage from '@/app/partner/(app)/integrations/webhooks/page';
import IntegrationsPage from '@/app/partner/(app)/integrations/page';

const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
async function signInAs(o: Partial<Staff>): Promise<void> {
  const s: Staff = { username: 'pa-admin', name: 'A', role: 'admin', permissions: perms, passwordHash: 'x', createdAt: new Date().toISOString(), partnerId: 'pa', ...o };
  await getAuthStore().saveStaff(s);
  cookieJar.set(SESSION_COOKIE, await getAuthStore().createSession(s.username));
}
const render = async () => renderToStaticMarkup(await WebhooksPage());
const decode = (html: string) => html.replaceAll('&amp;', '&').replaceAll('&#x27;', "'").replaceAll('&quot;', '"');
const store = () => createPartnerIntegrationsStore(db);
const SECRETS = ['SIGN-CURRENT-0123456789', 'SIGN-PREVIOUS-0123456789', 'HOOK-CURRENT-0123456789'];

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  db = await freshDb();
  await seedPartner(db, 'pa', 'Partner A');
  await seedPartner(db, 'pb', 'Partner B');
});

async function seedHttpRail() {
  const until = new Date(Date.now() + RAIL_SECRET_GRACE_MS).toISOString();
  await store().saveIntegrations('pa', {
    kyc: {},
    payment: {
      providerType: 'http',
      credentials: { settlementUrl: 'https://rail-a.example.com/instruct', signingSecret: SECRETS[0], previousSigningSecret: SECRETS[1], previousSigningSecretUntil: until },
      webhookSecret: SECRETS[2],
    },
    whatsapp: {},
  });
  await store().saveIntegrations('pb', {
    kyc: {},
    payment: { providerType: 'http', credentials: { settlementUrl: 'https://rail-b.example.com/secret-path', signingSecret: 'B-SIGN-XYZ' } },
    whatsapp: {},
  });
  return until;
}

describe('/partner/integrations/webhooks: the gate', () => {
  it('anonymous → /login; platform → /admin-dashboard; agent, support, finance → /partner', async () => {
    await expect(WebhooksPage()).rejects.toThrow('REDIRECT:/login');
    await signInAs({ username: 'plat', partnerId: undefined });
    await expect(WebhooksPage()).rejects.toThrow('REDIRECT:/admin-dashboard');
    for (const role of ['agent', 'support', 'finance'] as const) {
      await signInAs({ username: `pa-${role}`, role });
      await expect(WebhooksPage()).rejects.toThrow('REDIRECT:/partner');
    }
  });
});

describe('/partner/integrations/webhooks: a partner-operated rail', () => {
  it('shows A’s endpoint, rail type, secret states and the grace expiry; never a secret or B’s config', async () => {
    const until = await seedHttpRail();
    await signInAs({});
    const html = decode(await render());
    for (const s of [...SECRETS, 'B-SIGN-XYZ', 'rail-b.example.com']) expect(html).not.toContain(s);
    expect(html).toContain('https://rail-a.example.com/instruct');
    expect(html).toContain('http');
    expect(html).toContain(t('partner.webhooks.secret.set'));
    expect(html).toContain(t('partner.webhooks.secret.grace', { when: `${until.slice(0, 10)} ${until.slice(11, 16)} UTC` }));
    expect(html).toContain(t('partner.webhooks.save'));
    expect(html).toContain(t('partner.webhooks.rotate.signing'));
    expect(html).toContain(t('partner.webhooks.rotate.webhook'));
    expect(html).toContain(t('partner.webhooks.test'));
    expect(html).toContain(t('partner.webhooks.recentEmpty'));
    expect(html.match(/<h1\b/g)).toHaveLength(1);
  });

  it('lists A’s last 10 pings only (outcome, status, latency), newest first', async () => {
    await seedHttpRail();
    const base = Date.now() - 60_000;
    for (let i = 0; i < 12; i++) {
      await db.insert(partnerWebhookDeliveries).values({ partnerId: 'pa', kind: 'ping', attempt: 1, outcome: 'ok', httpStatus: 200 + i, latencyMs: 10 + i, createdAt: new Date(base + i * 1000) });
    }
    await db.insert(partnerWebhookDeliveries).values({ partnerId: 'pb', kind: 'ping', attempt: 1, outcome: 'network', httpStatus: 599, latencyMs: 1 });
    await signInAs({});
    const html = decode(await render());
    expect(html).toContain('>211<');
    expect(html).toContain('>202<');
    expect(html).not.toContain('>201<'); // the 11th newest is not shown
    expect(html).not.toContain('>599<');
    expect(html.indexOf('>211<')).toBeLessThan(html.indexOf('>202<'));
    expect(html).toContain(t('partner.webhooks.outcome.ok'));
  });
});

describe('/partner/integrations/webhooks: the status callback URL (2f)', () => {
  it('a partner-operated rail shows the read-only status callback URL, computed like the legacy guide', async () => {
    await seedHttpRail();
    await signInAs({});
    const html = decode(await render());
    expect(html).toContain(t('partner.webhooks.callbackTitle'));
    expect(html).toContain(`data-testid="webhooks-callback-url"`);
    expect(html).toContain(statusCallbackUrl(env.appBaseUrl, 'http'));
  });
  it('a SmartRemit-managed rail does not show it', async () => {
    await signInAs({});
    expect(decode(await render())).not.toContain(t('partner.webhooks.callbackTitle'));
  });
});

describe('/partner/integrations/webhooks: a SmartRemit-managed rail', () => {
  it('a simulator or unset rail shows the managed notice and no controls', async () => {
    await store().saveIntegrations('pa', { kyc: {}, payment: { providerType: 'simulator', credentials: { settlementUrl: 'https://smartremit.ai/api/partner-rail', signingSecret: 'SIM-SECRET' } }, whatsapp: {} });
    await signInAs({});
    let html = decode(await render());
    expect(html).toContain(t('partner.webhooks.managed'));
    expect(html).not.toContain(t('partner.webhooks.save'));
    expect(html).not.toContain(t('partner.webhooks.test'));
    expect(html).not.toContain('SIM-SECRET');
    await store().saveIntegrations('pa', { kyc: {}, payment: {}, whatsapp: {} });
    html = decode(await render());
    expect(html).toContain(t('partner.webhooks.managed'));
  });
});

describe('/partner/integrations/webhooks: side effects', () => {
  it('viewing writes no audit row', async () => {
    await seedHttpRail();
    await signInAs({});
    await render();
    expect(await db.select().from(auditEvents)).toEqual([]);
  });
});

describe('/partner/integrations hub', () => {
  it('the webhooks tab links to the page', async () => {
    await signInAs({});
    const html = decode(renderToStaticMarkup(await IntegrationsPage()));
    expect(html).toContain('href="/partner/integrations/webhooks"');
    expect(html).not.toContain(t('partner.integrations.soon'));
  });
});
