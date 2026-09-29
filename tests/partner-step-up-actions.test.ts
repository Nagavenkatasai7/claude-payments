import { describe, it, expect, vi, beforeEach } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { Staff, Transfer } from '@/lib/types';

// M3-14 follow-up: the 15-minute step-up in front of the /partner credential and money-config
// actions (API-key issue + rotate, settlement endpoint save, rail secret rotate, dead-instruction
// replay). Per action: a STALE session → the typed step_up_required result with ZERO writes (no DB
// row, no audit row, no outbox change, no Redis write outside the session keys: not even a rate-
// limiter increment); a FRESH session → the action runs; a Redis error on the step-up marker →
// refused. A retry carrying the TOTP code (enrolled) or the password (not enrolled) runs the action
// in the same request, so a key / secret reveal still happens exactly once. Revoke and the test
// event stay ungated. Nothing records or logs the code or the password.

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
  headers: async () => new Headers({ host, 'x-forwarded-for': '203.0.113.7' }),
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
const logInfoSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/log', async (orig) => ({ ...(await orig<typeof import('@/lib/log')>()), logWarn: logWarnSpy, logError: logErrorSpy, logInfo: logInfoSpy }));
const pokeSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/outbox', async (orig) => ({ ...(await orig<typeof import('@/lib/outbox')>()), pokeWorker: pokeSpy }));

import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { apiKeys, auditEvents, outbox as outboxTable } from '@/db/schema';
import { createApiKeyRepo } from '@/db/repos/api-key-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createStore } from '@/lib/store';
import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import type { PartnerIntegrations } from '@/lib/partner-integrations';
import { createStaffMfaStore } from '@/lib/staff-mfa-store';
import { base32Decode, totpAt } from '@/lib/totp';
import { hashPassword } from '@/lib/password';
import { staffStepUpKey, STEP_UP_SESSION_HOURLY_CAP } from '@/lib/staff-step-up';
import { staffLoginKeys } from '@/lib/staff-login-guard';
import { STEP_UP_FIELD, isStepUpRequired } from '@/lib/staff-step-up-result';
import { t } from '@/lib/i18n';
import { createKeyAction, revokeKeyAction, rotateKeyAction } from '@/app/partner/(app)/integrations/api-keys/actions';
import { replayDeliveryAction, rotateSecretAction, saveEndpointAction, sendTestAction } from '@/app/partner/(app)/integrations/webhooks/actions';

const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
const PASSWORD = 'correct horse battery staple';
let token = '';
async function signInAs(o: Partial<Staff> = {}): Promise<void> {
  const s: Staff = { username: 'pa-admin', name: 'A', role: 'admin', permissions: perms, passwordHash: await hashPassword(PASSWORD), createdAt: new Date().toISOString(), partnerId: 'pa', ...o };
  await getAuthStore().saveStaff(s);
  token = await getAuthStore().createSession(s.username);
  cookieJar.set(SESSION_COOKIE, token);
}
const markFresh = (username = 'pa-admin', atMs = Date.now()) => redis.set(staffStepUpKey(token), `${username}:${atMs}`, { ex: 900 });
const mfa = () => createStaffMfaStore(redis);
async function enrol(username = 'pa-admin'): Promise<Buffer> {
  const begun = await mfa().beginEnrolment(username);
  if (!begun.ok) throw new Error('enrol refused');
  const secret = base32Decode(begun.secretBase32);
  expect(await mfa().confirmEnrolment(username, totpAt(secret, Date.now()))).toBe('ok');
  return secret;
}
/** The NEXT step's code: the enrolment spent the current one (the replay guard). */
const nextCode = (secret: Buffer) => totpAt(secret, Date.now() + 30_000);

const form = (o: Record<string, string> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const rail = (): PartnerIntegrations => ({
  kyc: {},
  payment: { providerType: 'http', credentials: { settlementUrl: 'https://rail.example.com/instruct', signingSecret: 'a'.repeat(64) }, webhookSecret: 'b'.repeat(64) },
  whatsapp: {},
});
function transfer(id: string, partnerId: string): Transfer {
  return {
    id, phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'paid', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: new Date(Date.now() - 3_600_000).toISOString(), paidAt: new Date(Date.now() - 3_000_000).toISOString(), partnerId,
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
  } as Transfer;
}
async function deadRow(key: string, transferId: string): Promise<number> {
  await createOutboxRepo(db).enqueue('settlement.instruct' as never, { transferId }, { dedupeKey: key });
  const r = (await db.execute(sql`UPDATE outbox SET status = 'dead', attempts = 8, last_error = 'x' WHERE dedupe_key = ${key} RETURNING id`)) as unknown as { rows: Array<{ id: number }> };
  return Number(r.rows[0].id);
}

const audits = () => db.select().from(auditEvents).orderBy(asc(auditEvents.id));
/** Every Redis key outside the session's own records (the session store rewrites those on reads). */
const redisKeys = () => [...redis.dump.keys()].filter((k) => !k.startsWith('staff_sess') && !k.startsWith('staff:')).sort();
const snapshot = async () =>
  JSON.stringify({
    keys: await db.select().from(apiKeys).orderBy(asc(apiKeys.id)),
    outbox: await db.select({ id: outboxTable.id, status: outboxTable.status, attempts: outboxTable.attempts }).from(outboxTable).orderBy(asc(outboxTable.id)),
    pa: await createPartnerIntegrationsStore(db).getIntegrations('pa'),
    audits: (await audits()).length,
    redis: redisKeys().map((k) => [k, redis.dump.get(k)]),
  });

let paKey = '';
let paDead = 0;
type Runner = { name: string; target: string; run: (extra?: Record<string, string>) => Promise<unknown>; done: (r: unknown) => void };
const RUNNERS: Runner[] = [
  {
    name: 'createKeyAction',
    target: 'api_key.issue',
    run: (extra) => createKeyAction(null, form({ mode: 'test', ...extra })),
    done: (r) => expect(r).toMatchObject({ ok: true, mode: 'test', plaintext: expect.any(String) }),
  },
  {
    name: 'rotateKeyAction',
    target: 'api_key.rotate',
    run: (extra) => rotateKeyAction(null, form({ id: paKey, ...extra })),
    done: (r) => expect(r).toMatchObject({ ok: true, mode: 'test', plaintext: expect.any(String) }),
  },
  {
    name: 'saveEndpointAction',
    target: 'webhook.endpoint.save',
    run: (extra) => saveEndpointAction(null, form({ url: 'https://new-rail.example.com/x', ...extra })),
    done: (r) => expect(r).toEqual({ ok: true }),
  },
  {
    name: 'rotateSecretAction',
    target: 'webhook.secret.rotate',
    run: (extra) => rotateSecretAction(null, form({ kind: 'signing', ...extra })),
    done: (r) => expect(r).toMatchObject({ ok: true, kind: 'signing', secret: expect.any(String) }),
  },
  {
    name: 'replayDeliveryAction',
    target: 'webhook.replay',
    run: (extra) => replayDeliveryAction(null, form({ id: String(paDead), ...extra })),
    done: (r) => expect(r).toEqual({ ok: true }),
  },
];

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  host = 'smartremit.ai';
  token = '';
  fetchStub.mockClear();
  logWarnSpy.mockClear();
  logErrorSpy.mockClear();
  logInfoSpy.mockClear();
  pokeSpy.mockClear();
  db = await freshDb();
  await seedPartner(db, 'pa', 'Partner A');
  await createPartnerIntegrationsStore(db).saveIntegrations('pa', rail());
  paKey = (await createApiKeyRepo(db).issue('pa', 'test')).keyId;
  await createStore(fakeRedis(), db).saveTransfer(transfer('t_pa', 'pa'));
  paDead = await deadRow('instruct:t_pa', 't_pa');
});

describe.each(RUNNERS)('$name: the 15-minute step-up', ({ run, done, target }) => {
  it('a stale session (never stepped up) → step_up_required (password factor when not enrolled), ZERO writes', async () => {
    await signInAs();
    const before = await snapshot();
    const r = await run();
    expect(r).toEqual({ ok: false, code: 'step_up_required', factor: 'password', error: t('partner.stepUp.required.password') });
    expect(await snapshot()).toBe(before);
    expect(pokeSpy).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('a step-up older than 15 minutes is stale: ZERO writes', async () => {
    await signInAs();
    await markFresh('pa-admin', Date.now() - 15 * 60 * 1000 - 1000);
    const before = await snapshot();
    expect(isStepUpRequired(await run())).toBe(true);
    expect(await snapshot()).toBe(before);
  });

  it('an enrolled account is asked for its TOTP code', async () => {
    await signInAs();
    await enrol();
    const before = await snapshot();
    expect(await run()).toEqual({ ok: false, code: 'step_up_required', factor: 'totp', error: t('partner.stepUp.required.totp') });
    expect(await snapshot()).toBe(before);
  });

  it('a fresh session (stepped up within 15 minutes) → the action runs', async () => {
    await signInAs();
    await markFresh();
    done(await run());
  });

  it('a step-up on ANOTHER session of the same user does not count', async () => {
    await signInAs();
    await markFresh();
    cookieJar.set(SESSION_COOKIE, await getAuthStore().createSession('pa-admin'));
    const before = await snapshot();
    expect(isStepUpRequired(await run())).toBe(true);
    expect(await snapshot()).toBe(before);
  });

  it('a Redis error on the step-up marker → refused, nothing written', async () => {
    await signInAs();
    await markFresh();
    const get = redis.get.bind(redis);
    redis.get = async (k: string) => {
      if (k.startsWith('staff_stepup:')) throw new Error('redis down');
      return get(k);
    };
    try {
      const before = await snapshot();
      expect(await run()).toEqual({ ok: false, error: t('partner.stepUp.unavailable') });
      expect(await snapshot()).toBe(before);
    } finally {
      redis.get = get;
    }
  });

  it('retry with a valid TOTP code → the action runs in the same request; auth.stepup audited with the server actorScope, no code', async () => {
    await signInAs();
    const secret = await enrol();
    const code = nextCode(secret);
    done(await run({ [STEP_UP_FIELD]: code }));
    const rows = await audits();
    const su = rows.filter((a) => a.action === 'auth.stepup');
    expect(su).toHaveLength(1);
    expect(su[0]).toMatchObject({ actor: 'pa-admin', actorType: 'staff', partnerId: 'pa' });
    expect(su[0].meta).toMatchObject({ factor: 'totp', target, actorScope: 'partner' });
    expect(JSON.stringify(rows)).not.toContain(code);
    expect(JSON.stringify([logWarnSpy.mock.calls, logErrorSpy.mock.calls, logInfoSpy.mock.calls])).not.toContain(code);
    // …and the session is now fresh: the next call needs no code.
    expect(isStepUpRequired(await run())).toBe(false);
  });

  it('retry with a wrong TOTP code → step_up_required (invalid), auth.stepup.failed audited, the action did NOT run', async () => {
    await signInAs();
    const secret = await enrol();
    const wrong = nextCode(secret) === '000000' ? '111111' : '000000';
    const r = await run({ [STEP_UP_FIELD]: wrong });
    expect(r).toEqual({ ok: false, code: 'step_up_required', factor: 'totp', error: t('partner.stepUp.invalid.totp') });
    const rows = await audits();
    expect(rows.map((a) => a.action)).toEqual(['auth.stepup.failed']);
    expect(rows[0].meta).toMatchObject({ factor: 'totp', target, actorScope: 'partner' });
    expect(JSON.stringify(rows)).not.toContain(wrong);
    expect(pokeSpy).not.toHaveBeenCalled();
  });

  it('a Redis error while verifying a submitted code → refused, the action did NOT run', async () => {
    await signInAs();
    const secret = await enrol();
    const incr = redis.incr.bind(redis);
    redis.incr = async (k: string) => {
      if (k.startsWith('staff_su:')) throw new Error('redis down');
      return incr(k);
    };
    try {
      const before = await snapshot();
      expect(await run({ [STEP_UP_FIELD]: nextCode(secret) })).toEqual({ ok: false, error: t('partner.stepUp.unavailable') });
      expect(await snapshot()).toBe(before);
      expect(pokeSpy).not.toHaveBeenCalled();
    } finally {
      redis.incr = incr;
    }
  });

  it('an enrolled account can NOT step up with its password', async () => {
    await signInAs();
    await enrol();
    expect(await run({ [STEP_UP_FIELD]: PASSWORD })).toMatchObject({ code: 'step_up_required', factor: 'totp' });
  });

  it('not enrolled: retry with the current password → runs; a wrong password → invalid; neither is recorded or logged', async () => {
    await signInAs();
    expect(await run({ [STEP_UP_FIELD]: 'not my password' })).toEqual({ ok: false, code: 'step_up_required', factor: 'password', error: t('partner.stepUp.invalid.password') });
    done(await run({ [STEP_UP_FIELD]: PASSWORD }));
    const all = JSON.stringify([await audits(), logWarnSpy.mock.calls, logErrorSpy.mock.calls, logInfoSpy.mock.calls]);
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain('not my password');
  });
});

describe('step-up has its OWN throttle, separate from /login', () => {
  it('past the per-session cap, even a correct code is refused and nothing runs', async () => {
    await signInAs();
    const secret = await enrol();
    for (let i = 0; i < STEP_UP_SESSION_HOURLY_CAP; i++) await createKeyAction(null, form({ mode: 'test', [STEP_UP_FIELD]: '000000' }));
    const before = (await db.select().from(apiKeys)).length;
    const r = await createKeyAction(null, form({ mode: 'test', [STEP_UP_FIELD]: nextCode(secret) }));
    expect(r).toEqual({ ok: false, code: 'step_up_required', factor: 'totp', error: t('partner.stepUp.throttled') });
    expect((await db.select().from(apiKeys)).length).toBe(before);
  });
  it('a /login budget burned for this username and IP does not block a signed-in step-up, and step-up failures leave /login untouched', async () => {
    await signInAs();
    const secret = await enrol();
    const t0 = Date.now();
    const burned = [staffLoginKeys.ui('pa-admin', '203.0.113.7', t0), staffLoginKeys.u('pa-admin', t0), staffLoginKeys.ip('203.0.113.7', t0)];
    for (const k of burned) await redis.set(k, '999');
    const loginKeys = () => [...redis.dump.keys()].filter((k) => k.startsWith('staff_lf:')).sort().map((k) => [k, redis.dump.get(k)]);
    const before = loginKeys();
    expect(isStepUpRequired(await rotateSecretAction(null, form({ kind: 'signing', [STEP_UP_FIELD]: '000000' })))).toBe(true);
    expect(await rotateSecretAction(null, form({ kind: 'signing', [STEP_UP_FIELD]: nextCode(secret) }))).toMatchObject({ ok: true, secret: expect.any(String) });
    expect(loginKeys()).toEqual(before);
  });
});

describe('ungated: making things safer never needs a re-auth', () => {
  it('revokeKeyAction works on a stale session', async () => {
    await signInAs();
    expect(await revokeKeyAction(form({ id: paKey }))).toEqual({ ok: true });
    const [k] = await db.select().from(apiKeys).where(eq(apiKeys.id, paKey));
    expect(k.revokedAt).not.toBeNull();
  });
  it('sendTestAction works on a stale session', async () => {
    await signInAs();
    expect(await sendTestAction(null, form())).toMatchObject({ ok: true });
  });
});
