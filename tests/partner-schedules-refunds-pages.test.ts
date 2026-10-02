import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { seedPartnerTransfer, seedTwoTenants, signInAs } from './helpers-partner-app';
import type { Db } from '@/db/client';
import type { Schedule } from '@/lib/types';

// Merge plan 2a/2b: /partner/schedules and /partner/refunds render on PGlite. The read is pinned to
// the SESSION tenant, no seeded PII reaches the HTML, support is refused, and the decision controls
// render for admins only (D1).
const redis = fakeRedis();
const cookieJar = new Map<string, string>();
let db: Db;

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
  usePathname: () => '/partner',
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
  return { ...actual, getPartnerStore: () => actual.createPartnerStore(db) };
});

import SchedulesPage from '@/app/partner/(app)/schedules/page';
import RefundsPage from '@/app/partner/(app)/refunds/page';
import { createScheduleRepo } from '@/db/repos/schedule-repo';

const PII = ['15550006666', '919800004444', '000011112222', 'HDFC0001111', 'Lastname', 'Testname Samplesurname', 'Samplesurname', '14155550101'];
const schedulesHtml = async (sp: Record<string, string> = {}) => renderToStaticMarkup(await SchedulesPage({ searchParams: Promise.resolve(sp) }));
const refundsHtml = async () => renderToStaticMarkup(await RefundsPage());

function schedule(id: string, partnerId: string, o: Partial<Schedule> = {}): Schedule {
  return {
    id, phone: '15550006666', amountUsd: 75, recipientName: 'Firstname Lastname', recipientPhone: '919800004444',
    payoutMethod: 'bank', payoutDestination: '000011112222|HDFC0001111', fundingMethod: 'bank_transfer', frequency: 'monthly', dayOfMonth: 9,
    status: 'active', createdAt: new Date(Date.now() - 60_000).toISOString(), partnerId, sourceCurrency: 'USD', amountSource: 75, ...o,
  };
}

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  db = await freshDb();
  await seedTwoTenants(db);
  const repo = createScheduleRepo(db);
  await repo.saveSchedule(schedule('sch_a_active', 'pa'));
  await repo.saveSchedule(schedule('sch_a_cancelled', 'pa', { status: 'cancelled' }));
  await repo.saveSchedule(schedule('sch_b_active', 'pb'));
  await seedPartnerTransfer(db, { id: 'tr_ref_a', partnerId: 'pa', status: 'cancelled', fundingRef: 'f1', refundStatus: 'requested' });
  await seedPartnerTransfer(db, { id: 'tr_ref_a2', partnerId: 'pa', status: 'cancelled', fundingRef: 'f2', refundStatus: 'completed' });
  await seedPartnerTransfer(db, { id: 'tr_ref_b', partnerId: 'pb', status: 'cancelled', fundingRef: 'f3', refundStatus: 'requested' });
});

describe('/partner/schedules', () => {
  it('gate: anonymous → /login, platform → /admin-dashboard, support → /partner', async () => {
    await expect(schedulesHtml()).rejects.toThrow('REDIRECT:/login');
    await signInAs(redis, cookieJar, { username: 'plat', partnerId: undefined });
    await expect(schedulesHtml()).rejects.toThrow('REDIRECT:/admin-dashboard');
    await signInAs(redis, cookieJar, { username: 'pa-support', partnerId: 'pa', role: 'support' });
    await expect(schedulesHtml()).rejects.toThrow('REDIRECT:/partner');
  });
  it("admin: the tenant's open schedules with controls, masked, nothing of tenant B", async () => {
    await signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin' });
    const html = await schedulesHtml();
    expect(html).toContain('data-row="sch_a_active"');
    expect(html).not.toContain('sch_a_cancelled');
    expect(html).not.toContain('sch_b_active');
    expect(html).toContain('data-testid="partner-schedule-controls"');
    expect(html).toContain('Firstname L.');
    for (const p of PII) expect(html).not.toContain(p);
    expect(await schedulesHtml({ show: 'all' })).toContain('data-row="sch_a_cancelled"');
  });
  it('agent and finance: the list without controls (D1)', async () => {
    for (const role of ['agent', 'finance'] as const) {
      await signInAs(redis, cookieJar, { username: `pa-${role}`, partnerId: 'pa', role });
      const html = await schedulesHtml();
      expect(html).toContain('data-row="sch_a_active"');
      expect(html).not.toContain('partner-schedule-controls');
    }
  });
});

describe('/partner/refunds', () => {
  it('gate: support → /partner', async () => {
    await signInAs(redis, cookieJar, { username: 'pa-support', partnerId: 'pa', role: 'support' });
    await expect(refundsHtml()).rejects.toThrow('REDIRECT:/partner');
  });
  it("admin: the tenant's refunds with counts and controls, masked, nothing of tenant B", async () => {
    await signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin' });
    const html = await refundsHtml();
    expect(html).toContain('data-row="tr_ref_a"');
    expect(html).toContain('data-row="tr_ref_a2"');
    expect(html).not.toContain('tr_ref_b');
    expect(html).toMatch(/data-count="requested"[^>]*>1</);
    expect(html).toMatch(/data-count="completed"[^>]*>1</);
    expect(html).toContain('data-testid="partner-refund-controls"');
    expect(html).toContain('••••0101');
    for (const p of PII) expect(html).not.toContain(p);
  });
  it('agent and finance: the list without controls (D1)', async () => {
    for (const role of ['agent', 'finance'] as const) {
      await signInAs(redis, cookieJar, { username: `pa-${role}`, partnerId: 'pa', role });
      const html = await refundsHtml();
      expect(html).toContain('data-row="tr_ref_a"');
      expect(html).not.toContain('partner-refund-controls');
    }
  });
});
