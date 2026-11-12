import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { seedEsignConsentForTest } from './helpers-esign';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// Fix pack 6 truth check TC-T1: recordEsignWithdrawalAdminAction — SmartRemit staff record a
// customer's withdrawal of the E-SIGN consent. The tenant pin and keyed read of
// manualKycDecisionAction (tests/customers-actions-scope.test.ts harness), with a requireAdmin
// mock that keeps the real rule (role 'admin' only) and counts calls.

const redis = fakeRedis();
let db: Db;
let currentStaff: Staff;
let host = 'smartremit.ai';
const calls: string[] = [];

vi.mock('@/lib/auth', () => ({
  requireAdmin: async () => {
    calls.push('requireAdmin');
    if (currentStaff.role !== 'admin') throw new Error('REDIRECT:/admin-dashboard');
    return currentStaff;
  },
}));
vi.mock('next/headers', async (orig) => ({
  ...(await orig<typeof import('next/headers')>()),
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
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/store')>('@/lib/store');
  return { ...actual, getStore: () => actual.createStore(redis, db) };
});
vi.mock('@/lib/customer-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/customer-store')>('@/lib/customer-store');
  return {
    ...actual,
    getCustomerStore: () => {
      const cs = actual.createCustomerStore(db, createStore(redis, db));
      const get = cs.getCustomer.bind(cs);
      cs.getCustomer = (async (...a: Parameters<typeof get>) => {
        calls.push('getCustomer');
        return get(...a);
      }) as typeof cs.getCustomer;
      return cs;
    },
  };
});

import { recordEsignWithdrawalAdminAction } from '@/app/admin-dashboard/customers/esign-actions';
import { auditSubjectId } from '@/lib/customer-ref';
import { ESIGN_CONSENT_VERSION } from '@/lib/legal/esign-consent';

const PHONE = '15551230911';

function staff(o: Partial<Staff>): Staff {
  return {
    username: 'ops-admin',
    name: 'Ops',
    role: 'admin',
    permissions: { canCancel: true, canResend: true, canAssign: true },
    passwordHash: 'x',
    createdAt: new Date().toISOString(),
    ...o,
  };
}
function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}
const ok = (partnerId: string) => form({ phone: PHONE, partnerId, confirm: 'on' });

type Row = { partner_id: string; esign_withdrawn_at: string | null };
async function rows(): Promise<Row[]> {
  const r = await db.execute(sql`SELECT partner_id, esign_withdrawn_at::text FROM customers ORDER BY partner_id`);
  return (r as unknown as { rows: Row[] }).rows;
}
async function audits() {
  const r = await db.execute(sql`SELECT partner_id, actor, actor_type, subject_id, meta FROM audit_events WHERE action = 'customer.consent.esign' ORDER BY id`);
  return (r as unknown as { rows: Array<Record<string, unknown>> }).rows;
}
const snap = async () => ({ rows: await rows(), audit: await audits() });

beforeEach(async () => {
  redis.dump.clear();
  calls.length = 0;
  host = 'smartremit.ai';
  db = await freshDb();
  await seedPartner(db, 'A');
  await seedPartner(db, 'B');
  await seedEsignConsentForTest(db, 'A', PHONE);
  await seedEsignConsentForTest(db, 'B', PHONE);
  currentStaff = staff({});
});

describe('recordEsignWithdrawalAdminAction (TC-T1)', () => {
  it('a partner-site host is refused before the gate and before any read', async () => {
    host = 'acme.smartremit.ai';
    const before = await snap();
    await expect(recordEsignWithdrawalAdminAction(ok('A'))).rejects.toThrow('NOT_FOUND');
    expect(calls).toEqual([]);
    expect(await snap()).toEqual(before);
  });
  it('a non-admin (agent, support) is refused by the gate before any read', async () => {
    const before = await snap();
    for (const role of ['agent', 'support'] as const) {
      calls.length = 0;
      currentStaff = staff({ role });
      await expect(recordEsignWithdrawalAdminAction(ok('A'))).rejects.toThrow('REDIRECT:/admin-dashboard');
      expect(calls).toEqual(['requireAdmin']);
    }
    expect(await snap()).toEqual(before);
  });
  it('a partner-scoped admin cannot touch another tenant: pinned to its own (the posted partnerId is ignored)', async () => {
    currentStaff = staff({ username: 'a-admin', partnerId: 'A' });
    await recordEsignWithdrawalAdminAction(ok('B'));
    const r = await rows();
    expect(r.find((x) => x.partner_id === 'A')?.esign_withdrawn_at).not.toBeNull();
    expect(r.find((x) => x.partner_id === 'B')?.esign_withdrawn_at).toBeNull();
    const a = await audits();
    expect(a).toHaveLength(1);
    expect(a[0].partner_id).toBe('A');
    expect((a[0].meta as Record<string, unknown>).actorScope).toBe('partner');
  });
  it('an unknown customer, or a platform admin with no partner named: not found / refused, nothing written', async () => {
    const before = await snap();
    await expect(recordEsignWithdrawalAdminAction(form({ phone: '15559990000', partnerId: 'A', confirm: 'on' }))).rejects.toThrow('Customer not found.');
    await expect(recordEsignWithdrawalAdminAction(form({ phone: PHONE, confirm: 'on' }))).rejects.toThrow('Partner is required.');
    await expect(recordEsignWithdrawalAdminAction(form({ partnerId: 'A', confirm: 'on' }))).rejects.toThrow('Customer not found.');
    expect(await snap()).toEqual(before);
  });
  it('a missing confirmation writes nothing', async () => {
    const before = await snap();
    await expect(recordEsignWithdrawalAdminAction(form({ phone: PHONE, partnerId: 'A' }))).rejects.toThrow(
      'Confirm that the customer asked to withdraw this consent.',
    );
    expect(await snap()).toEqual(before);
  });
  it('the happy path writes one withdrawal and one audit row (actorScope platform); a second call writes nothing', async () => {
    await recordEsignWithdrawalAdminAction(ok('A'));
    const r = await rows();
    expect(r.find((x) => x.partner_id === 'A')?.esign_withdrawn_at).not.toBeNull();
    expect(r.find((x) => x.partner_id === 'B')?.esign_withdrawn_at).toBeNull();
    expect(await audits()).toEqual([
      {
        partner_id: 'A',
        actor: 'ops-admin',
        actor_type: 'staff',
        subject_id: auditSubjectId('A', PHONE),
        meta: { version: ESIGN_CONSENT_VERSION, on: false, via: 'staff', actorScope: 'platform' },
      },
    ]);
    await recordEsignWithdrawalAdminAction(ok('A'));
    expect(await audits()).toHaveLength(1);
  });
});
