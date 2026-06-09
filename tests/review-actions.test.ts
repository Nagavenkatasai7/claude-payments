import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { createStore, type Store } from '@/lib/store';
import { freshDb } from './helpers-db';
import type { Transfer } from '@/lib/types';

// pg-backed store rebuilt per test (freshDb truncates); the hoisted mock
// factory must NOT construct it — getStore closes over the let lazily.
let store: Store;

// Mock auth so we can control who is calling
const mockRequireAdmin = vi.fn();
vi.mock('@/lib/auth', () => ({
  requireAdmin: () => mockRequireAdmin(),
  requireStaff: vi.fn(),
  requirePlatformAdmin: vi.fn(),
  requireScope: vi.fn(),
  getCurrentStaff: vi.fn(),
}));
vi.mock('@/lib/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/store')>('@/lib/store');
  return { ...actual, getStore: () => store };
});
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { releaseTransferAction, rejectTransferAction } from '@/app/admin-dashboard/actions';

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
    payoutMethod: 'upi',
    payoutDestination: 'mom@upi',
    fundingMethod: 'bank_transfer',
    complianceStatus: 'flagged',
    complianceReasons: ['Large transfer amount.'],
    status: 'in_review',
    createdAt: '2026-05-30T00:00:00Z',
    sourceCountry: 'US',
    sourceCurrency: 'USD',
    destinationCountry: 'IN',
    destinationCurrency: 'INR',
    partnerId: 'default',
    amountSource: 200,
    feeSource: 0,
    totalChargeSource: 200,
    paidAt: '2026-05-30T01:00:00Z',
    ...overrides,
  };
}

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

beforeEach(async () => {
  store = createStore(fakeRedis(), await freshDb());
  mockRequireAdmin.mockReset();
});

describe('releaseTransferAction', () => {
  it('delivers an in_review transfer when admin calls it', async () => {
    mockRequireAdmin.mockResolvedValue({ username: 'admin', role: 'admin' });
    await store.saveTransfer(makeTransfer({ id: 'rr1' }));

    await releaseTransferAction(form({ id: 'rr1' }));

    const loaded = await store.getTransfer('rr1');
    expect(loaded?.status).toBe('delivered');
  });

  it('throws (auth rejected) when requireAdmin throws', async () => {
    mockRequireAdmin.mockRejectedValue(new Error('Forbidden'));

    await expect(releaseTransferAction(form({ id: 'any' }))).rejects.toThrow('Forbidden');
  });

  it('throws when transfer is not in_review', async () => {
    mockRequireAdmin.mockResolvedValue({ username: 'admin', role: 'admin' });
    await store.saveTransfer(makeTransfer({ id: 'rr2', status: 'delivered' }));

    await expect(releaseTransferAction(form({ id: 'rr2' }))).rejects.toThrow(/not in_review/i);
  });
});

describe('rejectTransferAction', () => {
  it('cancels an in_review transfer with adminNote when admin calls it', async () => {
    mockRequireAdmin.mockResolvedValue({ username: 'admin', role: 'admin' });
    await store.saveTransfer(makeTransfer({ id: 'rj1' }));

    await rejectTransferAction(form({ id: 'rj1' }));

    const loaded = await store.getTransfer('rj1');
    expect(loaded?.status).toBe('cancelled');
    expect(loaded?.adminNote).toContain('rejected in review');
  });

  it('throws (auth rejected) when requireAdmin throws', async () => {
    mockRequireAdmin.mockRejectedValue(new Error('Forbidden'));

    await expect(rejectTransferAction(form({ id: 'any' }))).rejects.toThrow('Forbidden');
  });

  it('throws when transfer is not in_review', async () => {
    mockRequireAdmin.mockResolvedValue({ username: 'admin', role: 'admin' });
    await store.saveTransfer(makeTransfer({ id: 'rj2', status: 'awaiting_payment' }));

    await expect(rejectTransferAction(form({ id: 'rj2' }))).rejects.toThrow(/not in_review/i);
  });
});
