import { describe, it, expect, vi, beforeEach } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// UI redesign M3-14: the /partner API-key actions. Admin only (+ the MFA enrolment gate), apex
// host only; the tenant is the SESSION's partner (no form field names it). Keys are minted by the
// EXISTING api-key repo (same CSPRNG + peppered hash, so the partner API authenticates them like
// any other key); the plaintext is returned in the action result ONCE and never reaches an audit
// row, the outbox or a log. Sandbox (test) keys always; live keys only after go-live. At most 5
// unrevoked keys per mode; issuance is rate-limited per tenant and fails closed.

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
const logWarnSpy = vi.hoisted(() => vi.fn());
const logErrorSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/log', async (orig) => ({ ...(await orig<typeof import('@/lib/log')>()), logWarn: logWarnSpy, logError: logErrorSpy }));

import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { staffStepUpKey } from '@/lib/staff-step-up';
import { MFA_PENDING_PREFIX } from '@/lib/partner-mfa-gate';
import { apiKeys, auditEvents, outbox, partnerGoLive } from '@/db/schema';
import { createApiKeyRepo } from '@/db/repos/api-key-repo';
import { t } from '@/lib/i18n';
import { createKeyAction, revokeKeyAction, rotateKeyAction } from '@/app/partner/(app)/integrations/api-keys/actions';

const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
async function signInAs(o: Partial<Staff>): Promise<void> {
  const s: Staff = { username: 'pa-admin', name: 'A', role: 'admin', permissions: perms, passwordHash: 'x', createdAt: new Date().toISOString(), partnerId: 'pa', ...o };
  await getAuthStore().saveStaff(s);
  const token = await getAuthStore().createSession(s.username);
  cookieJar.set(SESSION_COOKIE, token);
  // A fresh 15-minute step-up on this session (the step-up itself: partner-step-up-actions.test.ts).
  await redis.set(staffStepUpKey(token), `${s.username}:${Date.now()}`, { ex: 900 });
}
const form = (o: Record<string, string> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const repo = () => createApiKeyRepo(db);
const audits = () => db.select().from(auditEvents).orderBy(asc(auditEvents.id));
const keysOf = (pid: string) => db.select().from(apiKeys).where(eq(apiKeys.partnerId, pid)).orderBy(asc(apiKeys.createdAt));
const snapshot = async () => JSON.stringify({ keys: await db.select().from(apiKeys).orderBy(asc(apiKeys.id)), n: (await audits()).length });
const approve = (pid: string) => db.insert(partnerGoLive).values({ partnerId: pid, approvedAt: new Date(), approvedBy: 'system:0028-backfill' });
const PHONE_SHAPE = /\+?\d{10,}/;
const create = (mode: string, extra: Record<string, string> = {}) => createKeyAction(null, form({ mode, ...extra }));
const rotate = (id: string, extra: Record<string, string> = {}) => rotateKeyAction(null, form({ id, ...extra }));
const okPlain = (r: Awaited<ReturnType<typeof createKeyAction>>) => {
  if (!r || !r.ok) throw new Error('expected ok, got ' + JSON.stringify(r));
  return r;
};

let pbKeyId = '';
beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  host = 'smartremit.ai';
  logWarnSpy.mockClear();
  logErrorSpy.mockClear();
  db = await freshDb();
  await seedPartner(db, 'pa', 'Partner A');
  await seedPartner(db, 'pb', 'Partner B');
  pbKeyId = (await repo().issue('pb', 'test')).keyId;
});

// The three actions, each with a VALID input for partner A (the own-id target is made per test).
type Runner = { name: string; setup: () => Promise<string>; run: (id: string, extra?: Record<string, string>) => Promise<unknown> };
const RUNNERS: Runner[] = [
  { name: 'createKeyAction', setup: async () => '', run: (_id, extra) => create('test', extra) },
  { name: 'rotateKeyAction', setup: async () => (await repo().issue('pa', 'test')).keyId, run: (id, extra) => rotate(id, extra) },
  { name: 'revokeKeyAction', setup: async () => (await repo().issue('pa', 'test')).keyId, run: (id, extra) => revokeKeyAction(form({ id, ...extra })) },
];

describe.each(RUNNERS)('$name: the per-action checklist', ({ setup, run }) => {
  it('1. anonymous → /login; a platform account → /admin-dashboard', async () => {
    const id = await setup();
    const before = await snapshot();
    await expect(run(id)).rejects.toThrow('REDIRECT:/login');
    await signInAs({ username: 'plat', partnerId: undefined });
    await expect(run(id)).rejects.toThrow('REDIRECT:/admin-dashboard');
    expect(await snapshot()).toBe(before);
  });
  it('2. a disallowed role (agent, support, finance) → /partner with no change', async () => {
    const id = await setup();
    const before = await snapshot();
    for (const role of ['agent', 'support', 'finance'] as const) {
      await signInAs({ username: `pa-${role}`, role });
      await expect(run(id)).rejects.toThrow('REDIRECT:/partner');
    }
    expect(await snapshot()).toBe(before);
  });
  it('MFA: an admin with enrolment pending → /partner/security?enroll=1 with no change', async () => {
    const id = await setup();
    await signInAs({});
    await redis.set(`${MFA_PENDING_PREFIX}pa-admin`, '1');
    const before = await snapshot();
    await expect(run(id)).rejects.toThrow('REDIRECT:/partner/security?enroll=1');
    expect(await snapshot()).toBe(before);
  });
  it('site host: a partner subdomain is refused (404) before the gate, with no change', async () => {
    const id = await setup();
    await signInAs({});
    host = 'acme.smartremit.ai';
    const before = await snapshot();
    await expect(run(id)).rejects.toThrow('NOT_FOUND');
    expect(await snapshot()).toBe(before);
  });
  it('4. a form naming B (partnerId / partner = pb) acts on A only; B is unchanged', async () => {
    const id = await setup();
    await signInAs({});
    const bBefore = JSON.stringify(await keysOf('pb'));
    const r = (await run(id, { partnerId: 'pb', partner: 'pb' })) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(JSON.stringify(await keysOf('pb'))).toBe(bBefore);
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0].partnerId).toBe('pa');
    expect(JSON.stringify(rows[0])).not.toContain('"pb"');
  });
  it('6. success → one audit row for pa, actor = the session user, actorScope from the session, no PII', async () => {
    const id = await setup();
    await signInAs({});
    const r = (await run(id)) as { ok: boolean; plaintext?: string };
    expect(r.ok).toBe(true);
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: 'pa', actor: 'pa-admin', actorType: 'staff' });
    expect((rows[0].meta as Record<string, unknown>).actorScope).toBe('partner');
    expect(JSON.stringify(rows[0].meta)).not.toMatch(PHONE_SHAPE);
    if (r.plaintext) expect(JSON.stringify(rows[0])).not.toContain(r.plaintext);
  });
});

describe('3. cross-tenant: B’s key id is not found, B unchanged, no audit', () => {
  it('rotate and revoke of pb’s key → not found; pb’s key still authenticates', async () => {
    const pbPlain = await (async () => {
      await db.delete(apiKeys);
      const k = await repo().issue('pb', 'test');
      pbKeyId = k.keyId;
      return k.plaintext;
    })();
    await signInAs({});
    const before = await snapshot();
    expect(await rotate(pbKeyId)).toEqual({ ok: false, error: t('partner.keys.notFound') });
    expect(await revokeKeyAction(form({ id: pbKeyId }))).toEqual({ ok: false, error: t('partner.keys.notFound') });
    expect(await snapshot()).toBe(before);
    expect(await repo().authenticate(pbPlain)).toMatchObject({ partnerId: 'pb', mode: 'test' });
  });
  it('an unknown id reads exactly like a foreign one', async () => {
    await signInAs({});
    expect(await rotate('pk_test_doesnotexist')).toEqual({ ok: false, error: t('partner.keys.notFound') });
    expect(await revokeKeyAction(form({ id: 'pk_test_doesnotexist' }))).toEqual({ ok: false, error: t('partner.keys.notFound') });
  });
});

describe('5. invalid input is refused before any write', () => {
  it('create: mode outside {test, live} (missing, casing, junk) → refused, nothing written', async () => {
    await signInAs({});
    const before = await snapshot();
    for (const mode of ['', 'LIVE', 'Test', 'prod', 'live ', 'sandbox']) {
      expect(await create(mode)).toEqual({ ok: false, error: t('partner.keys.invalid') });
    }
    expect(await createKeyAction(null, form())).toEqual({ ok: false, error: t('partner.keys.invalid') });
    expect(await snapshot()).toBe(before);
  });
  it('rotate / revoke: a missing, oversized or malformed id → not found, nothing written', async () => {
    await signInAs({});
    const before = await snapshot();
    for (const id of ['', 'x'.repeat(200), 'pk_test_a b', "pk_test_'; drop", 'sk_test_abc']) {
      expect(await rotate(id)).toEqual({ ok: false, error: t('partner.keys.notFound') });
      expect(await revokeKeyAction(form({ id }))).toEqual({ ok: false, error: t('partner.keys.notFound') });
    }
    expect(await snapshot()).toBe(before);
  });
});

describe('createKeyAction', () => {
  it('a sandbox key: shown once in the result, authenticates through the EXISTING repo as pa/test', async () => {
    await signInAs({});
    const r = okPlain(await create('test'));
    expect(r.plaintext.startsWith('sr_test_')).toBe(true);
    expect(r.last4).toBe(r.plaintext.slice(-4));
    expect(r.mode).toBe('test');
    const auth = await repo().authenticate(r.plaintext);
    expect(auth).toMatchObject({ partnerId: 'pa', mode: 'test' });
    // Only the hash is stored.
    const [row] = await keysOf('pa');
    expect(JSON.stringify(row)).not.toContain(r.plaintext);
    expect(row.keyHash).toMatch(/^[0-9a-f]{64}$/);
    // The audit shape (legacy apiKeyIssueAuditEvent + actorScope), never the plaintext.
    const [a] = await audits();
    expect(a.action).toBe('api_key.issue');
    expect(a.subjectId).toBe(row.id);
    expect(a.meta).toEqual({ keyId: row.id, mode: 'test', last4: r.last4, actorScope: 'partner' });
  });
  it('the plaintext never reaches audit_events, the outbox or a log line', async () => {
    await signInAs({});
    const r = okPlain(await create('test'));
    const secret = r.plaintext.slice('sr_test_'.length);
    expect(JSON.stringify(await audits())).not.toContain(secret);
    expect(JSON.stringify(await db.select().from(outbox))).not.toContain(secret);
    for (const call of [...logWarnSpy.mock.calls, ...logErrorSpy.mock.calls]) expect(JSON.stringify(call)).not.toContain(secret);
  });
  it('live before go-live → refused with the go-live copy, and NO key row or audit row', async () => {
    await signInAs({});
    const before = await snapshot();
    expect(await create('live')).toEqual({ ok: false, error: t('partner.keys.liveAfterGoLive') });
    expect(await snapshot()).toBe(before);
    // Requested but not approved is still refused.
    await db.insert(partnerGoLive).values({ partnerId: 'pa', requestedAt: new Date(), requestedBy: 'pa-admin' });
    expect(await create('live')).toEqual({ ok: false, error: t('partner.keys.liveAfterGoLive') });
    expect(await snapshot()).toBe(before);
  });
  it('B’s go-live approval does not let A issue live keys', async () => {
    await approve('pb');
    await signInAs({});
    expect(await create('live')).toEqual({ ok: false, error: t('partner.keys.liveAfterGoLive') });
  });
  it('live after go-live → issued as pa/live', async () => {
    await approve('pa');
    await signInAs({});
    const r = okPlain(await create('live'));
    expect(r.plaintext.startsWith('sr_live_')).toBe(true);
    expect(await repo().authenticate(r.plaintext)).toMatchObject({ partnerId: 'pa', mode: 'live' });
  });
  it('a 6th unrevoked test key → refused (the cap is per mode); a revoked key frees a slot', async () => {
    await approve('pa');
    await signInAs({});
    for (let i = 0; i < 5; i++) okPlain(await create('test'));
    const before = await snapshot();
    expect(await create('test')).toEqual({ ok: false, error: t('partner.keys.cap', { max: 5 }) });
    expect(await snapshot()).toBe(before);
    // Another mode has its own cap; another tenant's keys never count.
    okPlain(await create('live'));
    for (let i = 0; i < 5; i++) await repo().issue('pb', 'test');
    const first = (await keysOf('pa')).find((k) => k.id.startsWith('pk_test_'))!;
    expect(await revokeKeyAction(form({ id: first.id }))).toEqual({ ok: true });
    okPlain(await create('test'));
  });
  it('issuance is rate-limited per tenant (create and rotate share it); revoke is never limited', async () => {
    await signInAs({});
    for (let i = 0; i < 10; i++) {
      const r = okPlain(await create('test'));
      const id = (await keysOf('pa')).find((k) => k.last4 === r.last4 && !k.revokedAt)!.id;
      expect(await revokeKeyAction(form({ id }))).toEqual({ ok: true });
    }
    const before = await snapshot();
    expect(await create('test')).toEqual({ ok: false, error: t('partner.keys.rateLimited') });
    const own = (await keysOf('pa'))[0].id;
    expect(await rotate(own)).toEqual({ ok: false, error: t('partner.keys.rateLimited') });
    expect(await snapshot()).toBe(before);
  });
  it('the limiter FAILS CLOSED: a Redis error refuses issuance and writes nothing', async () => {
    await signInAs({});
    const incr = redis.incr;
    redis.incr = async () => {
      throw new Error('redis down');
    };
    try {
      const before = await snapshot();
      expect(await create('test')).toEqual({ ok: false, error: t('partner.keys.rateLimited') });
      expect(await snapshot()).toBe(before);
    } finally {
      redis.incr = incr;
    }
  });
});

describe('rotateKeyAction', () => {
  it('issues a NEW key of the same mode; the OLD key stays active; audit meta.rotatedFrom', async () => {
    const old = await repo().issue('pa', 'test');
    await signInAs({});
    const r = okPlain(await rotate(old.keyId));
    expect(r.mode).toBe('test');
    expect(r.plaintext).not.toBe(old.plaintext);
    expect(await repo().authenticate(old.plaintext)).toMatchObject({ partnerId: 'pa', keyId: old.keyId });
    const fresh = await repo().authenticate(r.plaintext);
    expect(fresh).toMatchObject({ partnerId: 'pa', mode: 'test' });
    const [a] = await audits();
    expect(a.action).toBe('api_key.issue');
    expect(a.meta).toEqual({ keyId: fresh!.keyId, mode: 'test', last4: r.last4, actorScope: 'partner', rotatedFrom: old.keyId });
    expect(JSON.stringify(a)).not.toContain(r.plaintext.slice(8));
  });
  it('the mode comes from the target key, never the form', async () => {
    const old = await repo().issue('pa', 'test');
    await approve('pa');
    await signInAs({});
    const r = okPlain(await rotate(old.keyId, { mode: 'live' }));
    expect(r.mode).toBe('test');
    expect(r.plaintext.startsWith('sr_test_')).toBe(true);
  });
  it('a live key without go-live → refused, nothing written', async () => {
    const live = await repo().issue('pa', 'live'); // e.g. issued by SmartRemit staff
    await signInAs({});
    const before = await snapshot();
    expect(await rotate(live.keyId)).toEqual({ ok: false, error: t('partner.keys.liveAfterGoLive') });
    expect(await snapshot()).toBe(before);
  });
  it('a revoked key cannot be rotated (not found)', async () => {
    const old = await repo().issue('pa', 'test');
    await repo().revoke(old.keyId, 'pa');
    await signInAs({});
    const before = await snapshot();
    expect(await rotate(old.keyId)).toEqual({ ok: false, error: t('partner.keys.notFound') });
    expect(await snapshot()).toBe(before);
  });
  it('rotate at the cap (5 unrevoked of the mode) → refused, nothing written', async () => {
    for (let i = 0; i < 5; i++) await repo().issue('pa', 'test');
    const target = (await keysOf('pa'))[0].id;
    await signInAs({});
    const before = await snapshot();
    expect(await rotate(target)).toEqual({ ok: false, error: t('partner.keys.cap', { max: 5 }) });
    expect(await snapshot()).toBe(before);
  });
});

describe('revokeKeyAction', () => {
  it('revokes A’s key (it stops authenticating); audit api_key.revoke with keyId + last4', async () => {
    const k = await repo().issue('pa', 'test');
    await signInAs({});
    expect(await revokeKeyAction(form({ id: k.keyId }))).toEqual({ ok: true });
    expect(await repo().authenticate(k.plaintext)).toBeNull();
    const [a] = await audits();
    expect(a).toMatchObject({ action: 'api_key.revoke', subjectId: k.keyId, partnerId: 'pa' });
    expect(a.meta).toEqual({ keyId: k.keyId, last4: k.last4, actorScope: 'partner' });
  });
  it('already revoked → an idempotent ok, no second audit row', async () => {
    const k = await repo().issue('pa', 'test');
    await signInAs({});
    expect(await revokeKeyAction(form({ id: k.keyId }))).toEqual({ ok: true });
    const firstRevokedAt = (await keysOf('pa'))[0].revokedAt;
    expect(await revokeKeyAction(form({ id: k.keyId }))).toEqual({ ok: true });
    expect(await audits()).toHaveLength(1);
    expect((await keysOf('pa'))[0].revokedAt).toEqual(firstRevokedAt);
  });
  it('a legacy bare pk_<id> key (grandfathered live) can be revoked', async () => {
    const k = await createApiKeyRepo(db, { genKeyId: () => 'pk_legacyAbc123' }).issue('pa', 'live');
    // The repo always encodes the mode; emulate a pre-fix-44 id directly.
    await db.update(apiKeys).set({ id: 'pk_legacyAbc123' }).where(eq(apiKeys.id, k.keyId));
    await signInAs({});
    expect(await revokeKeyAction(form({ id: 'pk_legacyAbc123' }))).toEqual({ ok: true });
    expect(await repo().authenticate(k.plaintext)).toBeNull();
  });
});
