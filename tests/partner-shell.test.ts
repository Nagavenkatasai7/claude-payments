import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import type { Staff } from '@/lib/types';

// UI redesign M3-2: the /partner shell (layout + nav). The M3-1 harness (real auth store on a fake
// Redis, real partner store on PGlite), plus usePathname for the client sidebar. The layout is
// chrome only: every page re-gates, and these tests pin both.
const redis = fakeRedis();
let pgPartnerStore: PartnerStore;
// The gate itself reads the partner (the suspended-partner bounce in getCurrentStaff), so the
// failure is injected only on the layout's own brand lookup: every call after the first.
let partnerLookupFails = false;
let partnerLookups = 0;
const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers(),
}));
const redirectMock = vi.hoisted(() =>
  vi.fn((p: string) => {
    throw new Error('REDIRECT:' + p);
  }),
);
const pathname = vi.hoisted(() => ({ current: '/partner' }));
vi.mock('next/navigation', () => ({
  redirect: redirectMock,
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  usePathname: () => pathname.current,
}));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return {
    ...actual,
    getPartnerStore: () => ({
      ...pgPartnerStore,
      getPartner: async (id: string) => {
        if (partnerLookupFails && ++partnerLookups > 1) throw new Error('db down');
        return pgPartnerStore.getPartner(id);
      },
    }),
  };
});

import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { MFA_PENDING_PREFIX } from '@/lib/partner-mfa-gate';
import { partnerNav } from '@/app/partner/routes';
import Layout from '@/app/partner/(app)/layout';
import HomePage from '@/app/partner/(app)/page';
import SecurityPage from '@/app/partner/(app)/security/page';

// A distinctive tenant id, so "no tenant in any href" cannot false-match "/partner".
const TENANT = 'ptn-zq9x';
const OTHER = 'ptn-other7';

const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
async function signInAs(o: Partial<Staff>): Promise<void> {
  const s: Staff = {
    username: 'u1',
    name: 'U',
    role: 'admin',
    permissions: perms,
    passwordHash: 'x',
    createdAt: new Date().toISOString(),
    ...o,
  };
  await getAuthStore().saveStaff(s);
  cookieJar.set(SESSION_COOKIE, await getAuthStore().createSession(s.username));
}
const shell = async (children: React.ReactNode = createElement('p', null, 'child')) =>
  renderToStaticMarkup(await Layout({ children }));
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  redirectMock.mockClear();
  partnerLookupFails = false;
  partnerLookups = 0;
  pathname.current = '/partner';
  const db = await freshDb();
  pgPartnerStore = createPartnerStore(db);
  await seedPartner(db, TENANT, 'Acme Remit Test');
  await seedPartner(db, OTHER, 'Other Brand Co');
});

describe('/partner layout: the gate (chrome only; pages re-gate)', () => {
  it('anonymous → /login', async () => {
    await expect(shell()).rejects.toThrow('REDIRECT:/login');
  });
  it('platform staff (no partnerId) → /admin-dashboard', async () => {
    await signInAs({ partnerId: undefined });
    await expect(shell()).rejects.toThrow('REDIRECT:/admin-dashboard');
  });
  it('a suspended partner staff member → /login', async () => {
    await signInAs({ partnerId: TENANT, role: 'admin', status: 'suspended' });
    await expect(shell()).rejects.toThrow('REDIRECT:/login');
  });
  it('staff of a suspended partner → /login', async () => {
    const p = (await pgPartnerStore.getPartner(TENANT))!;
    await pgPartnerStore.savePartner({ ...p, status: 'suspended' });
    await signInAs({ partnerId: TENANT, role: 'admin' });
    await expect(shell()).rejects.toThrow('REDIRECT:/login');
  });
  it('an unknown role fails closed → /login', async () => {
    await signInAs({ partnerId: TENANT, role: 'finance' as Staff['role'] });
    await expect(shell()).rejects.toThrow('REDIRECT:/login');
  });
  it('MFA pending: the layout still renders (no loop); the home page sends to enrolment', async () => {
    await signInAs({ partnerId: TENANT, role: 'agent' });
    await redis.set(`${MFA_PENDING_PREFIX}u1`, '1');
    const html = await shell();
    expect(html).toContain('class="sh-sidebar');
    expect(redirectMock).not.toHaveBeenCalled();
    await expect(HomePage()).rejects.toThrow('REDIRECT:/partner/security?enroll=1');
  });
});

describe('/partner layout: the chrome', () => {
  it('renders the smoke hooks, the children inside the one <main id="main">, and the skip link', async () => {
    await signInAs({ partnerId: TENANT, role: 'support' });
    const html = await shell();
    expect(html).toContain('class="sh-sidebar');
    expect(html.match(/<main\b/g)).toHaveLength(1);
    expect(html).toMatch(/<main[^>]*id="main"[^>]*class="sh-main/);
    expect(html).toMatch(/<main[^>]*>.*<p>child<\/p>.*<\/main>/s);
    expect(html).toContain('href="#main"');
  });
  it('lists exactly the role-allowed links, and no href carries a tenant id or a query string', async () => {
    for (const [i, role] of (['admin', 'agent', 'support'] as const).entries()) {
      await signInAs({ username: `r${i}`, partnerId: TENANT, role });
      const html = await shell();
      const nav = hrefs(html).filter((h) => h.startsWith('/partner'));
      expect(new Set(nav)).toEqual(new Set(partnerNav(role).map((r) => r.href)));
      for (const h of hrefs(html)) {
        expect(h, h).not.toContain(TENANT);
        expect(h, h).not.toContain('?');
      }
    }
  });
  it('shows the SESSION tenant brand only (never another partner)', async () => {
    await signInAs({ partnerId: TENANT, role: 'agent' });
    const html = await shell();
    expect(html).toContain('Acme Remit Test');
    expect(html).not.toContain('Other Brand Co');
    expect(html).not.toContain(TENANT);
  });
  it('marks the current page: exact match for /partner, prefix match below it', async () => {
    await signInAs({ partnerId: TENANT, role: 'agent' });
    const current = (html: string) => [...html.matchAll(/aria-current="page"[^>]*href="([^"]*)"/g)].map((m) => m[1]);
    pathname.current = '/partner';
    expect(new Set(current(await shell()))).toEqual(new Set(['/partner']));
    pathname.current = '/partner/security';
    expect(new Set(current(await shell()))).toEqual(new Set(['/partner/security']));
  });
  it('the brand is not a heading (one h1 per page: the page owns it)', async () => {
    await signInAs({ partnerId: TENANT, role: 'admin' });
    const html = renderToStaticMarkup(await Layout({ children: await HomePage() }));
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html.match(/<main\b/g)).toHaveLength(1);
  });
  it('a failed partner lookup still renders the shell (the brand falls back to empty)', async () => {
    await signInAs({ partnerId: TENANT, role: 'admin' });
    partnerLookupFails = true;
    const html = await shell();
    expect(html).toContain('class="sh-sidebar');
    expect(html).not.toContain('Acme Remit Test');
  });
  it('has a sign-out control that posts (no GET sign-out link)', async () => {
    await signInAs({ partnerId: TENANT, role: 'admin' });
    const html = await shell();
    expect(html).toMatch(/<form[^>]*>.*Sign out.*<\/form>/s);
    expect(hrefs(html).some((h) => /logout|sign-?out/i.test(h))).toBe(false);
  });
});

describe('/partner pages gate by themselves (the layout is not the guard)', () => {
  it('home: anonymous → /login; platform → /admin-dashboard', async () => {
    await expect(HomePage()).rejects.toThrow('REDIRECT:/login');
    await signInAs({ partnerId: undefined });
    await expect(HomePage()).rejects.toThrow('REDIRECT:/admin-dashboard');
  });
  it('security: anonymous → /login; platform → /admin-dashboard', async () => {
    await expect(SecurityPage()).rejects.toThrow('REDIRECT:/login');
    await signInAs({ partnerId: undefined });
    await expect(SecurityPage()).rejects.toThrow('REDIRECT:/admin-dashboard');
  });
  it('EVERY page under (app) gates with a policy from routes.ts (the layout uses skipMfa + every role)', () => {
    const pages = (d: string): string[] =>
      readdirSync(d).flatMap((n) => {
        const p = join(d, n);
        return statSync(p).isDirectory() ? pages(p) : n === 'page.tsx' ? [p] : [];
      });
    const found = pages('src/app/partner/(app)');
    expect(found.length).toBeGreaterThanOrEqual(2);
    for (const f of found) expect(readFileSync(f, 'utf8'), f).toMatch(/await requirePartnerStaff\(PARTNER_ROUTES\.\w+\.policy/);
  });
  it('pages render no <main> of their own (the layout owns it) and read their policy from routes.ts', () => {
    for (const [f, key] of [
      ['src/app/partner/(app)/page.tsx', 'home'],
      ['src/app/partner/(app)/security/page.tsx', 'security'],
    ] as const) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/<main\b/);
      expect(src, f).toContain(`requirePartnerStaff(PARTNER_ROUTES.${key}.policy`);
    }
  });
});
