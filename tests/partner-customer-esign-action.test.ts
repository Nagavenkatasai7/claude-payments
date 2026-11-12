import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { expectPartnerActionContract, seedTwoTenants, signInAs } from './helpers-partner-app';
import { seedEsignConsentForTest } from './helpers-esign';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import type { Db } from '@/db/client';

// Fix pack 6 truth check TC-T1: recordEsignWithdrawalAction — partner staff record a customer's
// withdrawal of the E-SIGN consent (the provider route of the consent text). The M3-1 harness of
// tests/partner-customer-limit-action.test.ts: real auth store on a fake Redis, real customer
// store and ledger on PGlite.
const redis = fakeRedis();
const cookieJar = new Map<string, string>();
let db: Db;
let pgPartnerStore: PartnerStore;
let host = 'smartremit.ai';
const revalidated: string[] = [];
const reads = { customer: 0 };

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
  return {
    ...actual,
    getCustomerStore: (store: Parameters<typeof actual.createCustomerStore>[1]) => {
      const cs = actual.createCustomerStore(db, store);
      const get = cs.getCustomer.bind(cs);
      cs.getCustomer = (async (...a: Parameters<typeof get>) => {
        reads.customer++;
        return get(...a);
      }) as typeof cs.getCustomer;
      return cs;
    },
  };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => pgPartnerStore };
});

import { recordEsignWithdrawalAction } from '@/app/partner/(app)/customers/[ref]/esign-actions';
import { auditSubjectId, sealCustomerRef } from '@/lib/customer-ref';
import { PARTNER_OPS } from '@/lib/partner-access';
import { PARTNER_ROUTES } from '@/app/partner/routes';
import { ESIGN_CONSENT_VERSION } from '@/lib/legal/esign-consent';
import { t } from '@/lib/i18n';

const SHARED = '15551230811'; // the SAME phone at both tenants: different customers
const NOT_FOUND = { ok: false, error: t('partner.customers.notFound') };

function form(ref: string, o: { confirm?: boolean } = {}): FormData {
  const fd = new FormData();
  fd.set('ref', ref);
  if (o.confirm !== false) fd.set('confirm', 'on');
  return fd;
}

type Row = { partner_id: string; phone: string; esign_withdrawn_at: string | null };
async function consentRows(): Promise<Row[]> {
  const r = await db.execute(sql`SELECT partner_id, phone, esign_withdrawn_at::text FROM customers ORDER BY partner_id, phone`);
  return (r as unknown as { rows: Row[] }).rows;
}
async function esignAudits() {
  const r = await db.execute(sql`SELECT partner_id, actor, actor_type, subject_id, meta FROM audit_events WHERE action = 'customer.consent.esign' ORDER BY id`);
  return (r as unknown as { rows: Array<{ partner_id: string; actor: string; actor_type: string; subject_id: string; meta: Record<string, unknown> }> }).rows;
}
const snap = async () => ({ rows: await consentRows(), audit: await esignAudits() });

const REF_A = () => sealCustomerRef('pa', SHARED);
const REF_B = () => sealCustomerRef('pb', SHARED);
const asAgent = () => signInAs(redis, cookieJar, { username: 'pa-agent', partnerId: 'pa', role: 'agent' });

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  revalidated.length = 0;
  reads.customer = 0;
  host = 'smartremit.ai';
  db = await freshDb();
  pgPartnerStore = createPartnerStore(db);
  await seedTwoTenants(db);
  await seedEsignConsentForTest(db, 'pa', SHARED);
  await seedEsignConsentForTest(db, 'pb', SHARED);
});

describe('recordEsignWithdrawalAction: the shared action contract', () => {
  it('runs checklist items 1-4 (gate, role, foreign ref, forged tenant fields)', async () => {
    await expectPartnerActionContract({
      db,
      redis,
      cookieJar,
      action: recordEsignWithdrawalAction,
      form: (ref) => form(ref),
      ownId: REF_A(),
      foreignId: REF_B(),
      allowedRole: 'agent',
      disallowedRole: 'support',
      snapshot: snap,
    });
    // B's same-phone customer is untouched.
    const rows = await consentRows();
    expect(rows.find((r) => r.partner_id === 'pb')?.esign_withdrawn_at).toBeNull();
  });
  it('the policy is PARTNER_OPS, and every role it admits can open the customers page', () => {
    for (const r of PARTNER_OPS.roles) expect(PARTNER_ROUTES.customers.policy.roles).toContain(r);
  });
  it('a partner-site host is refused before the gate and before any read', async () => {
    await asAgent();
    host = 'acme.smartremit.ai';
    const before = await snap();
    await expect(recordEsignWithdrawalAction(form(REF_A()))).rejects.toThrow('NOT_FOUND');
    expect(reads.customer).toBe(0);
    expect(await snap()).toEqual(before);
  });
  it('support and finance are refused before any read; nothing written', async () => {
    const before = await snap();
    await signInAs(redis, cookieJar, { username: 'pa-support', partnerId: 'pa', role: 'support' });
    await expect(recordEsignWithdrawalAction(form(REF_A()))).rejects.toThrow(/^REDIRECT:\/partner$/);
    await signInAs(redis, cookieJar, { username: 'pa-fin', partnerId: 'pa', role: 'finance' });
    await expect(recordEsignWithdrawalAction(form(REF_A()))).rejects.toThrow(/^REDIRECT:\/(partner|login)$/);
    expect(reads.customer).toBe(0);
    expect(await snap()).toEqual(before);
  });
  it('missing, foreign, junk and raw-phone refs all return the SAME not-found result', async () => {
    await asAgent();
    const before = await snap();
    for (const ref of [REF_B(), sealCustomerRef('pb', '15559990000'), sealCustomerRef('pa', '15559990000'), SHARED, 'junk', '']) {
      expect(await recordEsignWithdrawalAction(form(ref)), ref).toEqual(NOT_FOUND);
    }
    expect(await snap()).toEqual(before);
  });
});

describe('recordEsignWithdrawalAction: confirmation and the write', () => {
  it('a missing confirmation writes nothing', async () => {
    await asAgent();
    const before = await snap();
    expect(await recordEsignWithdrawalAction(form(REF_A(), { confirm: false }))).toEqual({
      ok: false,
      error: t('partner.customers.esign.confirmRequired'),
    });
    expect(await snap()).toEqual(before);
  });
  it('the happy path writes one withdrawal and one audit row (actorScope partner), and revalidates the page', async () => {
    await asAgent();
    const ref = REF_A(); // a sealed ref is randomised: seal once
    expect(await recordEsignWithdrawalAction(form(ref))).toEqual({ ok: true });
    const rows = await consentRows();
    expect(rows.find((r) => r.partner_id === 'pa')?.esign_withdrawn_at).not.toBeNull();
    expect(rows.find((r) => r.partner_id === 'pb')?.esign_withdrawn_at).toBeNull();
    expect(await esignAudits()).toEqual([
      {
        partner_id: 'pa',
        actor: 'pa-agent',
        actor_type: 'staff',
        subject_id: auditSubjectId('pa', SHARED),
        meta: { version: ESIGN_CONSENT_VERSION, on: false, via: 'staff', actorScope: 'partner' },
      },
    ]);
    expect(revalidated).toEqual([`/partner/customers/${ref}`]);
    // A second call writes nothing more.
    expect(await recordEsignWithdrawalAction(form(REF_A()))).toEqual({ ok: true });
    expect(await esignAudits()).toHaveLength(1);
  });
});
