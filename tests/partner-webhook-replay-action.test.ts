import { describe, it, expect, vi, beforeEach } from 'vitest';
import { asc, sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { Staff, Transfer } from '@/lib/types';

// UI redesign M3-15b: replayDeliveryAction, the partner's Replay button on a DEAD settlement
// instruction. Admin only (+ MFA enrolment gate), apex host only; the tenant is the SESSION's
// partner (any partnerId / partner field is ignored) and the target id resolves INSIDE it: another
// tenant's row, an already-replayed row, a non-instruct row and a missing id all read the same
// "not found" with no write. Success = the tenant-scoped retry + one audit row in ONE transaction,
// then a worker poke. Rate-limited per tenant (fail closed). No inline send: fetch is never called.

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

const pokeSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/outbox', async (orig) => ({ ...(await orig<typeof import('@/lib/outbox')>()), pokeWorker: pokeSpy }));

import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { MFA_PENDING_PREFIX } from '@/lib/partner-mfa-gate';
import { auditEvents, outbox as outboxTable } from '@/db/schema';
import { createStore } from '@/lib/store';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import type { PartnerIntegrations } from '@/lib/partner-integrations';
import { REPLAY_LIMIT } from '@/lib/partner-webhook-replay';
import { t } from '@/lib/i18n';
import { replayDeliveryAction } from '@/app/partner/(app)/integrations/webhooks/actions';

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
const audits = () => db.select().from(auditEvents).orderBy(asc(auditEvents.id));
const outboxRows = () => db.select({ id: outboxTable.id, status: outboxTable.status, attempts: outboxTable.attempts }).from(outboxTable).orderBy(asc(outboxTable.id));
const snapshot = async () => JSON.stringify({ outbox: await outboxRows(), n: (await audits()).length });
const PHONE_SHAPE = /\+?\d{10,}/;
const rail = (providerType: 'http' | 'simulator' = 'http'): PartnerIntegrations => ({
  kyc: {},
  payment: { providerType, credentials: { settlementUrl: 'https://rail.example.com/instruct', signingSecret: 'a'.repeat(64) }, webhookSecret: 'b'.repeat(64) },
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
async function deadRow(kind: string, payload: Record<string, unknown>, key: string): Promise<number> {
  await createOutboxRepo(db).enqueue(kind as never, payload, { dedupeKey: key });
  const r = (await db.execute(sql`UPDATE outbox SET status = 'dead', attempts = 8, last_error = 'Settlement instruction rejected (500)' WHERE dedupe_key = ${key} RETURNING id`)) as unknown as { rows: Array<{ id: number }> };
  return Number(r.rows[0].id);
}
const statusOf = async (id: number) => (await outboxRows()).find((r) => r.id === id)?.status;

let paRow: number;
let pbRow: number;
let paWa: number;
const NOT_FOUND = () => ({ ok: false, error: t('partner.webhooks.replay.notFound') });

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  host = 'smartremit.ai';
  pokeSpy.mockClear();
  db = await freshDb();
  await seedPartner(db, 'pa', 'Partner A');
  await seedPartner(db, 'pb', 'Partner B');
  await createPartnerIntegrationsStore(db).saveIntegrations('pa', rail());
  await createPartnerIntegrationsStore(db).saveIntegrations('pb', rail());
  const store = createStore(fakeRedis(), db);
  await store.saveTransfer(transfer('t_pa', 'pa'));
  await store.saveTransfer(transfer('t_pb', 'pb'));
  paRow = await deadRow('settlement.instruct', { transferId: 't_pa' }, 'instruct:t_pa');
  pbRow = await deadRow('settlement.instruct', { transferId: 't_pb' }, 'instruct:t_pb');
  paWa = await deadRow('whatsapp.text', { to: '15551230000', text: 'hi', partnerId: 'pa' }, 'wa:1');
});

const run = (extra: Record<string, string> = {}) => replayDeliveryAction(null, form({ id: String(paRow), ...extra }));

describe('replayDeliveryAction: the per-action checklist', () => {
  it('1. anonymous → /login; a platform account → /admin-dashboard; no change', async () => {
    const before = await snapshot();
    await expect(run()).rejects.toThrow('REDIRECT:/login');
    await signInAs({ username: 'plat', partnerId: undefined });
    await expect(run()).rejects.toThrow('REDIRECT:/admin-dashboard');
    expect(await snapshot()).toBe(before);
    expect(pokeSpy).not.toHaveBeenCalled();
  });

  it('2. a disallowed role (agent, support, finance) → /partner with no change', async () => {
    const before = await snapshot();
    for (const role of ['agent', 'support', 'finance'] as const) {
      await signInAs({ username: `pa-${role}`, role });
      await expect(run()).rejects.toThrow('REDIRECT:/partner');
    }
    expect(await snapshot()).toBe(before);
    expect(pokeSpy).not.toHaveBeenCalled();
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
  });

  it("3. A acting on B's dead row → not found; B's row stays dead; no audit, no poke", async () => {
    await signInAs({});
    const before = await snapshot();
    expect(await replayDeliveryAction(null, form({ id: String(pbRow) }))).toEqual(NOT_FOUND());
    expect(await statusOf(pbRow)).toBe('dead');
    expect(await snapshot()).toBe(before);
    expect(pokeSpy).not.toHaveBeenCalled();
  });

  it('4. a form naming B (partnerId / partner / tenant = pb) acting on A\'s own id → acts on A only', async () => {
    await signInAs({});
    expect(await run({ partnerId: 'pb', partner: 'pb', tenant: 'pb' })).toEqual({ ok: true });
    expect(await statusOf(paRow)).toBe('pending');
    expect(await statusOf(pbRow)).toBe('dead');
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0].partnerId).toBe('pa');
    expect(JSON.stringify(rows[0])).not.toContain('pb');
  });

  it('5. an invalid id is refused before any write (same not-found text)', async () => {
    await signInAs({});
    const before = await snapshot();
    for (const id of ['', 'abc', '-1', '0', '1.5', '1e3', ` ${paRow}`, '9'.repeat(30)]) {
      expect(await replayDeliveryAction(null, form({ id }))).toEqual(NOT_FOUND());
    }
    expect(await replayDeliveryAction(null, form())).toEqual(NOT_FOUND());
    expect(await snapshot()).toBe(before);
    expect(pokeSpy).not.toHaveBeenCalled();
  });

  it('6. success → the row is pending again, ONE audit row (pa, the session user, actorScope, outboxId only), then a poke', async () => {
    await signInAs({});
    expect(await run()).toEqual({ ok: true });
    expect((await outboxRows()).find((r) => r.id === paRow)).toMatchObject({ status: 'pending', attempts: 0 });
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: 'pa', actor: 'pa-admin', actorType: 'staff', action: 'webhook.replay', subjectId: String(paRow) });
    expect(rows[0].meta).toEqual({ outboxId: paRow, actorScope: 'partner' });
    expect(JSON.stringify(rows[0].meta)).not.toMatch(PHONE_SHAPE);
    expect(pokeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('replayDeliveryAction: idempotency, kinds, rail type, rate limit', () => {
  it('a double submit: the second is not found, with no second audit row (the status guard)', async () => {
    await signInAs({});
    expect(await run()).toEqual({ ok: true });
    expect(await run()).toEqual(NOT_FOUND());
    expect(await audits()).toHaveLength(1);
    expect(pokeSpy).toHaveBeenCalledTimes(1);
  });

  it('a dead non-instruct row (whatsapp.text) is never replayed', async () => {
    await signInAs({});
    expect(await replayDeliveryAction(null, form({ id: String(paWa) }))).toEqual(NOT_FOUND());
    expect(await statusOf(paWa)).toBe('dead');
    expect(await audits()).toHaveLength(0);
  });

  it('a SmartRemit-managed rail (simulator) refuses with the managed copy and changes nothing', async () => {
    await createPartnerIntegrationsStore(db).saveIntegrations('pa', rail('simulator'));
    await signInAs({});
    const before = await snapshot();
    expect(await run()).toEqual({ ok: false, error: t('partner.webhooks.managed') });
    expect(await snapshot()).toBe(before);
  });

  it(`the ${REPLAY_LIMIT.limit + 1}th replay in the window is rate-limited with no write`, async () => {
    await signInAs({});
    for (let i = 0; i < REPLAY_LIMIT.limit; i++) {
      expect(await replayDeliveryAction(null, form({ id: '999999' }))).toEqual(NOT_FOUND());
    }
    const before = await snapshot();
    expect(await run()).toEqual({ ok: false, error: t('partner.webhooks.replay.rateLimited') });
    expect(await snapshot()).toBe(before);
    expect(await statusOf(paRow)).toBe('dead');
  });

  it('a Redis failure on the rate limit fails CLOSED (no write)', async () => {
    await signInAs({});
    const incr = redis.incr;
    redis.incr = async () => {
      throw new Error('redis down');
    };
    try {
      const before = await snapshot();
      expect(await run()).toEqual({ ok: false, error: t('partner.webhooks.replay.rateLimited') });
      expect(await snapshot()).toBe(before);
    } finally {
      redis.incr = incr;
    }
  });
});
