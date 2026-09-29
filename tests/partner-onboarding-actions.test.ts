import { describe, it, expect, vi, beforeEach } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// UI redesign M3-20, Task 20.3: the /partner/onboarding actions. Admin only (+ the MFA enrolment
// gate), apex host only; the tenant is the SESSION's partner (these actions take no target id, so
// checklist item 3 is recast: a complete foreign tenant never makes the session tenant's request
// pass). requestGoLiveAction RE-COMPUTES the checklist server-side: steps 1–6 must be done. One
// transaction: requestGoLive (idempotent) + audit partner.go_live.request + a deduped ops alert.
// A partner can never approve itself.

const redis = fakeRedis();
let db: Db;
const cookieJar = new Map<string, string>();
let host = 'smartremit.ai';
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers({ host }),
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
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => actual.createPartnerStore(db) };
});
vi.mock('@/lib/partner-integrations-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-integrations-store')>('@/lib/partner-integrations-store');
  return { ...actual, getPartnerIntegrationsStore: () => actual.createPartnerIntegrationsStore(db) };
});
const pokeSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/outbox', async (orig) => ({ ...(await orig<typeof import('@/lib/outbox')>()), pokeWorker: pokeSpy }));
const logWarnSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/log', async (orig) => ({ ...(await orig<typeof import('@/lib/log')>()), logWarn: logWarnSpy }));
import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { MFA_PENDING_PREFIX } from '@/lib/partner-mfa-gate';
import { auditEvents, outbox, partnerGoLive } from '@/db/schema';
import { t } from '@/lib/i18n';
import { attestTemplatesAction, requestGoLiveAction } from '@/app/partner/(app)/onboarding/actions';
import { seedOnboardingComplete } from './helpers-partner-onboarding';

const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
async function signInAs(o: Partial<Staff>): Promise<void> {
  const s: Staff = { username: 'pa-admin', name: 'A', role: 'admin', permissions: perms, passwordHash: 'x', createdAt: new Date().toISOString(), partnerId: 'pa', ...o };
  await getAuthStore().saveStaff(s);
  cookieJar.set(SESSION_COOKIE, await getAuthStore().createSession(s.username));
}
const form = (o: Record<string, string> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const ATTEST = { authentication: 'on', transfer_delivered: 'on' };
const audits = () => db.select().from(auditEvents).orderBy(asc(auditEvents.id));
const alerts = () => db.select().from(outbox).where(eq(outbox.kind, 'ops.alert'));
const goLiveRows = () => db.select().from(partnerGoLive).orderBy(asc(partnerGoLive.partnerId));
const snapshot = async () =>
  JSON.stringify({ gl: await goLiveRows(), audit: (await audits()).map((a) => [a.id, a.action, a.partnerId]), ob: (await db.select().from(outbox)).map((o) => o.id) });
const PHONE_SHAPE = /\+?\d{10,}/;

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  host = 'smartremit.ai';
  pokeSpy.mockClear();
  logWarnSpy.mockClear();
  db = await freshDb();
  await seedPartner(db, 'pa', 'Partner A');
  await seedPartner(db, 'pb', 'Partner B');
});

// Both actions, each with a VALID input for partner A (setup makes A eligible where needed).
type Runner = { name: string; setup: () => Promise<void>; run: (extra?: Record<string, string>) => Promise<unknown> };
const RUNNERS: Runner[] = [
  { name: 'attestTemplatesAction', setup: async () => {}, run: (extra = {}) => attestTemplatesAction(form({ ...ATTEST, ...extra })) },
  { name: 'requestGoLiveAction', setup: () => seedOnboardingComplete(db, redis, 'pa'), run: (extra = {}) => requestGoLiveAction(form(extra)) },
];

describe.each(RUNNERS)('$name: the per-action checklist', ({ setup, run }) => {
  it('1. anonymous → /login; a platform account → /admin-dashboard', async () => {
    await setup();
    const before = await snapshot();
    await expect(run()).rejects.toThrow('REDIRECT:/login');
    await signInAs({ username: 'plat', partnerId: undefined });
    await expect(run()).rejects.toThrow('REDIRECT:/admin-dashboard');
    expect(await snapshot()).toBe(before);
  });
  it('2. a disallowed role (agent, support, finance) → /partner with no change', async () => {
    await setup();
    const before = await snapshot();
    for (const role of ['agent', 'support', 'finance'] as const) {
      await signInAs({ username: `pa-${role}`, role });
      await expect(run()).rejects.toThrow('REDIRECT:/partner');
    }
    expect(await snapshot()).toBe(before);
  });
  it('MFA: an admin with enrolment pending → /partner/security?enroll=1 with no change', async () => {
    await setup();
    await signInAs({});
    await redis.set(`${MFA_PENDING_PREFIX}pa-admin`, '1');
    const before = await snapshot();
    await expect(run()).rejects.toThrow('REDIRECT:/partner/security?enroll=1');
    expect(await snapshot()).toBe(before);
  });
  it('site host: a partner subdomain is refused (404) before the gate, with no change', async () => {
    await setup();
    await signInAs({});
    host = 'acme.smartremit.ai';
    const before = await snapshot();
    await expect(run()).rejects.toThrow('NOT_FOUND');
    expect(await snapshot()).toBe(before);
  });
  it('4. a form naming B (partnerId / partner = pb) acts on A only; nothing references pb', async () => {
    await setup();
    await signInAs({});
    const r = (await run({ partnerId: 'pb', partner: 'pb' })) as { ok: boolean };
    expect(r.ok).toBe(true);
    const rows = await audits();
    const mine = rows.filter((a) => a.actor === 'pa-admin');
    expect(mine).toHaveLength(1);
    expect(mine[0].partnerId).toBe('pa');
    expect(JSON.stringify(mine)).not.toContain('"pb"');
    expect((await goLiveRows()).map((g) => g.partnerId)).not.toContain('pb');
    for (const a of await alerts()) expect(JSON.stringify(a.payload)).not.toContain('pb');
  });
  it('6. success → exactly one audit row: partnerId pa, actor = the session user, actorScope partner, no PII', async () => {
    await setup();
    await signInAs({});
    const before = (await audits()).length;
    expect(await run()).toEqual({ ok: true });
    const rows = (await audits()).slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: 'pa', actor: 'pa-admin', actorType: 'staff', subjectId: 'pa' });
    expect((rows[0].meta as { actorScope?: string }).actorScope).toBe('partner');
    expect(JSON.stringify(rows[0].meta)).not.toMatch(PHONE_SHAPE);
  });
});

describe('attestTemplatesAction', () => {
  it('5. both templates must be ticked; otherwise refused before any write', async () => {
    await signInAs({});
    const bad: Record<string, string>[] = [{}, { authentication: 'on' }, { transfer_delivered: 'on' }, { authentication: 'yes', transfer_delivered: 'on' }];
    for (const f of bad) {
      const before = await snapshot();
      expect(await attestTemplatesAction(form(f))).toEqual({ ok: false, error: t('partner.onboarding.attest.invalid') });
      expect(await snapshot()).toBe(before);
    }
  });
  it('writes partner.templates.attest with the template names; a repeat is a no-op (one row)', async () => {
    await signInAs({});
    expect(await attestTemplatesAction(form(ATTEST))).toEqual({ ok: true });
    expect(await attestTemplatesAction(form(ATTEST))).toEqual({ ok: true });
    const rows = (await audits()).filter((a) => a.action === 'partner.templates.attest');
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toMatchObject({ templates: ['authentication', 'transfer_delivered'], actorScope: 'partner' });
  });
  it('B’s attestation does not make A’s a no-op (A still gets its own row)', async () => {
    await seedOnboardingComplete(db, redis, 'pb', '111222333444');
    await signInAs({});
    expect(await attestTemplatesAction(form(ATTEST))).toEqual({ ok: true });
    expect((await audits()).filter((a) => a.action === 'partner.templates.attest' && a.partnerId === 'pa')).toHaveLength(1);
  });
});

describe('requestGoLiveAction', () => {
  it('3 (recast). B complete, A empty → A’s request is refused; no row, no audit, no alert', async () => {
    await seedOnboardingComplete(db, redis, 'pb', '111222333444');
    await signInAs({});
    const before = await snapshot();
    expect(await requestGoLiveAction(form())).toEqual({ ok: false, error: t('partner.onboarding.incomplete') });
    expect(await snapshot()).toBe(before);
    expect(pokeSpy).not.toHaveBeenCalled();
  });
  it('step 5 missing (no ok ping) → refused, no go-live row, no alert', async () => {
    await seedOnboardingComplete(db, redis, 'pa');
    const { partnerWebhookDeliveries } = await import('@/db/schema');
    await db.delete(partnerWebhookDeliveries).where(eq(partnerWebhookDeliveries.partnerId, 'pa'));
    await signInAs({});
    expect(await requestGoLiveAction(form())).toEqual({ ok: false, error: t('partner.onboarding.incomplete') });
    expect(await goLiveRows()).toHaveLength(0);
    expect(await alerts()).toHaveLength(0);
    expect((await audits()).filter((a) => a.action === 'partner.go_live.request')).toHaveLength(0);
  });
  it.each(['whatsapp', 'templates', 'sandboxKey', 'sandboxTransfer', 'webhook', 'branding'] as const)(
    'the check is server-side: step "%s" missing alone refuses (no row, no audit, no alert)',
    async (step) => {
      await seedOnboardingComplete(db, redis, 'pa', undefined, { omit: [step] });
      await signInAs({});
      const before = await snapshot();
      expect(await requestGoLiveAction(form())).toEqual({ ok: false, error: t('partner.onboarding.incomplete') });
      expect(await snapshot()).toBe(before);
      expect(pokeSpy).not.toHaveBeenCalled();
    },
  );
  it('success: one go-live row (requested, NOT approved), one audit row, one deduped ops alert, a poke', async () => {
    await seedOnboardingComplete(db, redis, 'pa');
    await signInAs({});
    expect(await requestGoLiveAction(form())).toEqual({ ok: true });
    const [row] = await goLiveRows();
    expect(row).toMatchObject({ partnerId: 'pa', requestedBy: 'pa-admin', approvedAt: null, approvedBy: null });
    expect(row.requestedAt).not.toBeNull();
    const a = await alerts();
    expect(a).toHaveLength(1);
    expect(a[0].payload).toEqual({ message: 'Partner pa requested go-live' });
    expect(a[0].dedupeKey).toBe(`golive:pa:${new Date().toISOString().slice(0, 10)}`);
    expect(pokeSpy).toHaveBeenCalledTimes(1);
  });
  it('a double request → one row, one audit, one alert; the first request time and requester are kept', async () => {
    await seedOnboardingComplete(db, redis, 'pa');
    await signInAs({});
    expect(await requestGoLiveAction(form())).toEqual({ ok: true });
    const first = (await goLiveRows())[0];
    await signInAs({ username: 'pa-admin2' });
    expect(await requestGoLiveAction(form())).toEqual({ ok: true });
    const rows = await goLiveRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].requestedAt?.getTime()).toBe(first.requestedAt?.getTime());
    expect(rows[0].requestedBy).toBe('pa-admin');
    expect((await audits()).filter((x) => x.action === 'partner.go_live.request')).toHaveLength(1);
    expect(await alerts()).toHaveLength(1);
  });
  it('an already-live (backfilled) partner: ok, nothing stamped, no audit, no alert', async () => {
    await db.insert(partnerGoLive).values({ partnerId: 'pa', approvedAt: new Date(), approvedBy: 'system:0028-backfill' });
    await seedOnboardingComplete(db, redis, 'pa');
    await signInAs({});
    const before = await snapshot();
    expect(await requestGoLiveAction(form())).toEqual({ ok: true });
    expect(await snapshot()).toBe(before);
    expect((await goLiveRows())[0].requestedAt).toBeNull();
  });
  it('a forged approve field never approves (partners can never approve)', async () => {
    await seedOnboardingComplete(db, redis, 'pa');
    await signInAs({});
    expect(await requestGoLiveAction(form({ approve: '1', approvedAt: new Date().toISOString(), approvedBy: 'pa-admin' }))).toEqual({ ok: true });
    expect((await goLiveRows())[0].approvedAt).toBeNull();
  });
  it('a repo failure → the generic failed message, logged without PII, nothing written', async () => {
    await seedOnboardingComplete(db, redis, 'pa');
    await signInAs({});
    const before = await snapshot();
    const spy = vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('boom +14155550101'));
    expect(await requestGoLiveAction(form())).toEqual({ ok: false, error: t('partner.onboarding.failed') });
    spy.mockRestore();
    expect(await snapshot()).toBe(before);
    expect(JSON.stringify(logWarnSpy.mock.calls)).not.toMatch(PHONE_SHAPE);
  });
});
