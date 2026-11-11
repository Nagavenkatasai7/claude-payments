import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { certifyPartnerForTest } from './helpers-live';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// Fix pack 3 T11 (R26, R13; contract 18): /partner/controls. Admin only (agent/support/finance →
// /partner); the SESSION tenant's switches only (another tenant's rows and usernames never render);
// platform rows are read-only 'Set by SmartRemit' lines with no form; no reason, contract or counsel
// reference text renders; each section fails on its own; viewing writes nothing.

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
  usePathname: () => '/partner/controls',
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
vi.mock('@/lib/sanctions/list-health', async (orig) => ({
  ...(await orig<typeof import('@/lib/sanctions/list-health')>()),
  sanctionsListFitnessNow: async () => 'live' as const,
}));
const fail = vi.hoisted(() => ({ flags: false, facts: false }));
vi.mock('@/db/repos/feature-flag-repo', async (orig) => {
  const actual = await orig<typeof import('@/db/repos/feature-flag-repo')>();
  return {
    ...actual,
    createFeatureFlagRepo: (d: Parameters<typeof actual.createFeatureFlagRepo>[0]) => {
      const real = actual.createFeatureFlagRepo(d);
      return { ...real, listAll: async () => (fail.flags ? Promise.reject(new Error('db down')) : real.listAll()) };
    },
  };
});
vi.mock('@/db/repos/live-certification-facts', async (orig) => {
  const actual = await orig<typeof import('@/db/repos/live-certification-facts')>();
  return {
    ...actual,
    loadLiveReadinessFacts: async (...a: Parameters<typeof actual.loadLiveReadinessFacts>) => {
      if (fail.facts) throw new Error('facts down');
      return actual.loadLiveReadinessFacts(...a);
    },
  };
});

import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { createFeatureFlagRepo } from '@/db/repos/feature-flag-repo';
import { writeOptIn } from '@/lib/live-controls-write';
import { invalidateFlagCache } from '@/lib/flags';
import { t } from '@/lib/i18n';
import ControlsPage from '@/app/partner/(app)/controls/page';

const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
async function signInAs(o: Partial<Staff>): Promise<void> {
  const s: Staff = { username: 'pa-admin', name: 'A', role: 'admin', permissions: perms, passwordHash: 'x', createdAt: new Date().toISOString(), partnerId: 'pa', ...o };
  await getAuthStore().saveStaff(s);
  cookieJar.set(SESSION_COOKIE, await getAuthStore().createSession(s.username));
}
const render = async () => renderToStaticMarkup(await ControlsPage());
const decode = (html: string) => html.replaceAll('&amp;', '&').replaceAll('&#x27;', "'").replaceAll('&quot;', '"');
const count = (html: string, needle: string) => html.split(needle).length - 1;
/** One switch card's markup: from its data-key to the next switch card (or the end). */
const card = (html: string, key: string): string => {
  const start = html.indexOf(`data-testid="partner-controls-switch" data-key="${key}"`);
  if (start < 0) throw new Error(`no card ${key}`);
  const next = html.indexOf('data-testid="partner-controls-switch" data-key=', start + 1);
  return html.slice(start, next < 0 ? undefined : next);
};
const flag = (o: { key: string; scopeType: 'global' | 'partner' | 'corridor'; scopeId: string; updatedBy: string; reason: string }) =>
  createFeatureFlagRepo(db).upsert({ ...o, enabled: true });
async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(q)) as unknown as { rows: T[] }).rows;
}

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  fail.flags = false;
  fail.facts = false;
  db = await freshDb();
  invalidateFlagCache(db);
  await seedPartner(db, 'pa', 'Partner A');
  await seedPartner(db, 'pb', 'Partner B');
});

describe('/partner/controls: the gate', () => {
  it('anonymous → /login; platform → /admin-dashboard; agent, support, finance → /partner', async () => {
    await expect(ControlsPage()).rejects.toThrow('REDIRECT:/login');
    await signInAs({ username: 'plat', partnerId: undefined });
    await expect(ControlsPage()).rejects.toThrow('REDIRECT:/admin-dashboard');
    for (const role of ['agent', 'support', 'finance'] as const) {
      await signInAs({ username: `pa-${role}`, role });
      await expect(ControlsPage()).rejects.toThrow('REDIRECT:/partner');
    }
  });
});

describe('/partner/controls: the page', () => {
  it("one h1, four switch forms, the capability table, 12 readiness lines ('Not built yet' for not built)", async () => {
    await signInAs({});
    const html = decode(await render());
    expect(count(html, '<h1')).toBe(1);
    expect(count(html, 'data-testid="partner-controls-switch-form"')).toBe(4);
    expect(count(html, 'data-testid="partner-controls-switch"')).toBe(4);
    for (const key of ['sends.paused', 'settlement.paused', 'agent.paused', 'agent.tools.paused']) expect(html).toContain(`data-key="${key}"`);
    expect(html).toContain('data-testid="partner-controls-capabilities"');
    expect(count(html, 'data-capability=')).toBe(5);
    expect(html).toContain(t('partner.controls.optin.uncertifiedNote'));
    expect(count(html, 'data-testid="partner-controls-capability-form"')).toBe(0); // uncertified: nothing to approve
    expect(count(html, 'data-line=')).toBe(12);
    expect(count(html, `data-state="not_built"`)).toBe(5);
    expect(count(html, t('partner.live.state.notBuilt'))).toBe(5);
    expect(html).toContain(t('partner.live.readiness.go_live'));
    expect(html).toContain(t('partner.controls.wholeWorkspace')); // the corridor select on the two money switches
  });

  it("a tenant pause shows 'Paused by <username>' and a Resume form; a platform row reads 'Set by SmartRemit' with no form", async () => {
    await flag({ key: 'sends.paused', scopeType: 'partner', scopeId: 'tenant:pa', updatedBy: 'pa-ops', reason: 'PA_SECRET_REASON pausing' });
    await flag({ key: 'settlement.paused', scopeType: 'partner', scopeId: 'tenant:pa:IN', updatedBy: 'pa-ops', reason: 'PA_SECRET_REASON corridor' });
    await flag({ key: 'agent.paused', scopeType: 'global', scopeId: '', updatedBy: 'plat-owner', reason: 'PLATFORM_SECRET_REASON' });
    await signInAs({});
    const html = decode(await render());
    expect(html).toContain(t('partner.controls.pausedBy', { who: 'pa-ops', date: new Date().toISOString().slice(0, 10) }));
    expect(html).toContain(t('partner.controls.corridorLine', { corridor: 'IN' }));
    expect(html).toContain(t('partner.controls.setBySmartRemit', { scope: t('partner.controls.scope.global') }));
    // sends: Resume (whole workspace); settlement: Pause (workspace) + Resume (IN); agent: Pause; tools: Pause.
    expect(count(html, 'data-testid="partner-controls-switch-form"')).toBe(5);
    expect(count(html, 'data-enabled="off"')).toBe(2);
    for (const s of ['plat-owner', 'PLATFORM_SECRET_REASON', 'PA_SECRET_REASON']) expect(html).not.toContain(s);
  });

  it("review H3: a switch that only a SmartRemit row holds reads 'Paused by SmartRemit', never 'Running'; the tenant can still pause it", async () => {
    await flag({ key: 'agent.paused', scopeType: 'global', scopeId: '', updatedBy: 'plat-owner', reason: 'PLATFORM_SECRET_REASON' });
    await flag({ key: 'settlement.paused', scopeType: 'partner', scopeId: 'pa', updatedBy: 'plat-owner', reason: 'PLATFORM_SECRET_REASON' });
    await flag({ key: 'sends.paused', scopeType: 'corridor', scopeId: 'IN', updatedBy: 'plat-owner', reason: 'PLATFORM_SECRET_REASON' });
    await signInAs({});
    const html = decode(await render());
    for (const key of ['agent.paused', 'settlement.paused', 'sends.paused']) {
      const c = card(html, key);
      expect(c, key).toContain(t('partner.controls.pausedBySmartRemit'));
      expect(c, key).not.toContain(t('partner.controls.off'));
      expect(c, key).toContain('data-enabled="on"'); // the tenant's own Pause form still renders
    }
    const tools = card(html, 'agent.tools.paused');
    expect(tools).toContain(t('partner.controls.off'));
    expect(tools).not.toContain(t('partner.controls.pausedBySmartRemit'));
  });

  it("review H3: the tenant's own pause under a SmartRemit pause reads 'Paused' with its Resume form", async () => {
    await flag({ key: 'agent.paused', scopeType: 'global', scopeId: '', updatedBy: 'plat-owner', reason: 'PLATFORM_SECRET_REASON' });
    await flag({ key: 'agent.paused', scopeType: 'partner', scopeId: 'tenant:pa', updatedBy: 'pa-ops', reason: 'pausing the agent here' });
    await signInAs({});
    const c = card(decode(await render()), 'agent.paused');
    expect(c).toContain(`>${t('partner.controls.on')}<`);
    expect(c).not.toContain(t('partner.controls.pausedBySmartRemit'));
    expect(c).toContain(t('partner.controls.setBySmartRemit', { scope: t('partner.controls.scope.global') }));
    expect(c).toContain('data-enabled="off"');
  });

  it("pb's rows and usernames never render; no ref or reason text renders", async () => {
    await flag({ key: 'sends.paused', scopeType: 'partner', scopeId: 'tenant:pb', updatedBy: 'pb-admin', reason: 'PB_SECRET_REASON pausing' });
    await flag({ key: 'settlement.paused', scopeType: 'partner', scopeId: 'pb', updatedBy: 'plat-owner', reason: 'PLATFORM_SECRET_REASON' });
    await certifyPartnerForTest(db, 'pa', { optIns: ['usdc'] });
    await db.transaction((tx) => writeOptIn(tx, 'pa', { username: 'plat-owner', scope: 'platform' }, 'b2b', { kind: 'counsel', counselRef: 'SECRET_COUNSEL_REF' }));
    await signInAs({});
    const html = decode(await render());
    for (const s of ['pb-admin', 'PB_SECRET_REASON', 'plat-owner', 'PLATFORM_SECRET_REASON', 'SECRET_COUNSEL_REF', 'test-counsel', 'test-contract', 'test-admin']) expect(html).not.toContain(s);
    expect(html).not.toContain(t('partner.controls.on'));
    expect(count(html, 'data-testid="partner-controls-switch-form"')).toBe(4);
    // Certified: b2b is approvable (counsel on record), usdc withdrawable (approved by the test fixture's partner admin).
    expect(html).not.toContain(t('partner.controls.optin.uncertifiedNote'));
    expect(count(html, 'data-testid="partner-controls-capability-form"')).toBe(2);
    expect(html).toContain('test-partner-admin');
  });

  it('a flag read failure -> partner.controls.unavailable and no switch forms; a readiness failure -> partner.live.readiness.unavailable', async () => {
    await signInAs({});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      fail.flags = true;
      let html = decode(await render());
      expect(html).toContain(t('partner.controls.unavailable'));
      expect(html).not.toContain('data-testid="partner-controls-switch-form"');
      expect(count(html, 'data-line=')).toBe(12);
      fail.flags = false;
      fail.facts = true;
      html = decode(await render());
      expect(html).toContain(t('partner.live.readiness.unavailable'));
      expect(count(html, 'data-line=')).toBe(0);
      expect(count(html, 'data-testid="partner-controls-switch-form"')).toBe(4);
    } finally {
      warn.mockRestore();
    }
  });

  it('viewing writes nothing', async () => {
    await flag({ key: 'sends.paused', scopeType: 'partner', scopeId: 'tenant:pa', updatedBy: 'pa-admin', reason: 'a reason here' });
    await certifyPartnerForTest(db, 'pa');
    await signInAs({});
    const snap = async () =>
      JSON.stringify({
        flags: await rows(sql`SELECT * FROM feature_flags ORDER BY key, scope_id`),
        lc: await rows(sql`SELECT id, live_controls, updated_at FROM partners ORDER BY id`),
        audit: await rows(sql`SELECT id FROM audit_events ORDER BY id`),
        outbox: await rows(sql`SELECT id FROM outbox ORDER BY id`),
      });
    const before = await snap();
    await render();
    expect(await snap()).toBe(before);
  });
});
