import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import type { Staff } from '@/lib/types';
import type { Db } from '@/db/client';

// The M3-1 Task 1.3 harness, plus an injectable "enrolled" set on the real MFA store.
const redis = fakeRedis();
let pgPartnerStore: PartnerStore;
let homeDb: Db;
const enrolled = new Set<string>();
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
vi.mock('next/navigation', () => ({
  redirect: redirectMock,
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
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
vi.mock('@/lib/staff-mfa-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-mfa-store')>('@/lib/staff-mfa-store');
  return {
    ...actual,
    getStaffMfaStore: () => {
      const s = actual.createStaffMfaStore(redis);
      const real = s.isEnrolled.bind(s);
      s.isEnrolled = async (u: string) => enrolled.has(u) || real(u);
      return s;
    },
  };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => pgPartnerStore };
});

import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { MFA_PENDING_PREFIX } from '@/lib/partner-mfa-gate';
import SecurityPage from '@/app/partner/(app)/security/page';
import HomePage from '@/app/partner/(app)/page';

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
const render = async (el: Promise<React.ReactElement>) => renderToStaticMarkup(await el);

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  enrolled.clear();
  redirectMock.mockClear();
  const db = await freshDb();
  homeDb = db;
  pgPartnerStore = createPartnerStore(db);
  await seedPartner(db, 'pa');
});

describe('/partner/security', () => {
  it('anonymous → /login', async () => {
    await expect(SecurityPage()).rejects.toThrow('REDIRECT:/login');
  });
  it('platform admin → /admin-dashboard', async () => {
    await signInAs({ partnerId: undefined });
    await expect(SecurityPage()).rejects.toThrow('REDIRECT:/admin-dashboard');
  });
  it('pending enrolment: shows the enrol panel and the "required" notice, never redirects to itself', async () => {
    await signInAs({ partnerId: 'pa', role: 'agent' });
    await redis.set(`${MFA_PENDING_PREFIX}u1`, '1');
    const html = await render(SecurityPage());
    expect(html).toContain('data-testid="partner-mfa-required"');
    expect(html).toContain('name="currentPassword"');
    expect(html).toContain('class="sh-page-title');
    expect(redirectMock).not.toHaveBeenCalled();
  });
  it('not required and not enrolled: the panel, status "off" as text, no "required" notice', async () => {
    await signInAs({ partnerId: 'pa', role: 'support' });
    const html = await render(SecurityPage());
    expect(html).not.toContain('data-testid="partner-mfa-required"');
    expect(html).toContain('name="currentPassword"');
    expect(html).toContain('data-testid="partner-mfa-status"');
    expect(html).toContain('Off');
  });
  it('enrolled: status "on", no panel, a way back to /partner, and a stale invite marker is cleared', async () => {
    await signInAs({ partnerId: 'pa', role: 'agent' });
    await redis.set(`${MFA_PENDING_PREFIX}u1`, '1');
    enrolled.add('u1');
    const html = await render(SecurityPage());
    expect(html).toContain('On');
    expect(html).not.toContain('name="currentPassword"');
    expect(html).not.toContain('data-testid="partner-mfa-required"');
    expect(html).toContain('href="/partner"');
    expect(await redis.get(`${MFA_PENDING_PREFIX}u1`)).toBeNull();
  });
  it('renders no session or tenant detail beyond the page (no username, no partner id)', async () => {
    await signInAs({ username: 'pa-secret-user', partnerId: 'pa', role: 'admin' });
    const html = await render(SecurityPage());
    expect(html).not.toContain('pa-secret-user');
  });
});

describe('/partner (the M3-1 home stub; M3-2 adds the shell)', () => {
  it('anonymous → /login', async () => {
    await expect(HomePage()).rejects.toThrow('REDIRECT:/login');
  });
  it('platform admin → /admin-dashboard', async () => {
    await signInAs({ partnerId: undefined });
    await expect(HomePage()).rejects.toThrow('REDIRECT:/admin-dashboard');
  });
  it('an invite-marked, unenrolled account is sent to enrolment', async () => {
    await signInAs({ partnerId: 'pa', role: 'agent' });
    await redis.set(`${MFA_PENDING_PREFIX}u1`, '1');
    await expect(HomePage()).rejects.toThrow('REDIRECT:/partner/security?enroll=1');
  });
  it('every partner role sees the page and the security link', async () => {
    for (const [i, role] of (['admin', 'agent', 'support'] as const).entries()) {
      await signInAs({ username: `r${i}`, partnerId: 'pa', role });
      const html = await render(HomePage());
      expect(html).toContain('class="sh-page-title');
      expect(html).toContain('href="/partner/security"');
    }
  });
});

describe('src/app/partner imports (landing look, no legacy UI, no admin actions)', () => {
  const files = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : [];
    });
  it('never imports shadcn ui/*, and from /admin-dashboard only the self-gated account enrolment actions', () => {
    for (const f of files('src/app/partner')) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/from '@\/components\/ui\//);
      for (const m of src.matchAll(/from '(@\/app\/admin-dashboard[^']*)'/g)) {
        expect(m[1], f).toBe('@/app/admin-dashboard/account/actions');
      }
    }
  });
  // M3-9: the ONE public page (the emailed invite link: no session exists yet). It must be rate-limited
  // before any read and never read a staff session.
  const PUBLIC_PAGES = [join('src/app/partner/invite/[token]/page.tsx')];
  it('every page calls requirePartnerStaff (nav hiding is never the guard)', () => {
    for (const f of files('src/app/partner').filter((p) => p.endsWith('page.tsx') && !PUBLIC_PAGES.includes(p))) {
      expect(readFileSync(f, 'utf8'), f).toMatch(/await requirePartnerStaff\(/);
    }
  });
  it('M3-9: the public invite page is rate-limited first and reads no staff session', () => {
    for (const f of PUBLIC_PAGES) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).toMatch(/await isIpRateLimited\(/);
      expect(src, f).not.toMatch(/getCurrentStaff|requireStaff|requirePartnerStaff|cookies\(/);
    }
  });
});
