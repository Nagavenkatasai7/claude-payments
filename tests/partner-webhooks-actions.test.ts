import { describe, it, expect, vi, beforeEach } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// UI redesign M3-15a: the /partner settlement-webhook actions (save endpoint, rotate a rail secret,
// send a test event). Admin only (+ the MFA enrolment gate), apex host only; the tenant is the
// SESSION's partner: no form field names it, so the per-action checklist's item 3 (a foreign
// target id) is item 4 here (a foreign partnerId / partner field is ignored). Rotated secrets are
// returned in the action result ONCE and never reach an audit row, the outbox or a log line. The
// test event never touches the network: safeFetch is stubbed.

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
const fetchStub = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => new Response(null, { status: 200 })));
vi.mock('@/lib/safe-fetch', async (orig) => ({ ...(await orig<typeof import('@/lib/safe-fetch')>()), safeFetch: fetchStub }));
const logWarnSpy = vi.hoisted(() => vi.fn());
const logErrorSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/log', async (orig) => ({ ...(await orig<typeof import('@/lib/log')>()), logWarn: logWarnSpy, logError: logErrorSpy }));

import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { MFA_PENDING_PREFIX } from '@/lib/partner-mfa-gate';
import { auditEvents, outbox, partnerWebhookDeliveries } from '@/db/schema';
import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { railSecrets, type PartnerIntegrations } from '@/lib/partner-integrations';
import { t } from '@/lib/i18n';
import { rotateSecretAction, saveEndpointAction, sendTestAction } from '@/app/partner/(app)/integrations/webhooks/actions';

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
const store = () => createPartnerIntegrationsStore(db);
const audits = () => db.select().from(auditEvents).orderBy(asc(auditEvents.id));
const pingRows = (pid: string) => db.select().from(partnerWebhookDeliveries).where(eq(partnerWebhookDeliveries.partnerId, pid));
const snapshot = async () =>
  JSON.stringify({
    pa: await store().getIntegrations('pa'),
    pb: await store().getIntegrations('pb'),
    pings: (await db.select().from(partnerWebhookDeliveries)).length,
    n: (await audits()).length,
  });
const PHONE_SHAPE = /\+?\d{10,}/;
const SIGN = 'a'.repeat(64);
const HOOK = 'b'.repeat(64);
const rail = (): PartnerIntegrations => ({
  kyc: {},
  payment: { providerType: 'http', credentials: { settlementUrl: 'https://rail.example.com/instruct', signingSecret: SIGN }, webhookSecret: HOOK },
  whatsapp: {},
});

type Runner = { name: string; run: (extra?: Record<string, string>) => Promise<unknown> };
const RUNNERS: Runner[] = [
  { name: 'saveEndpointAction', run: (extra) => saveEndpointAction(null, form({ url: 'https://new-rail.example.com/x', ...extra })) },
  { name: 'rotateSecretAction', run: (extra) => rotateSecretAction(null, form({ kind: 'signing', ...extra })) },
  { name: 'sendTestAction', run: (extra) => sendTestAction(null, form({ ...extra })) },
];

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  host = 'smartremit.ai';
  fetchStub.mockClear();
  fetchStub.mockImplementation(async () => new Response(null, { status: 200 }));
  logWarnSpy.mockClear();
  logErrorSpy.mockClear();
  db = await freshDb();
  await seedPartner(db, 'pa', 'Partner A');
  await seedPartner(db, 'pb', 'Partner B');
  await store().saveIntegrations('pa', rail());
  await store().saveIntegrations('pb', rail());
});

describe.each(RUNNERS)('$name: the per-action checklist', ({ run }) => {
  it('1. anonymous → /login; a platform account → /admin-dashboard', async () => {
    const before = await snapshot();
    await expect(run()).rejects.toThrow('REDIRECT:/login');
    await signInAs({ username: 'plat', partnerId: undefined });
    await expect(run()).rejects.toThrow('REDIRECT:/admin-dashboard');
    expect(await snapshot()).toBe(before);
    expect(fetchStub).not.toHaveBeenCalled();
  });
  it('2. a disallowed role (agent, support, finance) → /partner with no change', async () => {
    const before = await snapshot();
    for (const role of ['agent', 'support', 'finance'] as const) {
      await signInAs({ username: `pa-${role}`, role });
      await expect(run()).rejects.toThrow('REDIRECT:/partner');
    }
    expect(await snapshot()).toBe(before);
    expect(fetchStub).not.toHaveBeenCalled();
  });
  it('MFA: an admin with enrolment pending → /partner/security?enroll=1 with no change', async () => {
    await signInAs({});
    await redis.set(`${MFA_PENDING_PREFIX}pa-admin`, '1');
    const before = await snapshot();
    await expect(run()).rejects.toThrow('REDIRECT:/partner/security?enroll=1');
    expect(await snapshot()).toBe(before);
  });
  it('site host: a partner subdomain is refused (404) before the gate, with no change', async () => {
    await signInAs({});
    host = 'acme.smartremit.ai';
    const before = await snapshot();
    await expect(run()).rejects.toThrow('NOT_FOUND');
    expect(await snapshot()).toBe(before);
    expect(fetchStub).not.toHaveBeenCalled();
  });
  it('3/4. a form naming B (partnerId / partner = pb) acts on A only; B is unchanged', async () => {
    await signInAs({});
    const bBefore = JSON.stringify(await store().getIntegrations('pb'));
    const r = (await run({ partnerId: 'pb', partner: 'pb', tenant: 'pb' })) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(JSON.stringify(await store().getIntegrations('pb'))).toBe(bBefore);
    expect(await pingRows('pb')).toHaveLength(0);
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0].partnerId).toBe('pa');
    expect(JSON.stringify(rows[0])).not.toContain('"pb"');
  });
  it('6. success → one audit row for pa, actor = the session user, actorScope from the session, no PII or secret', async () => {
    await signInAs({});
    const r = (await run()) as { ok: boolean; secret?: string };
    expect(r.ok).toBe(true);
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: 'pa', actor: 'pa-admin', actorType: 'staff' });
    expect((rows[0].meta as Record<string, unknown>).actorScope).toBe('partner');
    expect(JSON.stringify(rows[0].meta)).not.toMatch(PHONE_SHAPE);
    expect(JSON.stringify(rows[0])).not.toContain(SIGN);
    if (r.secret) expect(JSON.stringify(rows[0])).not.toContain(r.secret);
  });
});

describe('5. invalid input is refused before any write', () => {
  it('saveEndpointAction: every hostile URL → the one generic message, nothing written', async () => {
    await signInAs({});
    const before = await snapshot();
    for (const url of ['', 'http://rail.example.com/x', 'https://10.0.0.1/', 'https://[::1]/', 'https://a@b.example.com/', 'https://x.internal/', 'https://rail.example.com:8443/', 'https://rail.example.com/' + 'a'.repeat(3000), 'https://smartremit.ai/api/worker', 'https://acme.smartremit.ai/x', 'https://claude-payments.vercel.app/x']) {
      expect(await saveEndpointAction(null, form({ url }))).toEqual({ ok: false, error: t('partner.webhooks.invalidUrl') });
    }
    expect(await saveEndpointAction(null, form())).toEqual({ ok: false, error: t('partner.webhooks.invalidUrl') });
    expect(await snapshot()).toBe(before);
  });
  it('rotateSecretAction: a kind outside {signing, webhook} → refused, nothing written', async () => {
    await signInAs({});
    const before = await snapshot();
    for (const kind of ['', 'Signing', 'kyc', 'webhook ', 'all']) {
      expect(await rotateSecretAction(null, form({ kind }))).toEqual({ ok: false, error: t('partner.webhooks.invalid') });
    }
    expect(await snapshot()).toBe(before);
  });
});

describe('a SmartRemit-managed rail (simulator / mock)', () => {
  it('every action refuses with the managed copy and changes nothing', async () => {
    await store().saveIntegrations('pa', { ...rail(), payment: { ...rail().payment, providerType: 'simulator' } });
    await signInAs({});
    const before = await snapshot();
    const managed = { ok: false, error: t('partner.webhooks.managed') };
    expect(await saveEndpointAction(null, form({ url: 'https://new-rail.example.com/x' }))).toEqual(managed);
    expect(await rotateSecretAction(null, form({ kind: 'signing' }))).toEqual(managed);
    expect(await sendTestAction(null, form())).toEqual(managed);
    expect(await snapshot()).toBe(before);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe('saveEndpointAction', () => {
  it('saves the URL for the session tenant; the secrets and the rail type stay as they were', async () => {
    await signInAs({});
    expect(await saveEndpointAction(null, form({ url: 'https://new-rail.example.com/x' }))).toEqual({ ok: true });
    const after = await store().getIntegrations('pa');
    expect(after.payment.credentials?.settlementUrl).toBe('https://new-rail.example.com/x');
    expect(after.payment.providerType).toBe('http');
    expect(railSecrets(after.payment, 'signing', new Date())).toEqual([SIGN]);
    expect(railSecrets(after.payment, 'webhook', new Date())).toEqual([HOOK]);
    const [a] = await audits();
    expect(a.action).toBe('partner.settlement_endpoint.update');
    expect(a.meta).toEqual({ host: 'new-rail.example.com', actorScope: 'partner' });
  });
});

describe('rotateSecretAction', () => {
  it.each(['signing', 'webhook'] as const)('%s: returns the new secret ONCE; both verify during the grace; never in audit, outbox or logs', async (kind) => {
    await signInAs({});
    const r = await rotateSecretAction(null, form({ kind }));
    if (!r.ok) throw new Error('expected ok: ' + r.error);
    expect(r.kind).toBe(kind);
    expect(r.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(r.graceUntil).not.toBeNull();
    const after = await store().getIntegrations('pa');
    expect(railSecrets(after.payment, kind, new Date())).toEqual([r.secret, kind === 'signing' ? SIGN : HOOK]);
    const [a] = await audits();
    expect(a.action).toBe('partner.settlement_secret.rotate');
    expect(a.meta).toEqual({ kind, graceUntil: r.graceUntil, actorScope: 'partner' });
    const leak = JSON.stringify([await audits(), await db.select().from(outbox), logWarnSpy.mock.calls, logErrorSpy.mock.calls]);
    expect(leak).not.toContain(r.secret);
  });
});

describe('rotateSecretAction: a second rotation within the grace window', () => {
  it('is refused with the grace expiry; the ConfirmDialog override (endGrace=1) rotates and is audited', async () => {
    await signInAs({});
    const first = await rotateSecretAction(null, form({ kind: 'signing' }));
    if (!first.ok) throw new Error(first.error);
    const until = first.graceUntil!;
    const refusedR = await rotateSecretAction(null, form({ kind: 'signing' }));
    expect(refusedR).toEqual({ ok: false, error: t('partner.webhooks.rotationInGrace', { when: `${until.slice(0, 10)} ${until.slice(11, 16)} UTC` }) });
    expect(await audits()).toHaveLength(1);
    for (const v of ['0', 'yes', 'true ', '']) expect((await rotateSecretAction(null, form({ kind: 'signing', endGrace: v }))).ok).toBe(false);
    const r = await rotateSecretAction(null, form({ kind: 'signing', endGrace: '1' }));
    if (!r.ok) throw new Error(r.error);
    const a = await audits();
    expect(a).toHaveLength(2);
    expect(a[1].meta).toMatchObject({ kind: 'signing', endedGrace: true, actorScope: 'partner' });
    expect(railSecrets((await store().getIntegrations('pa')).payment, 'signing', new Date())).toEqual([r.secret, first.secret]);
  });
});

describe('sendTestAction', () => {
  it('sends ONE signed ping through safeFetch and reports the outcome; one delivery row + one audit row', async () => {
    await signInAs({});
    const r = await sendTestAction(null, form());
    expect(r).toMatchObject({ ok: true, outcome: 'ok', httpStatus: 200 });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0][0]).toBe('https://rail.example.com/instruct');
    expect(await pingRows('pa')).toHaveLength(1);
    const [a] = await audits();
    expect(a.action).toBe('webhook.test');
  });
  it('the 6th test in 10 minutes → rate-limited copy, no request, no row', async () => {
    await signInAs({});
    // Pin the clock 30 s into a fixed 10-minute window so the 6 calls cannot straddle a boundary
    // (freshDb ran in beforeEach, before the fake clock: CLAUDE.md PGlite + fake timers).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Math.floor(Date.now() / 600_000) * 600_000 + 30_000);
    try {
      for (let i = 0; i < 5; i++) expect((await sendTestAction(null, form())).ok).toBe(true);
      expect(await sendTestAction(null, form())).toEqual({ ok: false, error: t('partner.webhooks.rateLimited') });
    } finally {
      vi.useRealTimers();
    }
    expect(fetchStub).toHaveBeenCalledTimes(5);
    expect(await pingRows('pa')).toHaveLength(5);
  });
  it('an unexpected error → the generic failure copy, logged without the URL', async () => {
    await signInAs({});
    const spy = vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('db down https://rail.example.com/instruct'));
    expect(await sendTestAction(null, form())).toEqual({ ok: false, error: t('partner.webhooks.failed') });
    spy.mockRestore();
    expect(JSON.stringify(logWarnSpy.mock.calls)).not.toContain('rail.example.com');
  });
});
