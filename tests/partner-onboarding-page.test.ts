import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// UI redesign M3-20: /partner/onboarding. Admin only (agent/support/finance → /partner); the
// SESSION tenant's facts only; no secret, URL or phone number id ever reaches the HTML; a
// backfilled approved partner shows Live with no request button; a facts read failure shows the
// error state; viewing writes nothing.

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
  usePathname: () => '/partner/onboarding',
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
const factsFail = vi.hoisted(() => ({ on: false }));
vi.mock('@/db/repos/partner-onboarding-facts', async (orig) => {
  const actual = await orig<typeof import('@/db/repos/partner-onboarding-facts')>();
  return {
    ...actual,
    loadOnboardingFacts: (...a: Parameters<typeof actual.loadOnboardingFacts>) => (factsFail.on ? Promise.reject(new Error('db down')) : actual.loadOnboardingFacts(...a)),
  };
});

import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { auditEvents, outbox, partnerGoLive } from '@/db/schema';
import { t } from '@/lib/i18n';
import OnboardingPage from '@/app/partner/(app)/onboarding/page';
import { ONBOARDING_SECRETS, seedOnboardingComplete } from './helpers-partner-onboarding';

const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
async function signInAs(o: Partial<Staff>): Promise<void> {
  const s: Staff = { username: 'pa-admin', name: 'A', role: 'admin', permissions: perms, passwordHash: 'x', createdAt: new Date().toISOString(), partnerId: 'pa', ...o };
  await getAuthStore().saveStaff(s);
  cookieJar.set(SESSION_COOKIE, await getAuthStore().createSession(s.username));
}
const render = async () => renderToStaticMarkup(await OnboardingPage());
const decode = (html: string) => html.replaceAll('&amp;', '&').replaceAll('&#x27;', "'").replaceAll('&quot;', '"');
const stepStates = (html: string) => [...html.matchAll(/data-step="(\d)" data-done="(true|false)"/g)].map((m) => [Number(m[1]), m[2] === 'true']);

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  factsFail.on = false;
  db = await freshDb();
  await seedPartner(db, 'pa', 'Partner A');
  await seedPartner(db, 'pb', 'Partner B');
});

describe('/partner/onboarding: the gate', () => {
  it('anonymous → /login; platform → /admin-dashboard; agent, support, finance → /partner', async () => {
    await expect(OnboardingPage()).rejects.toThrow('REDIRECT:/login');
    await signInAs({ username: 'plat', partnerId: undefined });
    await expect(OnboardingPage()).rejects.toThrow('REDIRECT:/admin-dashboard');
    for (const role of ['agent', 'support', 'finance'] as const) {
      await signInAs({ username: `pa-${role}`, role });
      await expect(OnboardingPage()).rejects.toThrow('REDIRECT:/partner');
    }
  });
});

describe('/partner/onboarding: the checklist', () => {
  it('B complete, A empty → A sees seven steps, none done, and no enabled request button', async () => {
    await seedOnboardingComplete(db, redis, 'pb', '111222333444');
    await signInAs({});
    const html = decode(await render());
    expect(stepStates(html)).toEqual([1, 2, 3, 4, 5, 6, 7].map((n) => [n, false]));
    expect(html).toContain(t('partner.onboarding.state.in_progress'));
    expect(html).toContain(t('partner.onboarding.request.blocked'));
    expect(html).toMatch(/data-testid="partner-onboarding-request"[^>]*disabled/);
  });
  it('A complete (1–6) → ready, the request button is enabled, templates show as confirmed', async () => {
    await seedOnboardingComplete(db, redis, 'pa');
    await signInAs({});
    const html = decode(await render());
    expect(stepStates(html)).toEqual([1, 2, 3, 4, 5, 6, 7].map((n) => [n, n !== 7]));
    expect(html).toContain(t('partner.onboarding.state.ready'));
    expect(html).not.toMatch(/data-testid="partner-onboarding-request"[^>]*disabled/);
    expect(html).toContain(t('partner.onboarding.attest.done'));
    expect(html).not.toContain('data-testid="partner-onboarding-attest-form"');
  });
  it('never renders a secret, the endpoint URL or the phone number id', async () => {
    await seedOnboardingComplete(db, redis, 'pa');
    await signInAs({});
    const html = decode(await render());
    for (const v of Object.values(ONBOARDING_SECRETS)) expect(html).not.toContain(v);
    expect(html).not.toContain('rail.example.com');
  });
  it('the attestation form shows until templates are attested', async () => {
    await signInAs({});
    const html = decode(await render());
    expect(html).toContain('data-testid="partner-onboarding-attest-form"');
    expect(html).toContain('name="authentication"');
    expect(html).toContain('name="transfer_delivered"');
  });
  it('requested → waiting for SmartRemit, no request button', async () => {
    await seedOnboardingComplete(db, redis, 'pa');
    await db.insert(partnerGoLive).values({ partnerId: 'pa', requestedAt: new Date(), requestedBy: 'pa-admin' });
    await signInAs({});
    const html = decode(await render());
    expect(html).toContain(t('partner.onboarding.state.requested'));
    expect(html).toContain(t('partner.onboarding.requestedNote'));
    expect(html).not.toContain('data-testid="partner-onboarding-request"');
    expect(stepStates(html).at(-1)).toEqual([7, true]);
  });
  it('a backfilled approved partner → Live, informational, no request button', async () => {
    await db.insert(partnerGoLive).values({ partnerId: 'pa', approvedAt: new Date(), approvedBy: 'system:0028-backfill' });
    await signInAs({});
    const html = decode(await render());
    expect(html).toContain(t('partner.onboarding.state.live'));
    expect(html).toContain(t('partner.onboarding.liveNote'));
    expect(html).not.toContain('data-testid="partner-onboarding-request"');
    expect(html).toContain('data-informational="true"');
  });
  it('a facts read failure → the error state, not a checklist', async () => {
    factsFail.on = true;
    await signInAs({});
    const html = decode(await render());
    expect(html).toContain(t('partner.onboarding.unavailable'));
    expect(html).toContain('role="alert"');
    expect(stepStates(html)).toEqual([]);
  });
  it('viewing writes nothing', async () => {
    await seedOnboardingComplete(db, redis, 'pa');
    await signInAs({});
    const before = [(await db.select().from(auditEvents)).length, (await db.select().from(outbox)).length, (await db.select().from(partnerGoLive)).length];
    await render();
    expect([(await db.select().from(auditEvents)).length, (await db.select().from(outbox)).length, (await db.select().from(partnerGoLive)).length]).toEqual(before);
  });
});
