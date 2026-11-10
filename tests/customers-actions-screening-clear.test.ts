import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { primeOfacSource, restoreOfacSource, setRailProviderType } from './helpers-sanctions';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createTransfer } from '@/lib/transfer-create';
import { auditSubjectId } from '@/lib/customer-ref';
import { senderScreeningHoldActive, SENDER_SCREENING_REASON } from '@/lib/compliance-config';
import { readSenderScreeningFlags, createCustomerRepo } from '@/db/repos/customer-repo';
import { resetRateCacheForTests } from '@/lib/rate';
import type { Staff, Customer } from '@/lib/types';

// Fix pack 2 T6 (R06): clearSenderScreeningHoldAction — platform-admin only,
// a typed reason, one customer.screening_hold.clear audit row in the SAME
// transaction as the clear, tenant-scoped on (partnerId, phone), never the
// raw phone in the audit row. Any kycStatus, either kycMode. It does not
// release held transfers.

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
vi.mock('next/headers', async (orig) => ({
  ...(await orig<typeof import('next/headers')>()),
  headers: async () => new Headers({ host: 'smartremit.ai' }),
}));

import { clearSenderScreeningHoldAction } from '@/app/admin-dashboard/customers/actions';

function staff(overrides: Partial<Staff>): Staff {
  return {
    username: 'u', name: 'U', role: 'admin',
    permissions: { canCancel: true, canResend: true, canAssign: true },
    passwordHash: 'x', createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeCustomer(phone: string, partnerId: string, over: Partial<Customer> = {}): Customer {
  const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
  return {
    senderPhone: phone, firstSeenAt: tenDaysAgo, kycStatus: 'verified', senderCountry: 'US', partnerId,
    createdAt: tenDaysAgo, updatedAt: tenDaysAgo, ...over,
  };
}

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

const PHONE = '15551234567';
const H = 3_600_000;
const CLEAR = { partnerId: 'A', phone: PHONE, reason: 'Persona match reviewed: a different person' };
const ORIGINAL_LIST = process.env.SANCTIONS_LIST;

async function auditRows() {
  const r = await db.execute(sql`SELECT partner_id, actor, actor_type, action, subject_id, meta FROM audit_events ORDER BY id`);
  return r.rows as Array<{ partner_id: string; actor: string; actor_type: string; action: string; subject_id: string; meta: Record<string, unknown> }>;
}

async function flag(partnerId: string, flaggedAgoMs = H) {
  await db.execute(sql`UPDATE customers SET watchlist_hit = true, screening_flagged_at = ${new Date(Date.now() - flaggedAgoMs)} WHERE partner_id = ${partnerId} AND phone = ${PHONE}`);
}

const held = async (partnerId = 'A') => senderScreeningHoldActive(await readSenderScreeningFlags(db, partnerId, PHONE));

/** Pack 2 review R3 (H1 a): the page posts the flag time it showed (ISO, or ''). */
async function shown(partnerId = 'A'): Promise<string> {
  return (await cs.getCustomer(partnerId, PHONE))?.screeningFlaggedAt ?? '';
}
/** The clear form as the page renders it right now (the reviewed flag time included). */
async function reviewed(over: Record<string, string> = {}): Promise<FormData> {
  return form({ ...CLEAR, screeningFlaggedAt: await shown(over.partnerId ?? 'A'), ...over });
}

beforeEach(async () => {
  redis.dump.clear();
  failAudit = false;
  delete process.env.SANCTIONS_LIST;
  resetRateCacheForTests();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85 } }) }));
  db = await freshDb();
  await seedPartner(db, 'A');
  await seedPartner(db, 'B');
  store = createStore(redis, db);
  cs = createCustomerStore(db, store);
  await cs.saveCustomer(makeCustomer(PHONE, 'A'));
  await flag('A');
  currentStaff = staff({ username: 'root' }); // platform admin
});
afterEach(() => {
  restoreOfacSource(ORIGINAL_LIST);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('clearSenderScreeningHoldAction — gate', () => {
  it('non-platform staff redirected', async () => {
    for (const s of [staff({ username: 'padmin', partnerId: 'A' }), staff({ username: 'sup', role: 'support' }), staff({ username: 'ag', role: 'agent' })]) {
      currentStaff = s;
      await expect(clearSenderScreeningHoldAction(form(CLEAR))).rejects.toThrow('NEXT_REDIRECT:/admin-dashboard');
    }
    expect(await held()).toBe(true);
    expect(await auditRows()).toEqual([]);
  });

  it('no reason refused before any read', async () => {
    const spy = vi.spyOn(cs, 'getCustomer');
    await expect(clearSenderScreeningHoldAction(form({ ...CLEAR, reason: '' }))).rejects.toThrow('A reason is required.');
    await expect(clearSenderScreeningHoldAction(form({ ...CLEAR, reason: 'short' }))).rejects.toThrow(/at least 10 characters/);
    expect(spy).not.toHaveBeenCalled();
    expect(await held()).toBe(true);
    expect(await auditRows()).toEqual([]);
  });

  it('platform staff MUST name the tenant and the phone', async () => {
    await expect(clearSenderScreeningHoldAction(form({ ...CLEAR, partnerId: '' }))).rejects.toThrow('Partner is required.');
    await expect(clearSenderScreeningHoldAction(form({ ...CLEAR, phone: '' }))).rejects.toThrow('Phone is required.');
    await expect(clearSenderScreeningHoldAction(form({ ...CLEAR, partnerId: 'B' }))).rejects.toThrow('Customer not found.');
    expect(await held()).toBe(true);
    expect(await auditRows()).toEqual([]);
  });
});

describe('clearSenderScreeningHoldAction — the clear', () => {
  it('verified customer cleared + audit without the raw phone', async () => {
    await clearSenderScreeningHoldAction(await reviewed());
    expect(await held()).toBe(false);
    const c = await cs.getCustomer('A', PHONE);
    expect(c?.kycStatus).toBe('verified'); // nothing else moved
    expect(c?.watchlistHit).toBe(true); // the flag stays as evidence; the clear time lifts the hold
    expect(c?.screeningClearedAt).toBeDefined();
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      partner_id: 'A', actor: 'root', actor_type: 'staff', action: 'customer.screening_hold.clear',
      subject_id: auditSubjectId('A', PHONE),
      meta: {
        reason: CLEAR.reason,
        flaggedAt: c?.screeningFlaggedAt,
        previousClearedAt: null,
        pepHit: null,
        watchlistHit: true,
        kycStatus: 'verified',
      },
    });
    expect(JSON.stringify(rows[0])).not.toContain(PHONE);
    // Another tenant's row for the same phone is untouched.
    await cs.saveCustomer(makeCustomer(PHONE, 'B'));
    await flag('B');
    expect(await held('B')).toBe(true);
  });

  it.each(['pending', 'rejected'] as const)('a %s customer is cleared too (any kycStatus)', async (kycStatus) => {
    await cs.saveCustomer({ ...(await cs.getCustomer('A', PHONE))!, kycStatus });
    await clearSenderScreeningHoldAction(await reviewed());
    expect(await held()).toBe(false);
    expect((await auditRows())[0].meta.kycStatus).toBe(kycStatus);
  });

  it('no active hold -> refused', async () => {
    await clearSenderScreeningHoldAction(await reviewed());
    await expect(clearSenderScreeningHoldAction(await reviewed())).rejects.toThrow('This customer has no active screening hold.');
    await db.execute(sql`UPDATE customers SET watchlist_hit = NULL, screening_flagged_at = NULL, screening_cleared_at = NULL WHERE partner_id = 'A'`);
    await expect(clearSenderScreeningHoldAction(await reviewed())).rejects.toThrow('This customer has no active screening hold.');
    expect(await auditRows()).toHaveLength(1);
  });

  it('the clear time is taken after the locked read, so it lifts the flag on file at that moment', async () => {
    await flag('A', 1); // a match stamped a moment before the clear
    await clearSenderScreeningHoldAction(await reviewed());
    expect(await held()).toBe(false);
  });

  // Pack 2 review R3 (H1 a): the clear lifts only the match the admin saw.
  it('a newer match than the one shown is refused: nothing written, no audit', async () => {
    const stale = await reviewed(); // the page as the admin opened it
    await flag('A', 60_000); // a newer Persona match stamped since
    const before = await readSenderScreeningFlags(db, 'A', PHONE);
    await expect(clearSenderScreeningHoldAction(stale)).rejects.toThrow(
      'The screening for this customer changed since this page loaded. Reload the page and review it again.',
    );
    expect(await readSenderScreeningFlags(db, 'A', PHONE)).toEqual(before);
    expect(await held()).toBe(true);
    expect(await auditRows()).toEqual([]);
  });

  // Pack 2 review round 3 (L1): every committed stamp strictly raises the flag,
  // so two matches never share a flag time, even after a clear floored to a
  // flag from a clock that ran ahead.
  it('a second match after a floored clear gets a later flag time, so a clear of the first is refused', async () => {
    const repo = createCustomerRepo(db, async () => null);
    const T = Date.now();
    await repo.stampScreeningFlagged('A', PHONE, new Date(T + 10_000)); // match 1, a clock 10 s ahead
    await repo.clearScreeningHold('A', PHONE, new Date(T + 1_000)); // floored to flag1 + 1 ms
    await repo.stampScreeningFlagged('A', PHONE, new Date(T + 2_000)); // match 2
    const f2 = (await readSenderScreeningFlags(db, 'A', PHONE))!.screeningFlaggedAt!;
    const stale = await reviewed(); // the admin opens the page on match 2
    expect(stale.get('screeningFlaggedAt')).toBe(f2.toISOString());
    await repo.stampScreeningFlagged('A', PHONE, new Date(T + 3_000)); // match 3, unreviewed
    const before = await readSenderScreeningFlags(db, 'A', PHONE);
    expect(before!.screeningFlaggedAt!.getTime()).toBeGreaterThan(f2.getTime());
    await expect(clearSenderScreeningHoldAction(stale)).rejects.toThrow(
      'The screening for this customer changed since this page loaded. Reload the page and review it again.',
    );
    expect(await readSenderScreeningFlags(db, 'A', PHONE)).toEqual(before);
    expect(await held()).toBe(true);
    expect(await auditRows()).toEqual([]);
  });

  it('a stamp never moves the flag back', async () => {
    const repo = createCustomerRepo(db, async () => null);
    const first = (await readSenderScreeningFlags(db, 'A', PHONE))!.screeningFlaggedAt!;
    await repo.stampScreeningFlagged('A', PHONE, new Date(first.getTime() - H)); // a clock running behind
    const after = (await readSenderScreeningFlags(db, 'A', PHONE))!.screeningFlaggedAt!;
    expect(after.getTime()).toBe(first.getTime() + 1);
    expect(await held()).toBe(true);
  });

  it('a form without the reviewed flag time, or with a different one, is refused', async () => {
    const msg = 'The screening for this customer changed since this page loaded. Reload the page and review it again.';
    await expect(clearSenderScreeningHoldAction(form(CLEAR))).rejects.toThrow(msg); // an older page's form
    await expect(clearSenderScreeningHoldAction(form({ ...CLEAR, screeningFlaggedAt: '' }))).rejects.toThrow(msg);
    await expect(clearSenderScreeningHoldAction(form({ ...CLEAR, screeningFlaggedAt: 'not a time' }))).rejects.toThrow(msg);
    expect(await held()).toBe(true);
    expect(await auditRows()).toEqual([]);
  });

  it('a hold with no flag time (booleans only) clears with the empty value the page posts', async () => {
    await db.execute(sql`UPDATE customers SET screening_flagged_at = NULL WHERE partner_id = 'A'`);
    expect(await held()).toBe(true);
    await clearSenderScreeningHoldAction(form({ ...CLEAR, screeningFlaggedAt: '' }));
    expect(await auditRows()).toHaveLength(1);
  });

  it('failed audit rolls back', async () => {
    failAudit = true;
    await expect(clearSenderScreeningHoldAction(await reviewed())).rejects.toThrow('audit insert failed');
    expect(await held()).toBe(true);
    expect((await cs.getCustomer('A', PHONE))?.screeningClearedAt).toBeUndefined();
    expect(await auditRows()).toEqual([]);
  });

  it.each(['ours', 'delegated'] as const)("after the clear an http mint clears, kycMode '%s'", async (kycMode) => {
    await db.execute(sql`UPDATE partners SET kyc_mode = ${kycMode} WHERE id = 'A'`);
    await setRailProviderType(db, 'A', 'http');
    primeOfacSource({ checkedAgoMs: H });
    const mint = (amountSource: number) => createTransfer(store, createPartnerStore(db), createMonthlyVolumeStore(store), {
      partnerId: 'A', phone: PHONE, amountSource, sourceCurrency: 'USD', recipientName: 'Mom',
      recipientPhone: '919000000088', payoutMethod: 'upi', payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer', senderKycStatus: 'verified',
    });
    const before = await mint(50);
    expect(before.complianceReasons).toEqual([SENDER_SCREENING_REASON]);
    await clearSenderScreeningHoldAction(await reviewed());
    const after = await mint(60);
    expect(after.complianceStatus).toBe('cleared');
    expect(after.complianceReasons).toEqual([]);
    // The clear does not release the earlier held transfer.
    expect((await store.getTransfer(before.id))?.complianceStatus).toBe('flagged');
  });
});
