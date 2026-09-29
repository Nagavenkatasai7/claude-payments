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

// Legacy server actions refuse on a partner-site host (src/lib/site-host-guard.ts); this suite runs
// them as on the apex.
vi.mock('next/headers', async (orig) => ({
  ...(await orig<typeof import('next/headers')>()),
  headers: async () => new Headers({ host: 'smartremit.ai' }),
}));

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
      setScope: 'platform', // UI redesign M3-12: a SmartRemit raise is marked, so a partner can never overwrite it
    });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      partner_id: 'A', actor: 'root', actor_type: 'staff', action: 'send_limits.set', subject_id: PHONE,
      meta: {
        scope: 'customer', old: null, reason: 'QA large-amount test', expiresAt: expectedExpiry,
        new: { perTransferCapCents: 500_000, t1DailyCapCents: 500_000, expiresAt: expectedExpiry, setBy: 'root', setScope: 'platform' },
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

// UI redesign M3-12 follow-up: the admin card prefills the stored entry, so an admin who re-saves a
// PARTNER-set entry unchanged must not convert it into a SmartRemit override (setScope 'platform'),
// which would lock the partner out. The check runs against the row-locked previous value.
describe('setCustomerSendLimitAction — partner-set entries (M3-12 follow-up)', () => {
  const expDate = () => new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
  const partnerSet = () => ({
    perTransferCapCents: 50_000, t1DailyCapCents: 150_000, expiresAt: `${expDate()}T23:59:59.999Z`,
    setBy: 'pa-admin', setAt: new Date(Date.now() - 86_400_000).toISOString(), setScope: 'partner' as const,
  });
  /** Exactly what the card prefills for a stored entry (send-limits-card.tsx defaultValue + the hidden expectedSetAt). */
  let loadedSetAt = '';
  const prefilled = (reason: string) => ({
    partnerId: 'A', phone: PHONE, perTransferUsd: '500', t1DailyUsd: '1500', expiresAt: expDate(), reason, expectedSetAt: loadedSetAt,
  });
  const plant = async (v: Parameters<typeof cs.setSendLimitOverride>[2]) => {
    await cs.setSendLimitOverride('A', PHONE, v);
    loadedSetAt = v && v.setScope === 'partner' && v.setAt ? v.setAt : ''; // what the page rendered
  };

  it('an unchanged re-save (only a reason typed) leaves the partner entry untouched: no write, no audit row', async () => {
    const planted = partnerSet();
    await plant(planted);
    await setCustomerSendLimitAction(form(prefilled('Looked at it, no change')));
    expect((await cs.getCustomer('A', PHONE))!.sendLimitOverride).toEqual(planted);
    expect(await auditRows()).toEqual([]);
  });

  it('changing a value replaces it with a SmartRemit override and audits the partner entry as old', async () => {
    const planted = partnerSet();
    await plant(planted);
    await setCustomerSendLimitAction(form({ ...prefilled('Raise for a verified business'), perTransferUsd: '5000', t1DailyUsd: '5000' }));
    expect((await cs.getCustomer('A', PHONE))!.sendLimitOverride).toMatchObject({
      perTransferCapCents: 500_000, t1DailyCapCents: 500_000, setBy: 'root', setScope: 'platform',
    });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'send_limits.set', subject_id: PHONE, meta: { scope: 'customer', old: planted } });
  });

  it('changing only the expiry is a change', async () => {
    await plant(partnerSet());
    const later = new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10);
    await setCustomerSendLimitAction(form({ ...prefilled('Extend'), expiresAt: later }));
    expect((await cs.getCustomer('A', PHONE))!.sendLimitOverride).toMatchObject({ setScope: 'platform', expiresAt: `${later}T23:59:59.999Z` });
    expect(await auditRows()).toHaveLength(1);
  });

  it('Clear on a partner entry is still a real, audited clear (null, so the partner can set it again)', async () => {
    const planted = partnerSet();
    await plant(planted);
    await setCustomerSendLimitAction(form({ partnerId: 'A', phone: PHONE, clear: 'on', reason: 'Back to defaults', expectedSetAt: loadedSetAt }));
    expect((await cs.getCustomer('A', PHONE))!.sendLimitOverride).toBeUndefined();
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'send_limits.clear', meta: { old: planted, new: null } });
  });

  it('SmartRemit-set and legacy entries re-saved unchanged still write and audit exactly as before', async () => {
    for (const planted of [
      { perTransferCapCents: 500_000, t1DailyCapCents: 500_000, setBy: 'ops', setAt: '2026-09-01T00:00:00.000Z', setScope: 'platform' as const },
      { perTransferCapCents: 500_000, t1DailyCapCents: 500_000, setBy: 'ops', setAt: '2026-09-01T00:00:00.000Z' },
    ]) {
      await plant(planted);
      await setCustomerSendLimitAction(form(RAISE));
    }
    const rows = await auditRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.action === 'send_limits.set')).toBe(true);
    expect((await cs.getCustomer('A', PHONE))!.sendLimitOverride).toMatchObject({ setBy: 'root', setScope: 'platform' });
  });

  it('a forced audit failure on a real change still rolls back (the no-op sentinel is the only swallowed error)', async () => {
    const planted = partnerSet();
    await plant(planted);
    failAudit = true;
    await expect(setCustomerSendLimitAction(form({ ...prefilled('Raise'), perTransferUsd: '5000' }))).rejects.toThrow('audit insert failed');
    expect((await cs.getCustomer('A', PHONE))!.sendLimitOverride).toEqual(planted);
  });

  describe('stale form guard (the partner changed the entry after the admin opened the page)', () => {
    const STALE = /The partner changed this limit since you opened the page\. Reload and try again\./;
    const partnerEdit = async (perTransferCapCents: number) => {
      // The partner edits AFTER the admin's page rendered: loadedSetAt keeps the old setAt.
      const edited = { ...partnerSet(), perTransferCapCents, setAt: new Date().toISOString() };
      await cs.setSendLimitOverride('A', PHONE, edited);
      return edited;
    };

    it('an unchanged re-save of the stale form is refused: row unchanged, no audit', async () => {
      await plant(partnerSet());
      const edited = await partnerEdit(40_000);
      await expect(setCustomerSendLimitAction(form(prefilled('No change')))).rejects.toThrow(STALE);
      expect((await cs.getCustomer('A', PHONE))!.sendLimitOverride).toEqual(edited);
      expect(await auditRows()).toEqual([]);
    });

    it('a single-field change on the stale form is refused too', async () => {
      await plant(partnerSet());
      const edited = await partnerEdit(40_000);
      await expect(setCustomerSendLimitAction(form({ ...prefilled('Raise'), perTransferUsd: '5000' }))).rejects.toThrow(STALE);
      expect((await cs.getCustomer('A', PHONE))!.sendLimitOverride).toEqual(edited);
      expect(await auditRows()).toEqual([]);
    });

    it('Clear on the stale form is refused', async () => {
      await plant(partnerSet());
      const edited = await partnerEdit(40_000);
      await expect(
        setCustomerSendLimitAction(form({ partnerId: 'A', phone: PHONE, clear: 'on', reason: 'Back to defaults', expectedSetAt: loadedSetAt })),
      ).rejects.toThrow(STALE);
      expect((await cs.getCustomer('A', PHONE))!.sendLimitOverride).toEqual(edited);
      expect(await auditRows()).toEqual([]);
    });

    it('a page rendered with no partner entry (empty expectedSetAt) cannot overwrite one the partner set since', async () => {
      await plant(null);
      const edited = await partnerEdit(40_000);
      await expect(setCustomerSendLimitAction(form({ ...RAISE, expectedSetAt: loadedSetAt }))).rejects.toThrow(STALE);
      await expect(setCustomerSendLimitAction(form(RAISE))).rejects.toThrow(STALE); // field missing entirely
      expect((await cs.getCustomer('A', PHONE))!.sendLimitOverride).toEqual(edited);
      expect(await auditRows()).toEqual([]);
    });

    it('a fresh form (expectedSetAt matches) works: a change writes and audits', async () => {
      await plant(partnerSet());
      await setCustomerSendLimitAction(form({ ...prefilled('Raise'), perTransferUsd: '5000' }));
      expect((await cs.getCustomer('A', PHONE))!.sendLimitOverride).toMatchObject({ perTransferCapCents: 500_000, setScope: 'platform' });
      expect(await auditRows()).toHaveLength(1);
    });

    it('platform and legacy entries ignore expectedSetAt (a stale or missing value never blocks)', async () => {
      await cs.setSendLimitOverride('A', PHONE, { perTransferCapCents: 500_000, setBy: 'ops', setAt: '2026-09-01T00:00:00.000Z', setScope: 'platform' });
      await setCustomerSendLimitAction(form({ ...RAISE, expectedSetAt: 'something-else' }));
      await cs.setSendLimitOverride('A', PHONE, { perTransferCapCents: 500_000, setBy: 'ops' });
      await setCustomerSendLimitAction(form(RAISE));
      expect(await auditRows()).toHaveLength(2);
    });
  });
});
