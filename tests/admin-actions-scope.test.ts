import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createStore } from '@/lib/store';
import type { Staff, Transfer } from '@/lib/types';

/**
 * Partner-scope enforcement on the mutating transfer actions (audit H1/H2/M2).
 * A partner-scoped staff member must not be able to cancel / release / assign a
 * transfer belonging to ANOTHER partner by POSTing its id directly.
 */

const redis = fakeRedis();
let currentStaff: Staff;
// Transfers live in Postgres now — the store is rebuilt per test in beforeEach
// (vi.mock factories are hoisted/sync, so they close over this let-variable).
let store: ReturnType<typeof createStore>;

vi.mock('@/lib/auth', () => ({
  requireStaff: async () => currentStaff,
  requireAdmin: async () => currentStaff,
  requirePlatformAdmin: vi.fn(),
  requireScope: async () => ({ staff: currentStaff }),
  getCurrentStaff: vi.fn(),
}));
vi.mock('@/lib/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/store')>('@/lib/store');
  return { ...actual, getStore: () => store };
});
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/whatsapp', () => ({ sendText: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import {
  cancelTransferAction,
  assignTransferAction,
  releaseTransferAction,
} from '@/app/admin-dashboard/actions';
import { createAuthStore } from '@/lib/auth-store';

const authStore = createAuthStore(redis);

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

function makeTransfer(overrides: Partial<Transfer> & { id: string }): Transfer {
  return {
    phone: '15551234567',
    amountUsd: 200,
    feeUsd: 0,
    totalChargeUsd: 200,
    fxRate: 85,
    amountInr: 17000,
    recipientName: 'Mom',
    recipientPhone: '919876543210',
    payoutMethod: 'bank',
    payoutDestination: 'acct 000111222',
    fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared',
    complianceReasons: [],
    status: 'awaiting_payment',
    createdAt: '2026-05-30T00:00:00Z',
    sourceCountry: 'US',
    sourceCurrency: 'USD',
    destinationCountry: 'IN',
    destinationCurrency: 'INR',
    partnerId: 'A',
    amountSource: 200,
    feeSource: 0,
    totalChargeSource: 200,
    ...overrides,
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
  // Transfers carry a REAL FK to partners — seed the two tenants used below.
  await seedPartner(db, 'A');
  await seedPartner(db, 'B');
  store = createStore(redis, db);
});

describe('cancelTransferAction partner scope (H1)', () => {
  it('rejects a partner-admin cancelling another partner’s transfer', async () => {
    await store.saveTransfer(makeTransfer({ id: 't1', partnerId: 'A' }));
    currentStaff = staff({ username: 'pb', partnerId: 'B' }); // belongs to partner B
    await expect(cancelTransferAction(form({ id: 't1' }))).rejects.toThrow(/not found/i);
    expect((await store.getTransfer('t1'))?.status).toBe('awaiting_payment'); // untouched
  });

  it('lets a partner-admin cancel their OWN partner’s transfer', async () => {
    await store.saveTransfer(makeTransfer({ id: 't2', partnerId: 'B' }));
    currentStaff = staff({ username: 'pb', partnerId: 'B' });
    await cancelTransferAction(form({ id: 't2' }));
    expect((await store.getTransfer('t2'))?.status).toBe('cancelled');
  });

  it('lets a platform admin cancel any partner’s transfer', async () => {
    await store.saveTransfer(makeTransfer({ id: 't3', partnerId: 'A' }));
    currentStaff = staff({ username: 'plat' }); // no partnerId → platform
    await cancelTransferAction(form({ id: 't3' }));
    expect((await store.getTransfer('t3'))?.status).toBe('cancelled');
  });
});

describe('releaseTransferAction partner scope (H2)', () => {
  it('rejects a partner-admin releasing another partner’s held transfer', async () => {
    await store.saveTransfer(makeTransfer({ id: 'r1', partnerId: 'A', status: 'in_review' }));
    currentStaff = staff({ username: 'pb', partnerId: 'B' });
    await expect(releaseTransferAction(form({ id: 'r1' }))).rejects.toThrow(/not found/i);
    expect((await store.getTransfer('r1'))?.status).toBe('in_review'); // not delivered
  });
});

describe('assignTransferAction assignee scope (M2)', () => {
  it('rejects assigning a transfer to a staff member in a different partner', async () => {
    await store.saveTransfer(makeTransfer({ id: 'a1', partnerId: 'A', status: 'paid' }));
    await authStore.saveStaff(staff({ username: 'agentB', partnerId: 'B' }));
    currentStaff = staff({ username: 'plat' }); // platform admin assigning
    await expect(
      assignTransferAction(form({ id: 'a1', assignee: 'agentB', note: 'look into this' })),
    ).rejects.toThrow(/scope/i);
    expect((await store.getTransfer('a1'))?.assignedTo).toBeUndefined();
  });

  it('allows assigning to a same-partner staff member', async () => {
    await store.saveTransfer(makeTransfer({ id: 'a2', partnerId: 'A', status: 'paid' }));
    await authStore.saveStaff(staff({ username: 'agentA', partnerId: 'A' }));
    currentStaff = staff({ username: 'plat' });
    await assignTransferAction(form({ id: 'a2', assignee: 'agentA', note: 'ok' }));
    expect((await store.getTransfer('a2'))?.assignedTo).toBe('agentA');
  });

  it('caps the stored note at 500 chars (L3)', async () => {
    await store.saveTransfer(makeTransfer({ id: 'a3', partnerId: 'A', status: 'paid' }));
    await authStore.saveStaff(staff({ username: 'agentA', partnerId: 'A' }));
    currentStaff = staff({ username: 'plat' });
    await assignTransferAction(form({ id: 'a3', assignee: 'agentA', note: 'x'.repeat(900) }));
    expect((await store.getTransfer('a3'))?.adminNote?.length).toBe(500);
  });
});
