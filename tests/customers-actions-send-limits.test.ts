import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import type { Staff, Customer } from '@/lib/types';

// Program fix 16b (Task 10b, tests 2, 4, 5, 6): setCustomerSendLimitAction —
// platform-admin only, validated at the edge, one audit_events row per change
// in the SAME transaction as the write, tenant-scoped on (partnerId, phone).

const redis = fakeRedis();
let currentStaff: Staff;
let db: Awaited<ReturnType<typeof freshDb>>;
let store: ReturnType<typeof createStore>;
let cs: ReturnType<typeof createCustomerStore>;
let failAudit = false;

/** Next's redirect() THROWS; the gate must never fall through to the write. */
class RedirectError extends Error {
  constructor(readonly to: string) { super(`NEXT_REDIRECT:${to}`); }
}

vi.mock('@/lib/auth', () => ({
  requireAdmin: async () => currentStaff,
  requireScope: async () => ({ staff: currentStaff }),
  requireStaff: async () => currentStaff,
  // The REAL rule (src/lib/auth.ts requirePlatformAdmin): role admin AND no partnerId, else redirect.
  requirePlatformAdmin: async () => {
    if (currentStaff.role !== 'admin' || currentStaff.partnerId !== undefined) throw new RedirectError('/admin-dashboard');
    return currentStaff;
  },
}));
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => db };
});
vi.mock('@/lib/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/store')>('@/lib/store');
  return { ...actual, getStore: () => store };
});
vi.mock('@/lib/customer-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/customer-store')>('@/lib/customer-store');
  return { ...actual, getCustomerStore: () => cs };
});
// The audit repo is the real one, with a switch to force its insert to fail
// (test 5: a failed audit insert must roll the limit write back).
vi.mock('@/db/repos/aux-repos', async (orig) => {
  const real = await orig<typeof import('@/db/repos/aux-repos')>();
  return {
    ...real,
    createAuditRepo: (dbx: Parameters<typeof real.createAuditRepo>[0]) => {
      const r = real.createAuditRepo(dbx);
      return {
        ...r,
        record: async (e: Parameters<typeof r.record>[0]) => {
          if (failAudit) throw new Error('audit insert failed');
          return r.record(e);
        },
      };
    },
  };
});
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));

import { setCustomerSendLimitAction } from '@/app/admin-dashboard/customers/actions';

function staff(overrides: Partial<Staff>): Staff {
  return {
    username: 'u', name: 'U', role: 'admin',
    permissions: { canCancel: true, canResend: true, canAssign: true },
    passwordHash: 'x', createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeCustomer(phone: string, partnerId: string): Customer {
  const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
  return {
    senderPhone: phone, firstSeenAt: tenDaysAgo, kycStatus: 'verified', senderCountry: 'US', partnerId,
    createdAt: tenDaysAgo, updatedAt: tenDaysAgo,
  };
}

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

const PHONE = '15551234567';
const RAISE = { partnerId: 'A', phone: PHONE, perTransferUsd: '5000', t1DailyUsd: '5000', reason: 'QA large-amount test' };

async function auditRows() {
  const r = await db.execute(sql`SELECT partner_id, actor, actor_type, action, subject_id, meta FROM audit_events ORDER BY id`);
  return r.rows as Array<{ partner_id: string; actor: string; actor_type: string; action: string; subject_id: string; meta: Record<string, unknown> }>;
}

beforeEach(async () => {
  redis.dump.clear();
  failAudit = false;
  db = await freshDb();
  await seedPartner(db, 'A');
  await seedPartner(db, 'B');
  store = createStore(redis, db);
  cs = createCustomerStore(db, store);
  await cs.saveCustomer(makeCustomer(PHONE, 'A'));
  currentStaff = staff({ username: 'root' }); // platform admin
});

describe('setCustomerSendLimitAction — gate (test 4)', () => {
  it('a partner-scoped admin is redirected by requirePlatformAdmin: no write, no audit row', async () => {
    currentStaff = staff({ username: 'padmin', partnerId: 'A' });
    await expect(setCustomerSendLimitAction(form(RAISE))).rejects.toThrow('NEXT_REDIRECT:/admin-dashboard');
    expect((await cs.getCustomer('A', PHONE))!.sendLimitOverride).toBeUndefined();
    expect(await auditRows()).toEqual([]);
  });

  it('a support user and an agent are redirected too', async () => {
    for (const role of ['support', 'agent'] as const) {
      currentStaff = staff({ username: role, role });
      await expect(setCustomerSendLimitAction(form(RAISE))).rejects.toThrow('NEXT_REDIRECT:/admin-dashboard');
    }
    expect((await cs.getCustomer('A', PHONE))!.sendLimitOverride).toBeUndefined();
    expect(await auditRows()).toEqual([]);
  });
});

describe('setCustomerSendLimitAction — edge validation (test 2)', () => {
  it('refuses $10,001 with no write and no audit row', async () => {
    await expect(setCustomerSendLimitAction(form({ ...RAISE, perTransferUsd: '10001' }))).rejects.toThrow(/between \$1 and \$10,000/);
    await expect(setCustomerSendLimitAction(form({ ...RAISE, t1DailyUsd: '10001' }))).rejects.toThrow(/between \$1 and \$10,000/);
    expect((await cs.getCustomer('A', PHONE))!.sendLimitOverride).toBeUndefined();
    expect(await auditRows()).toEqual([]);
  });

  it('refuses an expiry in the past with nothing written', async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await expect(setCustomerSendLimitAction(form({ ...RAISE, expiresAt: yesterday }))).rejects.toThrow('Expiry must be in the future.');
    expect((await cs.getCustomer('A', PHONE))!.sendLimitOverride).toBeUndefined();
    expect(await auditRows()).toEqual([]);
  });

  it('a missing reason throws BEFORE any read or write (test 5)', async () => {
    await expect(setCustomerSendLimitAction(form({ ...RAISE, reason: '' }))).rejects.toThrow('A reason is required.');
    await expect(setCustomerSendLimitAction(form({ ...RAISE, reason: '  ', phone: '' }))).rejects.toThrow('A reason is required.');
    expect((await cs.getCustomer('A', PHONE))!.sendLimitOverride).toBeUndefined();
    expect(await auditRows()).toEqual([]);
  });

  it('platform staff MUST name the tenant and the phone', async () => {
    await expect(setCustomerSendLimitAction(form({ ...RAISE, partnerId: '' }))).rejects.toThrow('Partner is required.');
    await expect(setCustomerSendLimitAction(form({ ...RAISE, phone: '' }))).rejects.toThrow('Phone is required.');
    expect(await auditRows()).toEqual([]);
  });
});

describe('setCustomerSendLimitAction — audit (test 5)', () => {
  it('one set writes the column AND exactly one send_limits.set row: actor, old, new, reason, expiresAt', async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await setCustomerSendLimitAction(form({ ...RAISE, expiresAt: tomorrow }));
    const expectedExpiry = `${tomorrow}T23:59:59.999Z`;
    expect((await cs.getCustomer('A', PHONE))!.sendLimitOverride).toEqual({
      perTransferCapCents: 500_000, t1DailyCapCents: 500_000, expiresAt: expectedExpiry, setBy: 'root', setAt: expect.any(String),
    });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      partner_id: 'A', actor: 'root', actor_type: 'staff', action: 'send_limits.set', subject_id: PHONE,
      meta: {
        scope: 'customer', old: null, reason: 'QA large-amount test', expiresAt: expectedExpiry,
        new: { perTransferCapCents: 500_000, t1DailyCapCents: 500_000, expiresAt: expectedExpiry, setBy: 'root' },
      },
    });
  });

  it('a second set records the previous value as old; a clear writes send_limits.clear with new: null and still needs a reason', async () => {
    await setCustomerSendLimitAction(form(RAISE));
    await setCustomerSendLimitAction(form({ ...RAISE, perTransferUsd: '7000', t1DailyUsd: '', reason: 'bump' }));
    let rows = await auditRows();
    expect(rows).toHaveLength(2);
    expect(rows[1].meta).toMatchObject({
      old: { perTransferCapCents: 500_000, t1DailyCapCents: 500_000 },
      new: { perTransferCapCents: 700_000 },
      reason: 'bump',
    });
    expect((await cs.getCustomer('A', PHONE))!.sendLimitOverride).toMatchObject({ perTransferCapCents: 700_000 });
    expect((await cs.getCustomer('A', PHONE))!.sendLimitOverride!.t1DailyCapCents).toBeUndefined();

    await expect(setCustomerSendLimitAction(form({ partnerId: 'A', phone: PHONE, clear: 'on', reason: '' }))).rejects.toThrow('A reason is required.');
    await setCustomerSendLimitAction(form({ partnerId: 'A', phone: PHONE, clear: 'on', perTransferUsd: '10001', reason: 'lapse' }));
    expect((await cs.getCustomer('A', PHONE))!.sendLimitOverride).toBeUndefined();
    rows = await auditRows();
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ action: 'send_limits.clear', actor: 'root', subject_id: PHONE });
    expect(rows[2].meta).toMatchObject({ scope: 'customer', old: { perTransferCapCents: 700_000 }, new: null, reason: 'lapse' });
  });

  it('a forced audit-insert failure rolls the limit write back (same transaction)', async () => {
    failAudit = true;
    await expect(setCustomerSendLimitAction(form(RAISE))).rejects.toThrow('audit insert failed');
    expect((await cs.getCustomer('A', PHONE))!.sendLimitOverride).toBeUndefined();
    expect(await auditRows()).toEqual([]);
  });

  it('the reason is bounded (control characters stripped) before it reaches audit_events', async () => {
    await setCustomerSendLimitAction(form({ ...RAISE, reason: 'ok\u0000\r\n  reason\t here' }));
    expect((await auditRows())[0].meta.reason).toBe('ok reason here');
  });
});

describe('setCustomerSendLimitAction — tenant scope (test 6)', () => {
  it('posting partnerId=B for a phone with no B row throws "Customer not found." and writes nothing anywhere', async () => {
    await expect(setCustomerSendLimitAction(form({ ...RAISE, partnerId: 'B' }))).rejects.toThrow('Customer not found.');
    expect((await cs.getCustomer('A', PHONE))!.sendLimitOverride).toBeUndefined();
    expect(await cs.getCustomer('B', PHONE)).toBeNull();
    expect(await auditRows()).toEqual([]);
  });

  it('a raise for (A, phone) never touches the same phone under B', async () => {
    await cs.saveCustomer(makeCustomer(PHONE, 'B'));
    await setCustomerSendLimitAction(form(RAISE));
    expect((await cs.getCustomer('A', PHONE))!.sendLimitOverride).toMatchObject({ perTransferCapCents: 500_000 });
    expect((await cs.getCustomer('B', PHONE))!.sendLimitOverride).toBeUndefined();
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].partner_id).toBe('A');
  });
});
