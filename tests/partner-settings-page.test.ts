import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { eq } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// Partner-dashboard merge 2f: /partner/settings. The page gates itself (admin only), reads the
// SESSION tenant only, shows the support portal, alert email and disclosure forms with the stored
// values as escaped text, and the pricing margin READ-ONLY (owner decision D7: no margin input).
const redis = fakeRedis();
const box: { db: Db | null } = { db: null };
let pgPartnerStore: PartnerStore;
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
vi.mock('@/db/client', async () => {
  const actual = await vi.importActual<typeof import('@/db/client')>('@/db/client');
  return { ...actual, getDb: () => box.db };
});
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => pgPartnerStore };
});
const failIntegrations = { on: false };
vi.mock('@/lib/partner-integrations-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-integrations-store')>('@/lib/partner-integrations-store');
  return {
    ...actual,
    getPartnerIntegrationsStore: () => {
      const s = actual.createPartnerIntegrationsStore(box.db!);
      if (failIntegrations.on) s.getIntegrations = async () => Promise.reject(new Error('integrations down'));
      return s;
    },
  };
});

import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { auditEvents, partners } from '@/db/schema';
import { createPartnerRateRepo } from '@/db/repos/partner-rate-repo';
import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import SettingsPage from '@/app/partner/(app)/settings/page';
import { t } from '@/lib/i18n';

const PA = 'ptn-alpha3';
const PB = 'ptn-bravo9';
const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
async function signInAs(o: Partial<Staff>): Promise<void> {
  const s: Staff = { username: 'pa-admin', name: 'U', role: 'admin', permissions: perms, passwordHash: 'x', createdAt: new Date().toISOString(), partnerId: PA, ...o };
  await getAuthStore().saveStaff(s);
  cookieJar.clear();
  cookieJar.set(SESSION_COOKIE, await getAuthStore().createSession(s.username));
}
const render = async () => renderToStaticMarkup(await SettingsPage());
const decode = (html: string) => html.replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  failIntegrations.on = false;
  box.db = await freshDb();
  pgPartnerStore = createPartnerStore(box.db);
  await seedPartner(box.db, PA, 'Alpha');
  await seedPartner(box.db, PB, 'Bravo');
  await box.db
    .update(partners)
    .set({ supportConfig: { enableSupportPortal: false, alertEmail: 'ops@bravo.example', disclosure: { licensedEntity: 'Bravo Remit LLC', licenseIds: ['BRAVO-LIC-9'] } } })
    .where(eq(partners.id, PB));
  await createPartnerRateRepo(box.db).upsertRate({ id: 'rate-b1', partnerId: PB, sourceCurrency: 'USD', destinationCurrency: 'INR', marginBps: 77 });
});

describe('/partner/settings gates by itself', () => {
  it('anonymous → /login; platform → /admin-dashboard; agent, support, finance → /partner', async () => {
    await expect(render()).rejects.toThrow('REDIRECT:/login');
    await signInAs({ username: 'plat', partnerId: undefined });
    await expect(render()).rejects.toThrow('REDIRECT:/admin-dashboard');
    for (const role of ['agent', 'support', 'finance'] as const) {
      await signInAs({ username: `pa-${role}`, role: role as Staff['role'] });
      await expect(render()).rejects.toThrow('REDIRECT:/partner');
    }
  });
});

describe('/partner/settings for a partner admin', () => {
  beforeEach(async () => {
    await signInAs({});
  });
  it('a fresh partner: one h1, the three forms, the portal on by default, and the empty margin state', async () => {
    const html = await render();
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    for (const id of ['settings-portal-form', 'settings-alert-form', 'settings-disclosure-form']) expect(html).toContain(`data-testid="${id}"`);
    expect(html).toMatch(/<input[^>]*name="enableSupportPortal"[^>]*checked=""|<input[^>]*checked=""[^>]*name="enableSupportPortal"/);
    expect(html).toContain(t('partner.settings.pricing.empty'));
  });
  it('shows A’s stored values (escaped) and nothing of B', async () => {
    await box.db!
      .update(partners)
      .set({
        supportConfig: {
          enableSupportPortal: false,
          alertEmail: 'ops@alpha.example',
          disclosure: { licensedEntity: 'Alpha <b>Money</b>', licenseIds: ['NMLS 1', 'TX 2'], deliveryEstimate: { businessDays: 3 } },
        },
      })
      .where(eq(partners.id, PA));
    const html = await render();
    expect(html).not.toMatch(/<input[^>]*name="enableSupportPortal"[^>]*checked=""/);
    expect(html).toContain('value="ops@alpha.example"');
    expect(html).toContain('Alpha &lt;b&gt;Money&lt;/b&gt;');
    expect(html).not.toContain('<b>Money</b>');
    expect(html).toContain('NMLS 1\nTX 2');
    expect(html).toContain('value="3"');
    for (const leak of ['ops@bravo.example', 'Bravo Remit LLC', 'BRAVO-LIC-9', '>77<']) expect(html).not.toContain(leak);
  });
  it('the pricing margin is read-only: A’s corridors and margins, no margin input or form', async () => {
    const repo = createPartnerRateRepo(box.db!);
    await repo.upsertRate({ id: 'rate-a1', partnerId: PA, sourceCurrency: 'USD', destinationCurrency: 'INR', marginBps: 25 });
    await repo.upsertRate({ id: 'rate-a2', partnerId: PA, sourceCurrency: 'GBP', destinationCurrency: 'INR', effectiveRate: 105, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const html = decode(await render());
    expect(html).toContain(t('partner.settings.pricing.title'));
    expect(html).toContain('USD → INR');
    expect(html).toContain('>25<');
    expect(html).toContain('GBP → INR');
    expect(html).toContain(t('partner.settings.pricing.notSet'));
    expect(html).not.toContain('name="marginBps"');
    expect(html).not.toContain('>77<');
  });
  it('platform-only settings are not offered (D8): no provider switch, countries, internal name, admin note, brand name or auto-assign', async () => {
    const html = await render();
    for (const name of ['providerType', 'countries', 'name', 'adminNote', 'brandName', 'autoAssign', 'kycMode']) expect(html).not.toContain(`name="${name}"`);
  });
  it('viewing writes no audit row', async () => {
    await render();
    expect(await box.db!.select().from(auditEvents)).toEqual([]);
  });
});

describe('/partner/settings compliance setup card (p3 B13)', () => {
  beforeEach(async () => {
    await signInAs({});
  });
  it('a fresh partner: SmartRemit runs checks, the gate is off, countries listed, sanctions always run, no warning', async () => {
    const html = decode(await render());
    expect(html).toContain('data-testid="settings-setup"');
    expect(html).toContain('data-setup="kycMode" data-value="ours"');
    expect(html).toContain('data-setup="gate" data-value="off"');
    expect(html).toMatch(/data-setup="countries"[^>]*>US</);
    expect(html).toContain(t('partner.settings.setup.sanctions'));
    expect(html).not.toContain('data-setup="liveRailWarning"');
    expect(html).not.toContain('name="kycMode"');
  });
  it('ours + gate off + a live rail shows the warning; B’s settings never colour A’s card', async () => {
    await createPartnerIntegrationsStore(box.db!).saveIntegrations(PA, {
      kyc: {},
      payment: { providerType: 'http', credentials: { settlementUrl: 'https://rail-a.example/settle', signingSecret: 's' }, webhookSecret: 'w' },
      whatsapp: {},
    });
    await box.db!.update(partners).set({ kycMode: 'delegated', requireKycBeforeSend: true }).where(eq(partners.id, PB));
    const html = await render();
    expect(html).toContain('data-setup="liveRailWarning"');
    expect(html).toContain('data-setup="kycMode" data-value="ours"');
    expect(html).not.toContain('rail-a.example');
  });
  it('a delegated partner with the gate on', async () => {
    await box.db!.update(partners).set({ kycMode: 'delegated', requireKycBeforeSend: true }).where(eq(partners.id, PA));
    const html = await render();
    expect(html).toContain('data-setup="kycMode" data-value="delegated"');
    expect(html).toContain('data-setup="gate" data-value="on"');
  });
  it('a failed integrations read hides only the warning; the rest of the page renders', async () => {
    failIntegrations.on = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const html = await render();
    warn.mockRestore();
    expect(html).toContain('data-testid="settings-setup"');
    expect(html).not.toContain('data-setup="liveRailWarning"');
    expect(html).toContain('data-testid="settings-portal-form"');
    expect(html).not.toContain('integrations down');
  });
});
