import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import type { Staff, Customer } from '@/lib/types';

/** H3: a partner-admin must not flip another tenant's customer KYC. */

const redis = fakeRedis();
let currentStaff: Staff;
// Customers/transfers live in Postgres now — stores are rebuilt per test in
// beforeEach (vi.mock factories are hoisted/sync; they close over these lets).
let db: Awaited<ReturnType<typeof freshDb>>;
let store: ReturnType<typeof createStore>;
let cs: ReturnType<typeof createCustomerStore>;

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
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));

import { redirect } from 'next/navigation';
import {
  markCustomerVerifiedAction,
  markCustomerRejectedAction,
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
});

describe('markCustomerVerifiedAction partner scope (H3)', () => {
  it('rejects a partner-admin verifying another partner’s customer', async () => {
    await cs.saveCustomer(makeCustomer('15551112222', 'A'));
    currentStaff = staff({ username: 'pb', partnerId: 'B' });
    await expect(markCustomerVerifiedAction(form({ phone: '15551112222', partnerId: 'A' }))).rejects.toThrow(
      /not found/i,
    );
    expect((await cs.getCustomer('A', '15551112222'))?.kycStatus).toBe('not_started'); // untouched
  });

  it('lets a partner-admin verify their OWN customer', async () => {
    await cs.saveCustomer(makeCustomer('15553334444', 'B'));
    currentStaff = staff({ username: 'pb', partnerId: 'B' });
    await markCustomerVerifiedAction(form({ phone: '15553334444', partnerId: 'B' }));
    expect((await cs.getCustomer('B', '15553334444'))?.kycStatus).toBe('verified');
  });

  it('lets a platform admin verify any customer', async () => {
    await cs.saveCustomer(makeCustomer('15555556666', 'A'));
    currentStaff = staff({ username: 'plat' });
    await markCustomerVerifiedAction(form({ phone: '15555556666', partnerId: 'A' }));
    expect((await cs.getCustomer('A', '15555556666'))?.kycStatus).toBe('verified');
  });

  it('a partner-admin is PINNED to their tenant: a hostile partnerId field cannot reach another tenant\'s row', async () => {
    await seedPartner(db, 'acme'); await seedPartner(db, 'beta');
    await cs.saveCustomer(makeCustomer('15559990000', 'beta'));
    currentStaff = staff({ partnerId: 'acme' });
    await expect(markCustomerVerifiedAction(form({ phone: '15559990000', partnerId: 'beta' }))).rejects.toThrow(/not found/i);
    expect((await cs.getCustomer('beta', '15559990000'))!.kycStatus).toBe('not_started');
  });

  it('platform staff MUST name the tenant: a form without partnerId is refused and the row is untouched', async () => {
    await cs.saveCustomer(makeCustomer('15559991111', 'A'));
    currentStaff = staff({ username: 'plat' });
    await expect(markCustomerVerifiedAction(form({ phone: '15559991111' }))).rejects.toThrow('Partner is required.');
    expect((await cs.getCustomer('A', '15559991111'))!.kycStatus).toBe('not_started');
  });
});

describe('markCustomerRejectedAction (H3 + L3)', () => {
  it('rejects a partner-admin rejecting another partner’s customer', async () => {
    await cs.saveCustomer(makeCustomer('15557778888', 'A'));
    currentStaff = staff({ username: 'pb', partnerId: 'B' });
    await expect(markCustomerRejectedAction(form({ phone: '15557778888', partnerId: 'A' }))).rejects.toThrow(
      /not found/i,
    );
  });

  it('caps the stored rejection reason at 500 chars (L3)', async () => {
    await cs.saveCustomer(makeCustomer('15559990000', 'A'));
    currentStaff = staff({ username: 'plat' });
    await markCustomerRejectedAction(form({ phone: '15559990000', partnerId: 'A', reason: 'y'.repeat(900) }));
    expect((await cs.getCustomer('A', '15559990000'))?.kycRejectedReason?.length).toBe(500);
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
