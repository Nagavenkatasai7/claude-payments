import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { seedPartnerTransfer, seedTwoTenants, signInAs } from './helpers-partner-app';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import type { Db } from '@/db/client';

// Merge plan 2d: /partner/analytics on PGlite. The read is pinned to the SESSION tenant (a smuggled
// ?partnerId is ignored), live rows only, the window is allowlisted, and no seeded PII reaches the HTML.
const redis = fakeRedis();
const cookieJar = new Map<string, string>();
let db: Db;
let pgPartnerStore: PartnerStore;
const fail = { read: false };

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers(),
}));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error('REDIRECT:' + p);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => pgPartnerStore };
});
vi.mock('@/db/repos/partner-analytics-reads', async () => {
  const actual = await vi.importActual<typeof import('@/db/repos/partner-analytics-reads')>('@/db/repos/partner-analytics-reads');
  return {
    ...actual,
    listPartnerLiveTransfersSince: (...a: Parameters<typeof actual.listPartnerLiveTransfersSince>) =>
      fail.read ? Promise.reject(new Error('db down 14155550101')) : actual.listPartnerLiveTransfersSince(...a),
  };
});

import AnalyticsPage from '@/app/partner/(app)/analytics/page';
import { listPartnerLiveTransfersSince } from '@/db/repos/partner-analytics-reads';

const DAY = 86_400_000;
const page = async (sp: Record<string, string> = {}) => renderToStaticMarkup(await AnalyticsPage({ searchParams: Promise.resolve(sp) }));
const kpi = (html: string, name: string) => html.match(new RegExp(`data-kpi="${name}"[^>]*>(?:<span[^>]*>)?([^<]*)<`))?.[1];
// p3 B8: the shortened recipient name ('Testname S.') may show; the full surname never does.
const PII = ['14155550101', '5550101', '919876543210', '000011112222', 'HDFC0001111', 'Samplesurname'];
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  fail.read = false;
  db = await freshDb();
  pgPartnerStore = createPartnerStore(db);
  await seedTwoTenants(db);
  await seedPartnerTransfer(db, { id: 'tr_A_1', partnerId: 'pa', amountUsd: 100, feeUsd: 2, status: 'delivered', createdAt: ago(60_000) });
  await seedPartnerTransfer(db, { id: 'tr_A_2', partnerId: 'pa', amountUsd: 40, feeUsd: 1, status: 'awaiting_payment', createdAt: ago(2 * DAY) });
  await seedPartnerTransfer(db, { id: 'tr_A_old', partnerId: 'pa', amountUsd: 500, feeUsd: 5, status: 'paid', createdAt: ago(20 * DAY) });
  await seedPartnerTransfer(db, { id: 'tr_A_test', partnerId: 'pa', amountUsd: 9000, feeUsd: 90, status: 'paid', environment: 'test', createdAt: ago(60_000) });
  await seedPartnerTransfer(db, { id: 'tr_B_1', partnerId: 'pb', amountUsd: 7777, feeUsd: 77, status: 'delivered', createdAt: ago(60_000) });
});

describe('/partner/analytics: gate', () => {
  it('anonymous → /login; platform → /admin-dashboard; support → /partner', async () => {
    await expect(page()).rejects.toThrow('REDIRECT:/login');
    await signInAs(redis, cookieJar, { username: 'plat', partnerId: undefined });
    await expect(page()).rejects.toThrow('REDIRECT:/admin-dashboard');
    await signInAs(redis, cookieJar, { username: 'pa-support', partnerId: 'pa', role: 'support' });
    await expect(page()).rejects.toThrow('REDIRECT:/partner');
  });
  it('admin, agent and finance may open it', async () => {
    for (const role of ['admin', 'agent', 'finance'] as const) {
      await signInAs(redis, cookieJar, { username: `pa-${role}`, partnerId: 'pa', role });
      expect(await page()).toContain('Analytics');
    }
  });
});

describe('/partner/analytics: data', () => {
  it("totals only this tenant's LIVE transfers in the default 30-day window", async () => {
    await signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin' });
    const html = await page();
    expect(kpi(html, 'count')).toBe('3');
    expect(kpi(html, 'volume')).toBe('$640.00');
    expect(kpi(html, 'fees')).toBe('$7.00');
    expect(html).not.toContain('7,777');
    expect(html).not.toContain('9,000');
    expect((html.match(/<h1\b/g) ?? []).length).toBe(1);
    for (const p of PII) expect(html, p).not.toContain(p);
  });
  it('the 7-day window excludes older rows; junk windows fall back to 30', async () => {
    await signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin' });
    const week = await page({ window: '7' });
    expect(kpi(week, 'count')).toBe('2');
    const current = [...week.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]).filter((a) => a.includes('aria-current="page"'));
    expect(current).toHaveLength(1);
    expect(current[0]).toContain('href="/partner/analytics?window=7"');
    expect(kpi(await page({ window: '365' }), 'count')).toBe('3');
    expect(kpi(await page({ window: "7' OR 1=1" }), 'count')).toBe('3');
  });
  it('?partnerId=pb / ?partner=pb are ignored', async () => {
    await signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin' });
    const html = await page({ partnerId: 'pb', partner: 'pb' } as Record<string, string>);
    expect(kpi(html, 'count')).toBe('3');
    expect(html).not.toContain('7,777');
  });
  it('an empty period shows the empty state', async () => {
    await signInAs(redis, cookieJar, { username: 'pb-admin', partnerId: 'pb', role: 'admin' });
    await db.delete((await import('@/db/schema')).transfers);
    expect(await page()).toContain('No transfers in this period');
  });
  it('top recipients: the card renders with its note; no full recipient name anywhere on the page', async () => {
    await signInAs(redis, cookieJar, { username: 'pa-finance', partnerId: 'pa', role: 'finance' });
    const html = await page();
    expect(html).toContain('Top recipients');
    expect(html).toContain('data-recipients-note');
    expect(html).not.toContain('Samplesurname');
  });
  it('a failed read shows fixed copy (no raw error text)', async () => {
    await signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin' });
    fail.read = true;
    const html = await page();
    expect(html).toContain('Analytics could not be loaded');
    expect(html).not.toContain('14155550101');
  });
});

describe('listPartnerLiveTransfersSince', () => {
  it('requires a tenant, pins it, stops at the window and reports the cap', async () => {
    await expect(listPartnerLiveTransfersSince(db, '', { now: Date.now(), days: 30, cap: 10 })).rejects.toThrow();
    const all = await listPartnerLiveTransfersSince(db, 'pa', { now: Date.now(), days: 30, cap: 10 });
    expect(all.items.map((t) => t.id).sort()).toEqual(['tr_A_1', 'tr_A_2', 'tr_A_old']);
    expect(all.truncated).toBe(false);
    const week = await listPartnerLiveTransfersSince(db, 'pa', { now: Date.now(), days: 7, cap: 10 });
    expect(week.items.map((t) => t.id).sort()).toEqual(['tr_A_1', 'tr_A_2']);
    const capped = await listPartnerLiveTransfersSince(db, 'pa', { now: Date.now(), days: 30, cap: 1 });
    expect(capped).toMatchObject({ truncated: true });
    expect(capped.items.map((t) => t.id)).toEqual(['tr_A_1']);
    // Masked rows: no decrypted payout destination.
    expect(JSON.stringify(all.items)).not.toContain('000011112222');
  });
});
