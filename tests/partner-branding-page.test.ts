import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { eq } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// UI redesign M3-17, Task 17.3: /partner/branding. The page gates itself (admin only), reads the
// SESSION tenant only, and renders the partner's colours only through the M1 style emitter (so the
// <style> holds validated tokens alone), the logo only as an <img src>, and the support contact as
// escaped text.
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

import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { KNOWN_PARTNER_ROLES } from '@/lib/partner-access';
import { partners, partnerSites } from '@/db/schema';
import { DEFAULT_THEME } from '@/lib/ui/tokens';
import BrandingPage from '@/app/partner/(app)/branding/page';
import { t } from '@/lib/i18n';

const PA = 'ptn-alpha3';
const PB = 'ptn-bravo9';
const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
async function signInAs(o: Partial<Staff>): Promise<void> {
  const s: Staff = {
    username: 'pa-admin',
    name: 'U',
    role: 'admin',
    permissions: perms,
    passwordHash: 'x',
    createdAt: new Date().toISOString(),
    partnerId: PA,
    ...o,
  };
  await getAuthStore().saveStaff(s);
  cookieJar.clear();
  cookieJar.set(SESSION_COOKIE, await getAuthStore().createSession(s.username));
}
const render = async () => renderToStaticMarkup(await BrandingPage());
const styles = (html: string) => [...html.matchAll(/<style[^>]*>[\s\S]*?<\/style>/g)].map((m) => m[0]);
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');
const PNG_POLYGLOT = `data:image/png;base64,${b64(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('<html><script>alert(1)</script>')]))}`;
const SVG_LEGACY = `data:image/svg+xml;base64,${b64('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')}`;
const FINANCE_REDIRECT = (KNOWN_PARTNER_ROLES as readonly string[]).includes('finance') ? 'REDIRECT:/partner' : 'REDIRECT:/login';

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  box.db = await freshDb();
  pgPartnerStore = createPartnerStore(box.db);
  await seedPartner(box.db, PA, 'Alpha');
  await seedPartner(box.db, PB, 'Bravo');
  await box.db
    .update(partners)
    .set({ displayName: 'Bravo Remit', primaryColor: '#1f2937', supportContact: 'bravo-help@bravo.example', logoUrl: `data:image/png;base64,${b64('BRAVOLOGO')}` })
    .where(eq(partners.id, PB));
  await box.db.insert(partnerSites).values({ partnerId: PB, accentColor: '#0e7490' });
});

describe('/partner/branding gates by itself', () => {
  it('anonymous → /login; platform staff → /admin-dashboard', async () => {
    await expect(render()).rejects.toThrow('REDIRECT:/login');
    await signInAs({ username: 'plat', partnerId: undefined });
    await expect(render()).rejects.toThrow('REDIRECT:/admin-dashboard');
  });
  it('agent and support → /partner; finance is refused too', async () => {
    for (const role of ['agent', 'support'] as const) {
      await signInAs({ username: `pa-${role}`, role });
      await expect(render()).rejects.toThrow('REDIRECT:/partner');
    }
    await signInAs({ username: 'pa-fin', role: 'finance' as Staff['role'] });
    await expect(render()).rejects.toThrow(FINANCE_REDIRECT);
  });
});

describe('/partner/branding for a partner admin', () => {
  beforeEach(async () => {
    await signInAs({});
  });
  it('renders one h1, the three forms and the preview, with the default theme for a fresh partner', async () => {
    const html = await render();
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    for (const id of ['branding-theme-form', 'branding-logo-form', 'branding-contact-form', 'branding-preview']) expect(html).toContain(`data-testid="${id}"`);
    expect(html).toContain('name="primaryColor"');
    expect(html).toContain('name="accentColor"');
    expect(html).toContain('name="logo"');
    expect(html).toContain('accept="image/png,image/jpeg,image/webp"');
    expect(html).toContain('name="supportContact"');
    // No saved colours → the preview shows the landing defaults (loadSiteTheme's fallback).
    expect(styles(html)).toEqual([
      `<style>.ds-site{--ds-primary:${DEFAULT_THEME.primary};--ds-primary-hover:color-mix(in srgb,${DEFAULT_THEME.primary} 88%,black);--ds-accent:${DEFAULT_THEME.accent};--ds-gradient-text:linear-gradient(95deg,${DEFAULT_THEME.primary},${DEFAULT_THEME.accent})}</style>`,
    ]);
  });
  it('the preview <style> contains ONLY validated tokens (the M1 character-class assertion)', async () => {
    await box.db!.update(partners).set({ primaryColor: '#7A1FA2' }).where(eq(partners.id, PA));
    await box.db!.insert(partnerSites).values({ partnerId: PA, accentColor: '#0e7490' });
    const found = styles(await render());
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^<style>[a-z0-9#\-,(.%) ;:{}]+<\/style>$/);
    expect(found[0]).toContain('.ds-site{--ds-primary:#7a1fa2;');
  });
  it.each(['red;}body{display:none}', '</style><script>alert(1)</script>', 'url(javascript:alert(1))', '#25d366', '#7a1fa2;}*{x:y'])(
    'a hostile legacy primary %j (written outside the writer) never reaches the page',
    async (bad) => {
      await box.db!.update(partners).set({ primaryColor: bad }).where(eq(partners.id, PA));
      const html = await render();
      const found = styles(html);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatch(/^<style>[a-z0-9#\-,(.%) ;:{}]+<\/style>$/);
      expect(found[0]).toContain(`--ds-primary:${DEFAULT_THEME.primary};`); // the invalid value fell back
      for (const needle of ['display:none', 'alert(1)', 'url(javascript', '*{x:y', '#25d366']) expect(html).not.toContain(needle);
    },
  );
  it('a stored logo (incl. a PNG+HTML polyglot or a legacy SVG) appears only as an <img src>, never in CSS', async () => {
    for (const logo of [PNG_POLYGLOT, SVG_LEGACY]) {
      await box.db!.update(partners).set({ logoUrl: logo }).where(eq(partners.id, PA));
      const html = await render();
      expect(html).toContain(`<img src="${logo}"`);
      expect(html.split(logo)).toHaveLength(2); // exactly once, as that img src
      for (const s of styles(html)) expect(s).not.toContain('base64');
      expect(html).not.toContain('url(');
    }
  });
  it('a legacy support contact is rendered as escaped text', async () => {
    await box.db!.update(partners).set({ supportContact: '<script>alert(1)</script>' }).where(eq(partners.id, PA));
    const html = await render();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
  it('shows ONLY the session tenant’s brand: nothing of partner B reaches A’s page', async () => {
    await box.db!.update(partners).set({ displayName: 'Alpha Remit', supportContact: 'help@alpha.example' }).where(eq(partners.id, PA));
    const html = await render();
    expect(html).toContain('Alpha Remit');
    expect(html).toContain('help@alpha.example');
    for (const leak of ['Bravo', 'bravo-help@bravo.example', b64('BRAVOLOGO'), '#1f2937']) expect(html).not.toContain(leak);
  });
});

// Carry-forward from the PR #381 review: a stored logo is safe only as an <img> data URI (a PNG+HTML
// polyglot passes the signature check). No app route may serve it.
describe('/partner/branding web address (M3-18)', () => {
  beforeEach(async () => {
    await signInAs({});
    await box.db!.update(partnerSites).set({ slug: 'bravo-co' }).where(eq(partnerSites.partnerId, PB));
  });
  it('no slug yet → the one-time claim form, and nothing of B’s slug', async () => {
    const html = await render();
    expect(html).toContain('data-testid="branding-slug-form"');
    expect(html).toContain('name="slug"');
    expect(html).not.toContain('bravo-co');
  });
  it('a claimed slug → shown read-only with the contact-SmartRemit note; no claim form', async () => {
    await box.db!.insert(partnerSites).values({ partnerId: PA, slug: 'alpha-co' });
    const html = await render();
    expect(html).not.toContain('data-testid="branding-slug-form"');
    expect(html).toContain('data-testid="branding-slug-current"');
    expect(html).toContain('alpha-co.smartremit.ai');
    expect(html).toContain(t('partner.slug.contactSmartRemit'));
    expect(html).not.toContain('bravo-co');
  });
});

describe('stored logos are never served from an app route', () => {
  const routeFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? routeFiles(p) : /^route\.(ts|tsx|js)$/.test(n) ? [p] : [];
    });
  it('no route handler reads partners.logoUrl or imports the logo store', () => {
    const offenders = routeFiles('src/app').filter((f) => /partner-logo-store|\blogoUrl\b|logo_url/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
