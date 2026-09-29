import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// UI redesign M3-16: /partner/reports. The page gates itself (money read), lists only the SESSION
// tenant's jobs, and only the kinds the role may open (reportPolicy — the same rule the request
// action and the download route use). The download is a plain <a download>, never a prefetching Link.
const redis = fakeRedis();
const box: { db: Db | null } = { db: null };
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

import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { partnerReportJobs } from '@/db/schema';
import ReportsPage from '@/app/partner/(app)/reports/page';

const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
async function signInAs(o: Partial<Staff>): Promise<void> {
  const s: Staff = { username: 'pa-admin', name: 'U', role: 'admin', permissions: perms, passwordHash: 'x', createdAt: new Date().toISOString(), partnerId: 'pa', ...o };
  await getAuthStore().saveStaff(s);
  cookieJar.clear();
  cookieJar.set(SESSION_COOKIE, await getAuthStore().createSession(s.username));
}
const render = async () => renderToStaticMarkup(await ReportsPage());

const FIN = randomUUID();
const TX = randomUUID();
const PB_JOB = randomUUID();
const future = () => new Date(Date.now() + 86_400_000);
const win = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-11T00:00:00.000Z' };

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  box.db = await freshDb();
  await seedPartner(box.db, 'pa');
  await seedPartner(box.db, 'pb');
  await box.db.insert(partnerReportJobs).values([
    { id: FIN, partnerId: 'pa', kind: 'settlements', params: win, requestedBy: 'pa-fin', status: 'ready', contentEnc: 'v2.SECRET', rowCount: 4, expiresAt: future() },
    { id: TX, partnerId: 'pa', kind: 'transfers', params: { ...win, environment: 'live' }, requestedBy: 'pa-agent', status: 'ready', contentEnc: 'v2.SECRET', rowCount: 2, expiresAt: future() },
    { id: PB_JOB, partnerId: 'pb', kind: 'transfers', params: win, requestedBy: 'pb-admin', status: 'ready', contentEnc: 'v2.SECRET', rowCount: 9, expiresAt: future() },
  ]);
});

const kindOptions = (html: string) => [...html.matchAll(/<option value="([a-z_]+)"/g)].map((m) => m[1]);

describe('/partner/reports page', () => {
  it('admin: both of pa’s jobs, never pb’s; every kind offered; never the sealed content', async () => {
    await signInAs({});
    const html = await render();
    expect(html).toContain(FIN);
    expect(html).toContain(TX);
    expect(html).not.toContain(PB_JOB);
    expect(html).not.toContain('v2.SECRET');
    expect(kindOptions(html)).toEqual(['settlements', 'transfers', 'fees_monthly']);
  });

  it('agent: only the transfers job and only the transfers kind (reportPolicy on the list)', async () => {
    await signInAs({ username: 'pa-agent', role: 'agent' });
    const html = await render();
    expect(html).toContain(TX);
    expect(html).not.toContain(FIN);
    expect(html).not.toContain(PB_JOB);
    expect(kindOptions(html)).toEqual(['transfers']);
  });

  it('the download is a plain <a download> to the route, not a prefetching Link', async () => {
    await signInAs({});
    const html = await render();
    const a = html.match(new RegExp(`<a[^>]*href="/partner/reports/${TX}/download"[^>]*>`))?.[0];
    expect(a).toBeTruthy();
    expect(a).toMatch(/\sdownload(=""|\s|>)/);
  });

  it('an expired (by expires_at) job shows no download link', async () => {
    const { eq } = await import('drizzle-orm');
    await box.db!.update(partnerReportJobs).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(partnerReportJobs.id, TX));
    await signInAs({});
    const html = await render();
    expect(html).toContain(TX);
    expect(html).not.toContain(`/partner/reports/${TX}/download`);
  });

  it('gate: support → /partner; anonymous → /login', async () => {
    await expect(render()).rejects.toThrow('REDIRECT:/login');
    await signInAs({ username: 'pa-support', role: 'support' });
    await expect(render()).rejects.toThrow('REDIRECT:/partner');
  });
});
