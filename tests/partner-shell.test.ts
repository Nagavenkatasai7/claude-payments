import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import type { Staff } from '@/lib/types';
import type { Db } from '@/db/client';

// UI redesign M3-2: the /partner shell (layout + nav). The M3-1 harness (real auth store on a fake
// Redis, real partner store on PGlite), plus usePathname for the client sidebar. The layout is
// chrome only: every page re-gates, and these tests pin both.
const redis = fakeRedis();
let pgPartnerStore: PartnerStore;
let homeDb: Db;
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
// M3-3: the home page reads the ledger, channel health, integrations and API keys. Wire every
// store getter to this test's PGlite so no render ever dials a real database.
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => homeDb }));
vi.mock('@/lib/store', async (orig) => {
  const actual = await orig<typeof import('@/lib/store')>();
  return { ...actual, getStore: () => actual.createStore(redis, homeDb) };
});
vi.mock('@/lib/partner-integrations-store', async (orig) => {
  const actual = await orig<typeof import('@/lib/partner-integrations-store')>();
  return { ...actual, getPartnerIntegrationsStore: () => actual.createPartnerIntegrationsStore(homeDb) };
});
vi.mock('@/lib/partner-api-key', async (orig) => {
  const actual = await orig<typeof import('@/lib/partner-api-key')>();
  return { ...actual, getPartnerApiKeyStore: () => actual.createPartnerApiKeyStore(homeDb) };
});
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
import { PARTNER_ROUTES, partnerNav } from '@/app/partner/routes';
import Layout from '@/app/partner/(app)/layout';
import HomePage from '@/app/partner/(app)/page';
import SecurityPage from '@/app/partner/(app)/security/page';
import { PartnerSidebar } from '@/app/partner/(app)/partner-sidebar';

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
  homeDb = db;
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
    // M3-6 made 'finance' a known role; the fail-closed case now uses a role outside the set.
    await signInAs({ partnerId: TENANT, role: 'root' as Staff['role'] });
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

// A page's gate, checked from its source: the page's path maps (via href) to exactly one
// PARTNER_ROUTES key, and every requirePartnerStaff call in it uses THAT key's policy.
// Route groups are dropped from the URL; a dynamic segment ([id]) shares its static parent's key.
// Only the security page may pass { skipMfa: true } (it IS the enrolment page).
const APP_DIR = 'src/app/partner/(app)';
const SECURITY_PAGE = `${APP_DIR}/security/page.tsx`;
// Comments are stripped first, so a commented-out gate never satisfies the check.
const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
function gateProblems(file: string, rawSrc: string): string[] {
  const src = stripComments(rawSrc);
  const segs = file
    .slice(APP_DIR.length)
    .split('/')
    .filter((x) => x !== '' && x !== 'page.tsx' && !/^\(.*\)$/.test(x) && !/^\[.*\]$/.test(x));
  const href = ['/partner', ...segs].join('/');
  const key = Object.entries(PARTNER_ROUTES).find(([, r]) => r.href === href)?.[0];
  if (!key) return [`${file}: no PARTNER_ROUTES entry for ${href}`];
  const problems: string[] = [];
  const calls = [...src.matchAll(/requirePartnerStaff\(([^)]*)\)/g)].map((m) => m[1].trim());
  if (calls.length === 0) problems.push(`${file}: no requirePartnerStaff call`);
  for (const args of calls) {
    const m = /^PARTNER_ROUTES\.(\w+)\.policy(?:\s*,\s*(\{[^}]*\}))?$/.exec(args);
    if (!m) {
      problems.push(`${file}: gate is not PARTNER_ROUTES.${key}.policy: ${args}`);
      continue;
    }
    if (m[1] !== key) problems.push(`${file}: gates with ${m[1]}, expected ${key}`);
    if (m[2] !== undefined && !(file === SECURITY_PAGE && /^\{\s*skipMfa:\s*true\s*\}$/.test(m[2]))) {
      problems.push(`${file}: options ${m[2]} are allowed only as { skipMfa: true } on the security page`);
    }
  }
  if (!/await requirePartnerStaff\(/.test(src)) problems.push(`${file}: the gate is not awaited`);
  return problems;
}

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
  it('EVERY page under (app) gates with ITS OWN routes.ts key; skipMfa only on the security page', () => {
    const pages = (d: string): string[] =>
      readdirSync(d).flatMap((n) => {
        const p = join(d, n);
        return statSync(p).isDirectory() ? pages(p) : n === 'page.tsx' ? [p] : [];
      });
    const found = pages('src/app/partner/(app)');
    expect(found.length).toBeGreaterThanOrEqual(2);
    for (const f of found) expect(gateProblems(f, readFileSync(f, 'utf8')), f).toEqual([]);
  });
  it('the gate check itself catches a wrong key, a stray skipMfa, a direct policy and a missing gate', () => {
    const home = 'src/app/partner/(app)/page.tsx';
    const sec = 'src/app/partner/(app)/security/page.tsx';
    expect(gateProblems(home, 'await requirePartnerStaff(PARTNER_ROUTES.home.policy);')).toEqual([]);
    expect(gateProblems(sec, 'await requirePartnerStaff(PARTNER_ROUTES.security.policy, { skipMfa: true });')).toEqual([]);
    expect(gateProblems(home, 'await requirePartnerStaff(PARTNER_ROUTES.security.policy);')).not.toEqual([]);
    expect(gateProblems(home, 'await requirePartnerStaff(PARTNER_ROUTES.home.policy, { skipMfa: true });')).not.toEqual([]);
    expect(
      gateProblems(home, 'await requirePartnerStaff(PARTNER_ROUTES.home.policy);\nawait requirePartnerStaff(PARTNER_ANY);'),
    ).not.toEqual([]);
    expect(gateProblems(home, 'export default function P() { return null; }')).not.toEqual([]);
    // A commented-out gate is no gate (LOW-5): comments are stripped before matching.
    expect(gateProblems(home, '// await requirePartnerStaff(PARTNER_ROUTES.home.policy);\nexport default function P() { return null; }')).not.toEqual([]);
    expect(gateProblems(home, '/* await requirePartnerStaff(PARTNER_ROUTES.home.policy); */ export default function P() { return null; }')).not.toEqual([]);
    expect(gateProblems('src/app/partner/(app)/nowhere/page.tsx', 'await requirePartnerStaff(PARTNER_ROUTES.home.policy);')).not.toEqual([]);
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

describe('/partner mobile menu', () => {
  // The <details> menu is keyed on the pathname, so a client-side navigation remounts it closed
  // (otherwise it stays open over the new page). No DOM here: read the key off the element tree.
  const menuKey = () => {
    const tree = PartnerSidebar({ label: 'Nav', menuLabel: 'Menu', items: [{ href: '/partner', label: 'Home' }] });
    const kids = (tree.props as { children: React.ReactElement[] }).children;
    const details = kids.find((k) => k && k.type === 'details');
    expect(details).toBeDefined();
    return details!.key;
  };
  it('remounts (a new key) when the pathname changes, so it closes after navigating', () => {
    pathname.current = '/partner';
    const a = menuKey();
    pathname.current = '/partner/security';
    const b = menuKey();
    expect(a).not.toBeNull();
    expect(a).not.toBe(b);
  });
});
