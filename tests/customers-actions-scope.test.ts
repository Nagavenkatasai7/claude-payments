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
let store: ReturnType<typeof createStore>;
let cs: ReturnType<typeof createCustomerStore>;

vi.mock('@/lib/auth', () => ({
  requireAdmin: async () => currentStaff,
  requireScope: async () => ({ staff: currentStaff }),
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

import {
  markCustomerVerifiedAction,
  markCustomerRejectedAction,
} from '@/app/admin-dashboard/customers/actions';

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
  const db = await freshDb();
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
    await expect(markCustomerVerifiedAction(form({ phone: '15551112222' }))).rejects.toThrow(
      /not found/i,
    );
    expect((await cs.getCustomer('15551112222'))?.kycStatus).toBe('not_started'); // untouched
  });

  it('lets a partner-admin verify their OWN customer', async () => {
    await cs.saveCustomer(makeCustomer('15553334444', 'B'));
    currentStaff = staff({ username: 'pb', partnerId: 'B' });
    await markCustomerVerifiedAction(form({ phone: '15553334444' }));
    expect((await cs.getCustomer('15553334444'))?.kycStatus).toBe('verified');
  });

  it('lets a platform admin verify any customer', async () => {
    await cs.saveCustomer(makeCustomer('15555556666', 'A'));
    currentStaff = staff({ username: 'plat' });
    await markCustomerVerifiedAction(form({ phone: '15555556666' }));
    expect((await cs.getCustomer('15555556666'))?.kycStatus).toBe('verified');
  });
});

describe('markCustomerRejectedAction (H3 + L3)', () => {
  it('rejects a partner-admin rejecting another partner’s customer', async () => {
    await cs.saveCustomer(makeCustomer('15557778888', 'A'));
    currentStaff = staff({ username: 'pb', partnerId: 'B' });
    await expect(markCustomerRejectedAction(form({ phone: '15557778888' }))).rejects.toThrow(
      /not found/i,
    );
  });

  it('caps the stored rejection reason at 500 chars (L3)', async () => {
    await cs.saveCustomer(makeCustomer('15559990000', 'A'));
    currentStaff = staff({ username: 'plat' });
    await markCustomerRejectedAction(form({ phone: '15559990000', reason: 'y'.repeat(900) }));
    expect((await cs.getCustomer('15559990000'))?.kycRejectedReason?.length).toBe(500);
  });
});
