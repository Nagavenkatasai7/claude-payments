import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { expectPartnerActionContract, seedTwoTenants, signInAs } from './helpers-partner-app';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import type { Db } from '@/db/client';
import type { Customer, SendLimitOverride } from '@/lib/types';

// UI redesign M3-12, Task 12.2: setCustomerLimitAction — a partner admin's per-customer send limit.
// A MONEY-path write: clamped to the platform + SmartRemit partner level, never over a live
// SmartRemit override, tenant-scoped by the sealed ref + session tenant, audited in the same
// transaction with a hashed customer subject. The M3-1 harness: real auth store on a fake Redis,
// real customer + partner stores and ledger on PGlite.
const redis = fakeRedis();
const cookieJar = new Map<string, string>();
let db: Db;
let pgPartnerStore: PartnerStore;
let host = 'smartremit.ai';
const fail = { audit: false };
const revalidated: string[] = [];

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
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => void revalidated.push(p) }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/store')>('@/lib/store');
  return { ...actual, getStore: () => actual.createStore(redis, db) };
});
vi.mock('@/lib/customer-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/customer-store')>('@/lib/customer-store');
  return { ...actual, getCustomerStore: (store: Parameters<typeof actual.createCustomerStore>[1]) => actual.createCustomerStore(db, store) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => pgPartnerStore };
});
vi.mock('@/db/repos/aux-repos', async () => {
  const actual = await vi.importActual<typeof import('@/db/repos/aux-repos')>('@/db/repos/aux-repos');
  return {
    ...actual,
    createAuditRepo: (d: Parameters<typeof actual.createAuditRepo>[0]) => {
      const repo = actual.createAuditRepo(d);
      if (fail.audit) repo.record = async () => Promise.reject(new Error('audit down 15551230000'));
      return repo;
    },
  };
});

import { setCustomerLimitAction } from '@/app/partner/(app)/customers/[ref]/limit-actions';
import { auditSubjectId, sealCustomerRef } from '@/lib/customer-ref';
import { PARTNER_ADMIN } from '@/lib/partner-access';
import { PARTNER_ROUTES } from '@/app/partner/routes';
import { PLATFORM_SEND_LIMITS, resolveEffectiveSendLimits } from '@/lib/send-limits';
import { t } from '@/lib/i18n';

const SHARED = '15551230000'; // the SAME phone at both tenants: different customers
const OTHER_A = '15557770000';
const future = () => new Date(Date.now() + 7 * 86_400_000).toISOString();
const past = () => new Date(Date.now() - 86_400_000).toISOString();
const NOT_FOUND = { ok: false, error: t('partner.customers.notFound') };

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
function customer(over: Partial<Customer>): Customer {
  return {
    senderPhone: SHARED,
    firstSeenAt: daysAgo(10),
    kycStatus: 'verified',
    senderCountry: 'US',
    partnerId: 'pa',
    createdAt: daysAgo(10),
    updatedAt: daysAgo(1),
    ...over,
  } as Customer;
}

function form(ref: string, o: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set('ref', ref);
  const values = { perTransferUsd: '500', t1DailyUsd: '', expiresAt: '', reason: 'Customer asked for a lower cap', ...o };
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

async function overrideOf(partnerId: string, phone: string): Promise<SendLimitOverride | null> {
  const res = await db.execute(sql`SELECT send_limit_override FROM customers WHERE partner_id = ${partnerId} AND phone = ${phone}`);
  const rows = (res as unknown as { rows: Array<{ send_limit_override: SendLimitOverride | null }> }).rows;
  return rows[0]?.send_limit_override ?? null;
}
async function plantOverride(partnerId: string, phone: string, v: SendLimitOverride | null) {
  await createCustomerStore(db, createStore(redis, db)).setSendLimitOverride(partnerId, phone, v);
}
async function limitAudits() {
  const res = await db.execute(
    sql`SELECT partner_id, actor, actor_type, action, subject_id, meta FROM audit_events WHERE action LIKE 'send_limits.%' ORDER BY id`,
  );
  return (res as unknown as {
    rows: Array<{ partner_id: string; actor: string; actor_type: string; action: string; subject_id: string; meta: Record<string, unknown> }>;
  }).rows;
}
const snapshot = async () => ({
  audit: (await db.execute(sql`SELECT count(*)::int AS n FROM audit_events`)) as unknown as { rows: unknown[] },
  a: await overrideOf('pa', SHARED),
  b: await overrideOf('pb', SHARED),
});
const snap = async () => {
  const s = await snapshot();
  return { audit: JSON.stringify(s.audit.rows), a: s.a, b: s.b };
};

const REF_A = () => sealCustomerRef('pa', SHARED);
const REF_B = () => sealCustomerRef('pb', SHARED);
const asAdmin = () => signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin' });

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  revalidated.length = 0;
  host = 'smartremit.ai';
  fail.audit = false;
  db = await freshDb();
  pgPartnerStore = createPartnerStore(db);
  await seedTwoTenants(db);
  const cs = createCustomerStore(db, createStore(redis, db));
  await cs.saveCustomer(customer({ partnerId: 'pa' }));
  await cs.saveCustomer(customer({ partnerId: 'pb' }));
  await cs.saveCustomer(customer({ partnerId: 'pa', senderPhone: OTHER_A }));
});

describe('setCustomerLimitAction: the shared action contract', () => {
  it('runs checklist items 1-4 (gate, role, foreign ref, forged tenant fields)', async () => {
    await expectPartnerActionContract({
      db,
      redis,
      cookieJar,
      action: setCustomerLimitAction,
      form: (ref) => form(ref),
      ownId: REF_A(),
      foreignId: REF_B(),
      allowedRole: 'admin',
      disallowedRole: 'agent',
      snapshot: snap,
    });
    // The forged-tenant success landed on A only; B's same-phone customer is untouched.
    expect(await overrideOf('pa', SHARED)).toMatchObject({ perTransferCapCents: 50_000, setScope: 'partner' });
    expect(await overrideOf('pb', SHARED)).toBeNull();
  });
  it('the policy is PARTNER_ADMIN, and every role it admits can open the customers page', () => {
    for (const r of PARTNER_ADMIN.roles) expect(PARTNER_ROUTES.customers.policy.roles).toContain(r);
  });
  it('a partner-site host is refused before anything else', async () => {
    await asAdmin();
    host = 'acme.smartremit.ai';
    const before = await snap();
    await expect(setCustomerLimitAction(form(REF_A()))).rejects.toThrow('NOT_FOUND');
    expect(await snap()).toEqual(before);
  });
  it('an agent → REDIRECT:/partner; support and finance are refused too; nothing written', async () => {
    const before = await snap();
    await signInAs(redis, cookieJar, { username: 'pa-agent', partnerId: 'pa', role: 'agent' });
    await expect(setCustomerLimitAction(form(REF_A()))).rejects.toThrow(/^REDIRECT:\/partner$/);
    await signInAs(redis, cookieJar, { username: 'pa-support', partnerId: 'pa', role: 'support' });
    await expect(setCustomerLimitAction(form(REF_A()))).rejects.toThrow(/^REDIRECT:\/partner$/);
    await signInAs(redis, cookieJar, { username: 'pa-fin', partnerId: 'pa', role: 'finance' });
    await expect(setCustomerLimitAction(form(REF_A()))).rejects.toThrow(/^REDIRECT:\/(partner|login)$/);
    expect(await snap()).toEqual(before);
  });
  it('missing, foreign, junk and raw-phone refs all return the SAME not-found result', async () => {
    await asAdmin();
    const before = await snap();
    for (const ref of [REF_B(), sealCustomerRef('pb', '15559990000'), sealCustomerRef('pa', '15559990000'), SHARED, 'junk', '']) {
      expect(await setCustomerLimitAction(form(ref)), ref).toEqual(NOT_FOUND);
    }
    expect(await snap()).toEqual(before);
  });
});

describe('setCustomerLimitAction: input (item 5: refused before any write)', () => {
  const refuses = async (fd: FormData) => {
    const before = await snap();
    const r = (await setCustomerLimitAction(fd)) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(await snap()).toEqual(before);
    return r;
  };
  it('a missing reason, a bad figure, a past expiry, no figure at all', async () => {
    await asAdmin();
    expect((await refuses(form(REF_A(), { reason: '   ' }))).error).toBe(t('partner.limits.reasonRequired'));
    expect((await refuses(form(REF_A(), { perTransferUsd: '12.50' }))).error).toBe(t('partner.limits.invalid'));
    expect((await refuses(form(REF_A(), { perTransferUsd: '10001' }))).error).toBe(t('partner.limits.invalid'));
    expect((await refuses(form(REF_A(), { perTransferUsd: '0' }))).error).toBe(t('partner.limits.invalid'));
    expect((await refuses(form(REF_A(), { expiresAt: past() }))).error).toBe(t('partner.limits.invalid'));
    expect((await refuses(form(REF_A(), { perTransferUsd: '', t1DailyUsd: '' }))).error).toBe(t('partner.limits.invalid'));
  });
  it('a reason carrying a phone or account number (never echoed back)', async () => {
    await asAdmin();
    const r = await refuses(form(REF_A(), { reason: 'Customer on +1 415 555 0101 asked' }));
    expect(r.error).toBe(t('partner.limits.reasonHasNumber'));
    expect(r.error).not.toContain('415');
  });
  it('a posted T0 figure alone is not a limit (T0 is never set per customer)', async () => {
    await asAdmin();
    await refuses(form(REF_A(), { perTransferUsd: '', t0DailyUsd: '100' }));
  });
});

describe('setCustomerLimitAction: the clamp (SPEC §3.4)', () => {
  it('$10,000 posted → stored 299_900, audit meta.clamped === true; the resolver applies it from the customer', async () => {
    await asAdmin();
    expect(await setCustomerLimitAction(form(REF_A(), { perTransferUsd: '10000', t1DailyUsd: '10000' }))).toEqual({ ok: true });
    const stored = await overrideOf('pa', SHARED);
    expect(stored).toMatchObject({ perTransferCapCents: 299_900, t1DailyCapCents: 299_900, setScope: 'partner', setBy: 'pa-admin' });
    const [row] = await limitAudits();
    expect(row.meta.clamped).toBe(true);
    const eff = resolveEffectiveSendLimits(null, { sendLimitOverride: stored! });
    expect(eff.source.perTransferCapCents).toBe('customer');
    expect(eff.perTransferCapCents).toBeLessThanOrEqual(PLATFORM_SEND_LIMITS.perTransferCapCents);
  });
  it('a SmartRemit partner-level tightening caps the write (clamped), and a value under it is stored as-is', async () => {
    await db.execute(sql`UPDATE partners SET send_limits = ${JSON.stringify({ perTransferCapCents: 100_000 })}::jsonb WHERE id = 'pa'`);
    await asAdmin();
    await setCustomerLimitAction(form(REF_A(), { perTransferUsd: '2000' }));
    expect(await overrideOf('pa', SHARED)).toMatchObject({ perTransferCapCents: 100_000 });
    expect((await limitAudits())[0].meta.clamped).toBe(true);
    await setCustomerLimitAction(form(REF_A(), { perTransferUsd: '300' }));
    expect(await overrideOf('pa', SHARED)).toMatchObject({ perTransferCapCents: 30_000 });
    expect((await limitAudits())[1].meta.clamped).toBe(false);
  });
});

describe('setCustomerLimitAction: never over a SmartRemit override', () => {
  const PLATFORM_RAISE: SendLimitOverride = { perTransferCapCents: 500_000, t1DailyCapCents: 500_000, setBy: 'root', setAt: '2026-09-01T00:00:00.000Z', setScope: 'platform' };
  const LEGACY_RAISE: SendLimitOverride = { perTransferCapCents: 500_000, setBy: 'root', setAt: '2026-09-01T00:00:00.000Z' };
  for (const [name, planted] of [['a platform-marked', PLATFORM_RAISE], ['a legacy (no setScope)', LEGACY_RAISE]] as const) {
    it(`${name} live override refuses BOTH set and clear: the row unchanged, no audit`, async () => {
      await plantOverride('pa', SHARED, planted);
      await asAdmin();
      const before = await snap();
      expect(await setCustomerLimitAction(form(REF_A(), { perTransferUsd: '100' }))).toEqual({ ok: false, error: t('partner.limits.setBySmartRemit') });
      expect(await setCustomerLimitAction(form(REF_A(), { clear: 'on' }))).toEqual({ ok: false, error: t('partner.limits.setBySmartRemit') });
      expect(await snap()).toEqual(before);
      expect(await overrideOf('pa', SHARED)).toEqual(planted);
      expect(await limitAudits()).toHaveLength(0);
    });
  }
  it('a live platform override with a future expiry is still refused', async () => {
    await plantOverride('pa', SHARED, { ...PLATFORM_RAISE, expiresAt: future() });
    await asAdmin();
    expect(await setCustomerLimitAction(form(REF_A()))).toEqual({ ok: false, error: t('partner.limits.setBySmartRemit') });
  });
  it('an EXPIRED platform override may be replaced; the audit records it as old', async () => {
    const lapsed = { ...PLATFORM_RAISE, expiresAt: past() };
    await plantOverride('pa', SHARED, lapsed);
    await asAdmin();
    expect(await setCustomerLimitAction(form(REF_A()))).toEqual({ ok: true });
    expect(await overrideOf('pa', SHARED)).toMatchObject({ perTransferCapCents: 50_000, setScope: 'partner' });
    // A SmartRemit staff username never lands in the partner's tenant audit row.
    expect((await limitAudits())[0].meta.old).toEqual({ ...lapsed, setBy: 'smartremit' });
    expect(JSON.stringify(await limitAudits())).not.toContain('"root"');
  });
  it('its OWN partner-set override may be replaced and cleared', async () => {
    await asAdmin();
    await setCustomerLimitAction(form(REF_A(), { perTransferUsd: '500' }));
    await setCustomerLimitAction(form(REF_A(), { perTransferUsd: '400', reason: 'Lowered again after review' }));
    expect(await overrideOf('pa', SHARED)).toMatchObject({ perTransferCapCents: 40_000 });
    expect(await setCustomerLimitAction(form(REF_A(), { clear: 'on', perTransferUsd: '99999' }))).toEqual({ ok: true });
    expect(await overrideOf('pa', SHARED)).toBeNull();
    const rows = await limitAudits();
    expect(rows.map((r) => r.action)).toEqual(['send_limits.set', 'send_limits.set', 'send_limits.clear']);
    expect(rows[2].meta).toMatchObject({ new: null, old: { perTransferCapCents: 40_000, setScope: 'partner' } });
  });
});

describe('setCustomerLimitAction: success (item 6)', () => {
  it('stores the server-built value and writes exactly one tenant-bound, hashed-subject audit row without PII', async () => {
    await asAdmin();
    const exp = future();
    expect(await setCustomerLimitAction(form(REF_A(), { perTransferUsd: '500', t1DailyUsd: '1500', expiresAt: exp }))).toEqual({ ok: true });
    const stored = await overrideOf('pa', SHARED);
    expect(stored).toEqual({
      perTransferCapCents: 50_000,
      t1DailyCapCents: 150_000,
      expiresAt: exp,
      setBy: 'pa-admin',
      setAt: expect.any(String),
      setScope: 'partner',
    });
    const rows = await limitAudits();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({ partner_id: 'pa', actor: 'pa-admin', actor_type: 'staff', action: 'send_limits.set' });
    expect(row.subject_id).toBe(auditSubjectId('pa', SHARED));
    expect(row.subject_id.startsWith('cust:')).toBe(true);
    expect(row.meta).toEqual({
      scope: 'customer',
      setScope: 'partner',
      actorScope: 'partner',
      old: null,
      new: stored,
      reason: 'Customer asked for a lower cap',
      expiresAt: exp,
      clamped: false,
    });
    const serial = JSON.stringify(row);
    expect(serial).not.toMatch(/\+?\d{10,}/);
    expect(serial).not.toContain(SHARED);
    expect(serial).not.toContain('555123');
    expect(revalidated.every((p) => p.startsWith('/partner'))).toBe(true);
  });
  it('forged setScope / actorScope / setBy / partnerId fields are ignored: the stored and audited values are server-built', async () => {
    await asAdmin();
    const fd = form(REF_A());
    for (const [k, v] of Object.entries({ setScope: 'platform', actorScope: 'platform', setBy: 'root', setAt: '2020-01-01', partnerId: 'pb', t0DailyUsd: '1' })) fd.set(k, v);
    expect(await setCustomerLimitAction(fd)).toEqual({ ok: true });
    const stored = await overrideOf('pa', SHARED);
    expect(stored).toMatchObject({ setScope: 'partner', setBy: 'pa-admin' });
    expect(stored).not.toHaveProperty('t0DailyCapCents');
    expect(stored!.setAt).not.toBe('2020-01-01');
    const [row] = await limitAudits();
    expect(row.meta).toMatchObject({ setScope: 'partner', actorScope: 'partner' });
    expect(await overrideOf('pb', SHARED)).toBeNull();
  });
  it('only send_limit_override (+ updated_at) moves on the row; other customers and Redis (velocity, sessions) are untouched', async () => {
    await asAdmin();
    const rowOf = async (p: string, ph: string) => {
      const res = await db.execute(sql`SELECT * FROM customers WHERE partner_id = ${p} AND phone = ${ph}`);
      const r = { ...(res as unknown as { rows: Array<Record<string, unknown>> }).rows[0] };
      delete r.send_limit_override;
      delete r.updated_at;
      return r;
    };
    const before = { a: await rowOf('pa', SHARED), other: await overrideOf('pa', OTHER_A), keys: [...redis.dump.keys()].sort() };
    expect(await setCustomerLimitAction(form(REF_A()))).toEqual({ ok: true });
    expect(await rowOf('pa', SHARED)).toEqual(before.a);
    expect(await overrideOf('pa', OTHER_A)).toEqual(before.other);
    expect([...redis.dump.keys()].sort()).toEqual(before.keys);
  });
  it('an audit insert failure rolls the limit write back and returns the generic failure (no phone in the result)', async () => {
    await asAdmin();
    fail.audit = true;
    const r = (await setCustomerLimitAction(form(REF_A()))) as { ok: boolean; error: string };
    expect(r).toEqual({ ok: false, error: t('partner.common.failed') });
    expect(await overrideOf('pa', SHARED)).toBeNull();
  });
});
