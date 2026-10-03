import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { eq } from 'drizzle-orm';
import { auditEvents } from '@/db/schema';
import { createStore } from '@/lib/store';
import type { Staff, Transfer } from '@/lib/types';
import type { Db } from '@/db/client';

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
let db: Db;

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
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/whatsapp', () => ({ sendText: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import {
  cancelTransferAction,
  assignTransferAction,
  releaseTransferAction,
} from '@/app/admin-dashboard/actions';
import { createAuthStore } from '@/lib/auth-store';

// Legacy server actions refuse on a partner-site host (src/lib/site-host-guard.ts); this suite runs
// them as on the apex.
vi.mock('next/headers', async (orig) => ({
  ...(await orig<typeof import('next/headers')>()),
  headers: async () => new Headers({ host: 'smartremit.ai' }),
}));

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
  db = await freshDb();
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

describe('cancelTransferAction — the public POST endpoint refuses money-05 (Phase 1 Task 5)', () => {
  it('refuses a PAID charged transfer even for a platform admin: steers to Refund, ledger untouched', async () => {
    await store.saveTransfer(makeTransfer({ id: 'm1', partnerId: 'A', status: 'paid', fundingRef: 'mockfund-m1' }));
    currentStaff = staff({ username: 'plat' });
    await expect(cancelTransferAction(form({ id: 'm1' }))).rejects.toThrow(/use Refund/i);
    const t = await store.getTransfer('m1');
    expect(t?.status).toBe('paid');
    expect(t?.refundStatus ?? 'none').toBe('none');
  });

  it('refuses a CHARGED in_review transfer POSTed directly (the list never renders Cancel there): steers to Reject', async () => {
    await store.saveTransfer(
      makeTransfer({ id: 'm2', partnerId: 'B', status: 'in_review', complianceStatus: 'flagged', fundingRef: 'mockfund-m2' }),
    );
    currentStaff = staff({ username: 'pb', partnerId: 'B' });
    await expect(cancelTransferAction(form({ id: 'm2' }))).rejects.toThrow(/use Reject/i);
    expect((await store.getTransfer('m2'))?.status).toBe('in_review');
  });

  it('scope still runs FIRST: another tenant’s paid row answers the generic not-found, never the money refusal', async () => {
    await store.saveTransfer(makeTransfer({ id: 'm3', partnerId: 'A', status: 'paid', fundingRef: 'mockfund-m3' }));
    currentStaff = staff({ username: 'pb', partnerId: 'B' });
    await expect(cancelTransferAction(form({ id: 'm3' }))).rejects.toThrow(/^Transfer not found$/);
    expect((await store.getTransfer('m3'))?.status).toBe('paid');
  });

  it('a NON-admin agent with canCancel cannot end an UNCHARGED compliance hold: the hold is refused and stays in_review', async () => {
    await store.saveTransfer(
      makeTransfer({ id: 'm4', partnerId: 'A', status: 'in_review', complianceStatus: 'flagged', fundingMethod: 'bank_pull', transferType: 'b2b' }),
    );
    currentStaff = staff({
      username: 'agentA',
      role: 'agent',
      partnerId: 'A',
      permissions: { canCancel: true, canResend: false, canAssign: false },
    });
    await expect(cancelTransferAction(form({ id: 'm4' }))).rejects.toThrow(/use Reject/i);
    expect((await store.getTransfer('m4'))?.status).toBe('in_review');
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

  it('M3-6: rejects a finance assignee (a /partner-only role cannot open the legacy transfer surfaces)', async () => {
    await store.saveTransfer(makeTransfer({ id: 'a4', partnerId: 'A', status: 'paid' }));
    await authStore.saveStaff(staff({ username: 'finA', role: 'finance' as Staff['role'], partnerId: 'A' }));
    currentStaff = staff({ username: 'plat' });
    await expect(assignTransferAction(form({ id: 'a4', assignee: 'finA', note: 'x' }))).rejects.toThrow(/cannot work/i);
    expect((await store.getTransfer('a4'))?.assignedTo).toBeUndefined();
  });

  it('lost-features p1 A2: the note is bounded in the transfer.assign audit row; adminNote is untouched', async () => {
    await store.saveTransfer(makeTransfer({ id: 'a3', partnerId: 'A', status: 'paid', adminNote: 'rail failure note' }));
    await authStore.saveStaff(staff({ username: 'agentA', partnerId: 'A' }));
    currentStaff = staff({ username: 'plat' });
    await assignTransferAction(form({ id: 'a3', assignee: 'agentA', note: 'x'.repeat(900) }));
    const t = await store.getTransfer('a3');
    expect(t?.assignedTo).toBe('agentA');
    expect(t?.adminNote).toBe('rail failure note');
    const [row] = await db.select().from(auditEvents).where(eq(auditEvents.action, 'transfer.assign'));
    expect(row).toMatchObject({ actor: 'plat', subjectId: 'a3', partnerId: 'A' });
    expect((row.meta as { note: string }).note.length).toBe(500);
    expect(row.meta).toMatchObject({ assignee: 'agentA', previousAssignee: null, actorScope: 'platform' });
  });

  it('lost-features p1 dead-end fix: a support assignee is refused (support cannot open a transfer)', async () => {
    await store.saveTransfer(makeTransfer({ id: 'a5', partnerId: 'A', status: 'paid' }));
    await authStore.saveStaff(staff({ username: 'supA', role: 'support', partnerId: 'A' }));
    await authStore.saveStaff(staff({ username: 'platSup', role: 'support' }));
    currentStaff = staff({ username: 'plat' });
    await expect(assignTransferAction(form({ id: 'a5', assignee: 'supA', note: 'x' }))).rejects.toThrow(/cannot work/i);
    await expect(assignTransferAction(form({ id: 'a5', assignee: 'platSup', note: 'x' }))).rejects.toThrow(/cannot work/i);
    await expect(assignTransferAction(form({ id: 'a5', assignee: 'nobody', note: 'x' }))).rejects.toThrow(/unknown/i);
    expect((await store.getTransfer('a5'))?.assignedTo).toBeUndefined();
  });
});
