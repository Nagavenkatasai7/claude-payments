import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createKycCaseStore } from '@/lib/kyc-case-store';
import { auditSubjectId } from '@/lib/customer-ref';
import type { Staff, Customer } from '@/lib/types';

/** H3: a partner-admin must not flip another tenant's customer KYC. */

const redis = fakeRedis();
let currentStaff: Staff;
// Customers/transfers live in Postgres now — stores are rebuilt per test in
// beforeEach (vi.mock factories are hoisted/sync; they close over these lets).
let db: Awaited<ReturnType<typeof freshDb>>;
let store: ReturnType<typeof createStore>;
let cs: ReturnType<typeof createCustomerStore>;
let kcs: ReturnType<typeof createKycCaseStore>;
const notify = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/lib/auth', () => ({
  requireAdmin: async () => currentStaff,
  // The REAL rule (src/lib/auth.ts requireScope): support is redirected away.
  requireScope: async () => {
    if (currentStaff.role === 'support') throw new Error('NEXT_REDIRECT /admin-dashboard/tickets');
    return { staff: currentStaff };
  },
  requireStaff: async () => currentStaff,
  requirePlatformAdmin: vi.fn(),
}));
vi.mock('@/lib/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/store')>('@/lib/store');
  return { ...actual, getStore: () => store };
});
vi.mock('@/lib/customer-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/customer-store')>('@/lib/customer-store');
  return { ...actual, getCustomerStore: () => cs };
});
vi.mock('@/lib/kyc-case-store', async (o) => ({ ...(await o() as object), getKycCaseStore: () => kcs }));
// Program-Fix 28: the durable manual decision runs its transaction on the freshDb() handle.
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
// The manual decision must NEVER message the customer (spy asserts it).
vi.mock('@/lib/whatsapp', () => ({ sendVerificationStatus: notify }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));

import { redirect } from 'next/navigation';
import * as customerActions from '@/app/admin-dashboard/customers/actions';
import {
  manualKycDecisionAction,
  reviewKycAction,
  createCustomerAction,
  openCustomerAction,
} from '@/app/admin-dashboard/customers/actions';
import { openCustomerRef } from '@/lib/customer-ref';

function staff(overrides: Partial<Staff>): Staff {
  return {
    username: 'u',
    name: 'U',
    role: 'admin',
    permissions: { canCancel: true, canResend: true, canAssign: true },
    passwordHash: 'x',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeCustomer(phone: string, partnerId: string): Customer {
  return {
    senderPhone: phone,
    firstSeenAt: '2026-01-01T00:00:00Z',
    kycStatus: 'not_started',
    senderCountry: 'US',
    partnerId,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

beforeEach(async () => {
  redis.dump.clear();
  db = await freshDb();
  // Customers carry a REAL FK to partners — seed the two tenants used below.
  await seedPartner(db, 'A');
  await seedPartner(db, 'B');
  store = createStore(redis, db);
  cs = createCustomerStore(db, store);
  kcs = createKycCaseStore(redis, cs);
  notify.mockClear();
});

async function auditRows(): Promise<Array<{ partner_id: string | null; actor: string; action: string; subject_id: string | null; meta: Record<string, unknown> }>> {
  const r = await db.execute(sql`SELECT partner_id, actor, action, subject_id, meta FROM audit_events ORDER BY id`);
  return (r as unknown as { rows: Array<{ partner_id: string | null; actor: string; action: string; subject_id: string | null; meta: Record<string, unknown> }> }).rows;
}

const REASON = 'demo: documents checked offline';

// Program-Fix 28 (compliance-04): the one-click override is GONE. The H3 /
// fix-1 scope pins moved onto manualKycDecisionAction (reasoned + audited).
describe('the one-click KYC override is removed (Program-Fix 28)', () => {
  it('markCustomerVerifiedAction / markCustomerRejectedAction no longer exist', () => {
    expect('markCustomerVerifiedAction' in customerActions).toBe(false);
    expect('markCustomerRejectedAction' in customerActions).toBe(false);
  });
});

describe('manualKycDecisionAction partner scope (H3 + fix 1, moved from markCustomer*)', () => {
  it('rejects a partner-admin deciding another partner’s customer', async () => {
    await cs.saveCustomer(makeCustomer('15551112222', 'A'));
    currentStaff = staff({ username: 'pb', partnerId: 'B' });
    await expect(manualKycDecisionAction(form({ phone: '15551112222', partnerId: 'A', decision: 'approve', reason: REASON }))).rejects.toThrow(
      /not found/i,
    );
    expect((await cs.getCustomer('A', '15551112222'))?.kycStatus).toBe('not_started'); // untouched
    expect(await auditRows()).toEqual([]);
  });

  it('lets a partner-admin verify their OWN customer', async () => {
    await cs.saveCustomer(makeCustomer('15553334444', 'B'));
    currentStaff = staff({ username: 'pb', partnerId: 'B' });
    await manualKycDecisionAction(form({ phone: '15553334444', partnerId: 'B', decision: 'approve', reason: REASON }));
    expect((await cs.getCustomer('B', '15553334444'))?.kycStatus).toBe('verified');
  });

  it('lets a platform admin verify any customer', async () => {
    await cs.saveCustomer(makeCustomer('15555556666', 'A'));
    currentStaff = staff({ username: 'plat' });
    await manualKycDecisionAction(form({ phone: '15555556666', partnerId: 'A', decision: 'approve', reason: REASON }));
    expect((await cs.getCustomer('A', '15555556666'))?.kycStatus).toBe('verified');
  });

  it('a partner-admin is PINNED to their tenant: a hostile partnerId field cannot reach another tenant\'s row', async () => {
    await seedPartner(db, 'acme'); await seedPartner(db, 'beta');
    await cs.saveCustomer(makeCustomer('15559990000', 'beta'));
    currentStaff = staff({ partnerId: 'acme' });
    await expect(manualKycDecisionAction(form({ phone: '15559990000', partnerId: 'beta', decision: 'approve', reason: REASON }))).rejects.toThrow(/not found/i);
    expect((await cs.getCustomer('beta', '15559990000'))!.kycStatus).toBe('not_started');
  });

  it('platform staff MUST name the tenant: a form without partnerId is refused and the row is untouched', async () => {
    await cs.saveCustomer(makeCustomer('15559991111', 'A'));
    currentStaff = staff({ username: 'plat' });
    await expect(manualKycDecisionAction(form({ phone: '15559991111', decision: 'approve', reason: REASON }))).rejects.toThrow('Partner is required.');
    expect((await cs.getCustomer('A', '15559991111'))!.kycStatus).toBe('not_started');
  });

  it('rejects a partner-admin rejecting another partner’s customer', async () => {
    await cs.saveCustomer(makeCustomer('15557778888', 'A'));
    currentStaff = staff({ username: 'pb', partnerId: 'B' });
    await expect(manualKycDecisionAction(form({ phone: '15557778888', partnerId: 'A', decision: 'reject', reason: REASON }))).rejects.toThrow(
      /not found/i,
    );
  });
});

// Program-Fix 43 follow-up: a customer held by a Persona WATCHLIST or PEP
// match is PLATFORM-only to decide. Partner-scoped admins are refused before
// any mutation (generic permission copy) on both KYC decision actions; a
// non-screening needs_review stays decidable by the partner as today.
describe('screening customer holds (watchlist / PEP) are platform-only', () => {
  const held = (phone: string, partnerId: string, over: Partial<Customer>): Customer => ({
    ...makeCustomer(phone, partnerId), kycStatus: 'pending', kycReviewState: 'needs_review', ...over,
  });

  it.each([
    ['watchlist', { watchlistHit: true }],
    ['PEP', { pepHit: true }],
  ] as const)('refuses a partner admin on a %s hold via reviewKycAction and manualKycDecisionAction: untouched, no audit row', async (_k, flag) => {
    await cs.saveCustomer(held('15552220001', 'B', flag));
    currentStaff = staff({ username: 'pb', partnerId: 'B' });
    for (const decision of ['approve', 'reject']) {
      await expect(reviewKycAction(form({ phone: '15552220001', partnerId: 'B', decision, reason: REASON }))).rejects.toThrow(/permission/i);
      await expect(manualKycDecisionAction(form({ phone: '15552220001', partnerId: 'B', decision, reason: REASON }))).rejects.toThrow(/permission/i);
    }
    const c = await cs.getCustomer('B', '15552220001');
    expect(c?.kycStatus).toBe('pending');
    expect(c?.kycReviewState).toBe('needs_review');
    expect(await auditRows()).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('a platform admin may decide a watchlist hold (reviewKycAction) and a PEP hold (manualKycDecisionAction)', async () => {
    await cs.saveCustomer(held('15552220002', 'B', { watchlistHit: true }));
    await cs.saveCustomer(held('15552220003', 'B', { pepHit: true }));
    currentStaff = staff({ username: 'plat' });
    await reviewKycAction(form({ phone: '15552220002', partnerId: 'B', decision: 'reject', reason: REASON }));
    await manualKycDecisionAction(form({ phone: '15552220003', partnerId: 'B', decision: 'approve', reason: REASON }));
    expect((await cs.getCustomer('B', '15552220002'))?.kycStatus).toBe('rejected');
    expect((await cs.getCustomer('B', '15552220003'))?.kycStatus).toBe('verified');
    expect((await auditRows()).map((r) => r.action)).toEqual(['kyc.review.reject', 'kyc.manual_override.approve']);
  });

  it('a non-screening needs_review hold stays decidable by the partner admin, as today', async () => {
    await cs.saveCustomer(held('15552220004', 'B', {}));
    currentStaff = staff({ username: 'pb', partnerId: 'B' });
    await reviewKycAction(form({ phone: '15552220004', partnerId: 'B', decision: 'approve', reason: REASON }));
    expect((await cs.getCustomer('B', '15552220004'))?.kycStatus).toBe('verified');
    expect((await auditRows()).map((r) => r.action)).toEqual(['kyc.review.approve']);
  });
});

describe('manualKycDecisionAction — reasoned, audited, silent (Program-Fix 28)', () => {
  it('a missing or short reason throws BEFORE any read or write', async () => {
    await cs.saveCustomer(makeCustomer('15551230001', 'A'));
    currentStaff = staff({ username: 'plat' });
    await expect(manualKycDecisionAction(form({ phone: '15551230001', partnerId: 'A', decision: 'approve' }))).rejects.toThrow(/reason is required/i);
    await expect(manualKycDecisionAction(form({ phone: '15551230001', partnerId: 'A', decision: 'approve', reason: 'too short' }))).rejects.toThrow(/at least 10/i);
    // Reason is validated before the tenant/customer lookup: an unknown tenant still gets the reason error.
    await expect(manualKycDecisionAction(form({ phone: '15551230001', decision: 'approve', reason: '' }))).rejects.toThrow(/reason is required/i);
    expect((await cs.getCustomer('A', '15551230001'))!.kycStatus).toBe('not_started');
    expect(await auditRows()).toEqual([]);
  });

  it('an invalid decision is refused', async () => {
    currentStaff = staff({ username: 'plat' });
    await expect(manualKycDecisionAction(form({ phone: '15551230001', partnerId: 'A', decision: 'maybe', reason: REASON }))).rejects.toThrow(/decision/i);
  });

  it('approve: verified + kycApprovedBy set + ONE kyc.manual_override.approve row (keyed subject, username actor) + NO WhatsApp message', async () => {
    await cs.saveCustomer(makeCustomer('15551230002', 'A'));
    currentStaff = staff({ username: 'plat', name: 'Platform Admin' });
    await manualKycDecisionAction(form({ phone: '15551230002', partnerId: 'A', decision: 'approve', reason: REASON }));
    const c = await cs.getCustomer('A', '15551230002');
    expect(c?.kycStatus).toBe('verified');
    expect(c?.kycApprovedBy).toBe('Platform Admin (plat)');
    expect(await auditRows()).toEqual([{
      partner_id: 'A', actor: 'plat', action: 'kyc.manual_override.approve', subject_id: auditSubjectId('A', '15551230002'),
      meta: { previousStatus: 'not_started', newStatus: 'verified', reason: REASON, source: 'manual', reviewerName: 'Platform Admin (plat)' },
    }]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('revoke a VERIFIED customer: reject with a reason ⇒ rejected + kyc.manual_override.reject with previousStatus verified', async () => {
    await cs.saveCustomer({ ...makeCustomer('15551230003', 'A'), kycStatus: 'verified' });
    currentStaff = staff({ username: 'plat' });
    await manualKycDecisionAction(form({ phone: '15551230003', partnerId: 'A', decision: 'reject', reason: 'y'.repeat(900) }));
    const c = await cs.getCustomer('A', '15551230003');
    expect(c?.kycStatus).toBe('rejected');
    expect(c?.kycRejectedReason?.length).toBe(500); // L3 cap kept
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'kyc.manual_override.reject', meta: { previousStatus: 'verified', newStatus: 'rejected', source: 'manual' } });
    expect(notify).not.toHaveBeenCalled();
  });

  it('a no-op decision (approve an already-verified customer) is refused with no audit row', async () => {
    await cs.saveCustomer({ ...makeCustomer('15551230004', 'A'), kycStatus: 'verified' });
    currentStaff = staff({ username: 'plat' });
    await expect(manualKycDecisionAction(form({ phone: '15551230004', partnerId: 'A', decision: 'approve', reason: REASON }))).rejects.toThrow(/already/i);
    expect(await auditRows()).toEqual([]);
  });
});

describe('createCustomerAction — creating an already-verified customer needs a reason (Program-Fix 28)', () => {
  beforeEach(() => vi.mocked(redirect).mockClear());

  it('not_started needs no reason and writes no audit row', async () => {
    currentStaff = staff({ username: 'plat' });
    await createCustomerAction(form({ phone: '15552220001', partnerId: 'A', kycStatus: 'not_started' }));
    expect((await cs.getCustomer('A', '15552220001'))?.kycStatus).toBe('not_started');
    expect(await auditRows()).toEqual([]);
  });

  it('verified or grandfathered without a (10+ char) reason is refused and nothing is created', async () => {
    currentStaff = staff({ username: 'plat' });
    await expect(createCustomerAction(form({ phone: '15552220002', partnerId: 'A', kycStatus: 'verified' }))).rejects.toThrow(/reason is required/i);
    await expect(createCustomerAction(form({ phone: '15552220002', partnerId: 'A', kycStatus: 'grandfathered', kycReason: 'short' }))).rejects.toThrow(/at least 10/i);
    expect(await cs.getCustomer('A', '15552220002')).toBeNull();
    expect(await auditRows()).toEqual([]);
  });

  it('verified with a reason: the customer + ONE kyc.manual_override.create row, keyed subject, kycApprovedBy set', async () => {
    currentStaff = staff({ username: 'plat', name: 'Platform Admin' });
    await createCustomerAction(form({ phone: '15552220003', partnerId: 'A', kycStatus: 'verified', kycReason: REASON }));
    const c = await cs.getCustomer('A', '15552220003');
    expect(c?.kycStatus).toBe('verified');
    expect(c?.kycApprovedBy).toBe('Platform Admin (plat)');
    expect(await auditRows()).toEqual([{
      partner_id: 'A', actor: 'plat', action: 'kyc.manual_override.create', subject_id: auditSubjectId('A', '15552220003'),
      meta: { previousStatus: null, newStatus: 'verified', reason: REASON, source: 'manual', reviewerName: 'Platform Admin (plat)' },
    }]);
  });
});

// Program-Fix 37 (dash-04): customer links POST (phone, partnerId) to
// openCustomerAction, which checks scope and redirects to the sealed-ref URL.
// The phone travels only in the POST body, never in a URL.
describe('openCustomerAction (Program-Fix 37)', () => {
  beforeEach(() => vi.mocked(redirect).mockClear());

  it('in scope: redirects to /admin-dashboard/customers/v1.<ref> with no phone, and the ref opens to the row', async () => {
    await cs.saveCustomer(makeCustomer('15551230000', 'A'));
    currentStaff = staff({ username: 'pa', partnerId: 'A' });
    await openCustomerAction(form({ phone: '15551230000', partnerId: 'A' }));
    expect(redirect).toHaveBeenCalledTimes(1);
    const target = vi.mocked(redirect).mock.calls[0][0] as string;
    expect(target.startsWith('/admin-dashboard/customers/v1.')).toBe(true);
    expect(target).not.toContain('15551230000');
    expect(target).not.toContain('?');
    expect(openCustomerRef(target.slice('/admin-dashboard/customers/'.length))).toEqual({ partnerId: 'A', phone: '15551230000' });
  });

  it('partner-A staff opening a partner-B customer gets "Customer not found" and no redirect (pinned, even with a hostile partnerId)', async () => {
    await cs.saveCustomer(makeCustomer('15554445555', 'B'));
    currentStaff = staff({ username: 'pa', partnerId: 'A' });
    await expect(openCustomerAction(form({ phone: '15554445555', partnerId: 'B' }))).rejects.toThrow('Customer not found.');
    expect(redirect).not.toHaveBeenCalled();
  });

  it('platform staff: the posted tenant picks the row, and the ref seals THAT row\'s tenant', async () => {
    await cs.saveCustomer(makeCustomer('15556667777', 'A'));
    await cs.saveCustomer(makeCustomer('15556667777', 'B'));
    currentStaff = staff({ username: 'plat' });
    await openCustomerAction(form({ phone: '15556667777', partnerId: 'B' }));
    const target = vi.mocked(redirect).mock.calls[0][0] as string;
    expect(openCustomerRef(target.slice('/admin-dashboard/customers/'.length))).toEqual({ partnerId: 'B', phone: '15556667777' });
  });

  it('a support user is bounced by requireScope before any read or redirect', async () => {
    await cs.saveCustomer(makeCustomer('15551230000', 'A'));
    currentStaff = staff({ username: 'sup', role: 'support' });
    await expect(openCustomerAction(form({ phone: '15551230000', partnerId: 'A' }))).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('a missing phone or an unknown customer is "Customer not found"', async () => {
    currentStaff = staff({ username: 'plat' });
    await expect(openCustomerAction(form({ partnerId: 'A' }))).rejects.toThrow('Customer not found.');
    await expect(openCustomerAction(form({ phone: '19990001111', partnerId: 'A' }))).rejects.toThrow('Customer not found.');
    expect(redirect).not.toHaveBeenCalled();
  });
});
