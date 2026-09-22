import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';
import { createPartnerStore } from '@/lib/partner-store';
import { createWaitlistRepo } from '@/db/repos/waitlist-repo';

/**
 * /admin-dashboard/waitlist — the gate + the audited export, exercised through
 * the REAL requireStaff/requireScope chain (cookie → session → staff → partner
 * status). Only the I/O seams are stubbed: cookies, redirect/notFound (both
 * throw tagged errors), the auth store (fakeRedis), the partner store + db (PGlite).
 */

const redis = fakeRedis();
const cookieJar = new Map<string, string>();
let db: Db;
let pgPartnerStore: ReturnType<typeof createPartnerStore>;

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (n: string) => cookieJar.delete(n),
  }),
}));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error(`REDIRECT:${p}`);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => pgPartnerStore };
});
vi.mock('@/lib/seed', () => ({ ensureSeedAdmin: async () => {} }));
vi.mock('@/db/client', async (orig) => ({
  ...((await orig()) as object),
  getDb: () => db,
}));

import WaitlistPage from '@/app/admin-dashboard/waitlist/page';
import { POST as exportPost, GET as exportGet } from '@/app/admin-dashboard/waitlist/export/route';
import { NextRequest } from 'next/server';

const EXPORT_URL = 'https://smartremit.test/admin-dashboard/waitlist/export';
/** A browser form POST from the dashboard: same-origin `origin` + `host`. */
function postReq(over: Record<string, string | null> = {}): NextRequest {
  const h = new Headers({ origin: 'https://smartremit.test', host: 'smartremit.test' });
  for (const [k, v] of Object.entries(over)) {
    if (v === null) h.delete(k);
    else h.set(k, v);
  }
  return new NextRequest(EXPORT_URL, { method: 'POST', headers: h });
}
import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { visibleNavItems } from '@/app/admin-dashboard/nav';

function staff(over: Partial<Staff>): Staff {
  return {
    username: 'u',
    name: 'U',
    role: 'admin',
    permissions: { canCancel: true, canResend: true, canAssign: true },
    passwordHash: 'x',
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

async function signIn(s: Staff): Promise<void> {
  const store = getAuthStore();
  await store.saveStaff(s);
  cookieJar.set(SESSION_COOKIE, await store.createSession(s.username));
}

const SIGNUP = {
  id: 'wl_1',
  fullName: 'Asha Patel',
  email: 'asha@example.com',
  phone: '+15551234567',
  location: 'Fairfax, VA',
  destinations: ['IN'],
  consentAt: '2026-09-21T10:00:00.000Z',
  consentTextVersion: 'v1',
  utmSource: undefined,
  utmCampaign: undefined,
};

async function auditRows(): Promise<{ actor: string; action: string; meta: Record<string, unknown> | null; partner_id: string | null }[]> {
  const res = await db.execute(sql`SELECT actor, action, meta, partner_id FROM audit_events ORDER BY id`);
  return (res as unknown as { rows: { actor: string; action: string; meta: Record<string, unknown> | null; partner_id: string | null }[] }).rows;
}

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'acme');
  pgPartnerStore = createPartnerStore(db);
  redis.dump.clear();
  cookieJar.clear();
  await createWaitlistRepo(db).insertIfNew(SIGNUP);
});

describe('the page gate', () => {
  it('anonymous → redirect to /login', async () => {
    await expect(WaitlistPage()).rejects.toThrow('REDIRECT:/login');
  });

  it('partner-scoped staff (even an admin) → 404, never 403', async () => {
    await signIn(staff({ username: 'pa', role: 'admin', partnerId: 'acme' }));
    await expect(WaitlistPage()).rejects.toThrow('NOT_FOUND');
  });

  it('support staff → bounced to tickets (requireScope)', async () => {
    await signIn(staff({ username: 's', role: 'support' }));
    await expect(WaitlistPage()).rejects.toThrow('REDIRECT:/admin-dashboard/tickets');
  });

  it('platform admin → renders', async () => {
    await signIn(staff({ username: 'admin' }));
    await expect(WaitlistPage()).resolves.toBeTruthy();
  });

  it('platform agent → renders the MASKED list too (platform staff, not admin-only); only the export is admin-only', async () => {
    await signIn(staff({ username: 'ag', role: 'agent' }));
    await expect(WaitlistPage()).resolves.toBeTruthy();
  });

  it('the nav shows Waitlist to platform admins only', () => {
    expect(visibleNavItems(staff({}))).toContain('waitlist');
    expect(visibleNavItems(staff({ partnerId: 'acme' }))).not.toContain('waitlist');
    expect(visibleNavItems(staff({ role: 'agent' }))).not.toContain('waitlist');
    expect(visibleNavItems(staff({ role: 'support' }))).not.toContain('waitlist');
  });
});

describe('/admin-dashboard/waitlist/export', () => {
  it('GET never exports and never audits — even for a signed-in platform admin (no side effect on a GET)', async () => {
    await signIn(staff({ username: 'admin' }));
    const res = await exportGet();
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type') ?? '').not.toMatch(/csv/);
    expect(await res.text()).not.toContain('Asha');
    expect(await auditRows()).toHaveLength(0);
  });

  it('POST anonymous → redirect to /login, no audit row', async () => {
    await expect(exportPost(postReq())).rejects.toThrow('REDIRECT:/login');
    expect(await auditRows()).toHaveLength(0);
  });

  it('POST partner-scoped admin → 404 body (not 403), no audit row', async () => {
    await signIn(staff({ username: 'pa', role: 'admin', partnerId: 'acme' }));
    const res = await exportPost(postReq());
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type') ?? '').not.toMatch(/csv/);
    expect(await auditRows()).toHaveLength(0);
  });

  it('POST platform agent (not admin) → 404: the decrypted export is admin-only', async () => {
    await signIn(staff({ username: 'ag', role: 'agent' }));
    expect((await exportPost(postReq())).status).toBe(404);
    expect(await auditRows()).toHaveLength(0);
  });

  it.each([
    ['a cross-site origin', { origin: 'https://evil.example' }],
    ['a missing origin header (fail closed)', { origin: null }],
    ['a malformed origin', { origin: 'not a url' }],
    ['an origin matching host but not the proxy-set x-forwarded-host', { origin: 'https://smartremit.test', 'x-forwarded-host': 'smartremit.ai' }],
  ])('POST by a platform admin with %s → 403, no export, no audit row (CSRF guard)', async (_l, over) => {
    await signIn(staff({ username: 'admin' }));
    const res = await exportPost(postReq(over));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('Asha');
    expect(await auditRows()).toHaveLength(0);
  });

  it('POST behind a proxy: origin matching x-forwarded-host is accepted (the Next.js server-action rule)', async () => {
    await signIn(staff({ username: 'admin' }));
    const res = await exportPost(postReq({ host: 'internal-fn.vercel', 'x-forwarded-host': 'smartremit.test' }));
    expect(res.status).toBe(200);
    expect(await auditRows()).toHaveLength(1);
  });

  it('POST platform admin → decrypted CSV as an attachment, no-store, and ONE waitlist.export audit row (row count, no PII)', async () => {
    await signIn(staff({ username: 'admin' }));
    const res = await exportPost(postReq());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/csv/);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="waitlist-.*\.csv"$/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.text();
    expect(body.split('\r\n')[0]).toMatch(/^id,full_name,email,phone/);
    expect(body).toContain('Asha Patel');
    expect(body).toContain('asha@example.com');
    expect(body).toContain("\"'+15551234567\""); // formula-neutralised phone

    const audit = await auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toEqual({ actor: 'admin', action: 'waitlist.export', meta: { rowCount: 1 }, partner_id: null });
    expect(JSON.stringify(audit[0])).not.toMatch(/Asha|asha@|5551234567/);
  });
});
