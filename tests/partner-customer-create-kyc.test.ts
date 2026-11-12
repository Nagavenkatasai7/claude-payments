/**
 * Fix pack 7 T26 (R12, P22): the partner's own create-customer action for a partner that DECIDES
 * KYC (partnerDecidesKyc). A 'verified' customer is accepted only from a qualified compliance user
 * (fresh staff read + two-step + isQualifiedComplianceUser) after the forced step-up 'kyc.decide';
 * anyone else gets the existing verifiedNotAllowed copy with nothing written and no code spent.
 * 'not_started' and every partner that does not decide KYC are unchanged (the existing suites of
 * tests/partner-customer-create*.test.ts stay untouched).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { signInAs } from './helpers-partner-app';
import { certifiedQueuePartner, seedComplianceUsers } from './helpers-hold';
import type { Db } from '@/db/client';

const redis = fakeRedis();
let db: Db;
const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
    getAll: () => [...cookieJar.entries()].map(([name, value]) => ({ name, value })),
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
vi.mock('@/lib/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/store')>('@/lib/store');
  return { ...actual, getStore: () => actual.createStore(redis, db) };
});
vi.mock('@/lib/customer-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/customer-store')>('@/lib/customer-store');
  return { ...actual, getCustomerStore: (store: Parameters<typeof actual.createCustomerStore>[1]) => actual.createCustomerStore(db, store) };
});
const mfa = vi.hoisted(() => ({ enrolled: true }));
vi.mock('@/lib/staff-mfa-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-mfa-store')>('@/lib/staff-mfa-store');
  return { ...actual, getStaffMfaStore: () => actual.createStaffMfaStore(redis), staffMfaEnrolled: async () => mfa.enrolled };
});
const gate = vi.hoisted(() => ({
  calls: [] as Array<{ target: string; opts: unknown }>,
  result: null as null | { ok: false; error: string; code?: string; factor?: string },
}));
vi.mock('@/lib/partner-step-up-gate', async (orig) => ({
  ...(await orig<typeof import('@/lib/partner-step-up-gate')>()),
  gatePartnerStepUp: async (_ctx: unknown, _fd: FormData, target: string, opts?: unknown) => {
    gate.calls.push({ target, opts });
    return gate.result;
  },
}));

import { createCustomerAction } from '@/app/partner/(app)/customers/new/actions';
import { t } from '@/lib/i18n';

const P = 'acme';
const PHONE = '15551230000';
const REASON = 'Checked passport in branch';
const STEP_UP = { ok: false as const, error: 'step up', code: 'step_up_required', factor: 'totp' };
const form = (o: Record<string, string> = {}) => {
  const fd = new FormData();
  fd.set('phone', PHONE);
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  return fd;
};
type AuditRow = { actor: string; action: string; meta: Record<string, unknown> };
const audits = async () => ((await db.execute(sql`SELECT actor, action, meta FROM audit_events ORDER BY id`)) as unknown as { rows: AuditRow[] }).rows;
const customerCount = async () => Number(((await db.execute(sql`SELECT count(*)::int AS n FROM customers`)) as unknown as { rows: Array<{ n: number }> }).rows[0].n);
const kycOf = async () =>
  ((await db.execute(sql`SELECT kyc_status FROM customers WHERE partner_id = ${P} AND phone = ${PHONE}`)) as unknown as { rows: Array<{ kyc_status: string }> }).rows[0]?.kyc_status;
const created = (err: unknown) => (err as Error).message.startsWith('REDIRECT:/partner/customers/');

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  mfa.enrolled = true;
  gate.calls = [];
  gate.result = null;
  db = await freshDb();
  await certifiedQueuePartner(db, { partnerId: P, kycMode: 'delegated', users: ['co-a'] });
  await db.execute(sql`UPDATE partners SET countries = '["US"]'::jsonb WHERE id = ${P}`);
});

/** co-a: a listed compliance ADMIN (the create page is PARTNER_ADMIN) with two-step enrolled. */
const asCo = async () => {
  await seedComplianceUsers(db, P, ['co-a'], { redis, role: 'admin' });
  await signInAs(redis, cookieJar, { username: 'co-a', name: 'Compliance co-a', partnerId: P, role: 'admin' });
};

describe('createCustomerAction for a partner that decides KYC', { retry: 0 }, () => {
  it('a qualified compliance user with MFA creates a verified customer only after the forced step-up; kyc.manual_override.create as today', async () => {
    await asCo();
    const err = await createCustomerAction(form({ kycStatus: 'verified', reason: REASON })).catch((e: unknown) => e);
    expect(created(err)).toBe(true);
    expect(gate.calls).toEqual([{ target: 'kyc.decide', opts: { always: true } }]);
    expect(await kycOf()).toBe('verified');
    const rows = await audits();
    expect(rows.map((r) => r.action)).toEqual(['customer.create', 'kyc.manual_override.create']);
    expect(rows[1]).toMatchObject({
      actor: 'co-a',
      meta: { previousStatus: null, newStatus: 'verified', reason: REASON, source: 'manual', reviewerName: 'Compliance co-a (co-a)', actorScope: 'partner' },
    });
  });

  it('a step_up_required result is returned as-is and nothing is written', async () => {
    await asCo();
    gate.result = STEP_UP;
    expect(await createCustomerAction(form({ kycStatus: 'verified', reason: REASON }))).toEqual(STEP_UP);
    expect(await customerCount()).toBe(0);
    expect(await audits()).toEqual([]);
  });

  it('a non-qualified admin (not listed, or listed without two-step) posting verified -> verifiedNotAllowed, nothing written, step-up never called', async () => {
    await signInAs(redis, cookieJar, { username: 'acme-admin', partnerId: P, role: 'admin' });
    const refused = { ok: false, error: t('partner.customers.create.verifiedNotAllowed') };
    expect(await createCustomerAction(form({ kycStatus: 'verified', reason: REASON }))).toEqual(refused);
    await asCo();
    mfa.enrolled = false;
    expect(await createCustomerAction(form({ kycStatus: 'verified', reason: REASON }))).toEqual(refused);
    expect(gate.calls).toEqual([]);
    expect(await customerCount()).toBe(0);
    expect(await audits()).toEqual([]);
  });

  it("'not_started' by any admin is created as today, with no step-up", async () => {
    await signInAs(redis, cookieJar, { username: 'acme-admin', partnerId: P, role: 'admin' });
    const err = await createCustomerAction(form({ kycStatus: 'not_started' })).catch((e: unknown) => e);
    expect(created(err)).toBe(true);
    expect(await kycOf()).toBe('not_started');
    expect((await audits()).map((r) => r.action)).toEqual(['customer.create']);
    expect(gate.calls).toEqual([]);
  });

  it('a plain delegated partner (not certified): verified by any admin as today, no step-up', async () => {
    await db.execute(sql`UPDATE partners SET live_controls = '{}'::jsonb WHERE id = ${P}`);
    await signInAs(redis, cookieJar, { username: 'acme-admin', partnerId: P, role: 'admin' });
    const err = await createCustomerAction(form({ kycStatus: 'verified', reason: REASON })).catch((e: unknown) => e);
    expect(created(err)).toBe(true);
    expect(await kycOf()).toBe('verified');
    expect(gate.calls).toEqual([]);
  });
});
