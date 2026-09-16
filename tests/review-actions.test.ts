import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { createStore, type Store } from '@/lib/store';
import { freshDb } from './helpers-db';
import type { Transfer } from '@/lib/types';
import type { Db } from '@/db/client';

// pg-backed store rebuilt per test (freshDb truncates); the hoisted mock
// factory must NOT construct it — getStore closes over the let lazily.
let store: Store;
let db: Db;

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
vi.mock('@/db/client', async (orig) => ({
  ...(await orig<typeof import('@/db/client')>()),
  getDb: () => db,
}));

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
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  mockRequireAdmin.mockReset();
});

describe('releaseTransferAction', () => {
  it('releases an in_review transfer to paid (a settlement) when admin calls it', async () => {
    mockRequireAdmin.mockResolvedValue({ username: 'admin', role: 'admin' });
    await store.saveTransfer(makeTransfer({ id: 'rr1' }));

    await releaseTransferAction(form({ id: 'rr1' }));

    const loaded = await store.getTransfer('rr1');
    expect(loaded?.status).toBe('paid');
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

// OWNER DECISION (2026-09-16): releasing a transfer that SmartRemit's OWN
// screening flagged (owning partner kycMode 'ours') requires PLATFORM staff. A
// partner-scoped admin may release only a 'delegated'-mode partner's hold.
describe('releaseTransferAction — platform staff required for an ours-mode hold', () => {
  async function outboxRows() {
    const r = await db.execute(sql`SELECT kind, dedupe_key FROM outbox ORDER BY id`);
    return (r as unknown as { rows: Array<{ kind: string; dedupe_key: string | null }> }).rows;
  }

  it("refuses a PARTNER-scoped admin releasing a flagged transfer of a kycMode 'ours' partner: row stays in_review, NO outbox row", async () => {
    mockRequireAdmin.mockResolvedValue({ username: 'padmin', role: 'admin', partnerId: 'default' });
    await store.saveTransfer(makeTransfer({ id: 'own1', partnerId: 'default' })); // 'default' is kycMode 'ours'

    await expect(releaseTransferAction(form({ id: 'own1' }))).rejects.toThrow(/permission/i);

    expect((await store.getTransfer('own1'))?.status).toBe('in_review');
    expect(await outboxRows()).toHaveLength(0);
  });

  it("a PLATFORM admin releases the same ours-mode hold: paid + the rail effect is enqueued", async () => {
    mockRequireAdmin.mockResolvedValue({ username: 'plat', role: 'admin' });
    await store.saveTransfer(makeTransfer({ id: 'own2', partnerId: 'default' }));

    await releaseTransferAction(form({ id: 'own2' }));

    expect((await store.getTransfer('own2'))?.status).toBe('paid');
    expect(await outboxRows()).toEqual([{ kind: 'mock.settle', dedupe_key: 'mocksettle:own2' }]);
  });

  it("a PARTNER-scoped admin can still release a kycMode 'delegated' partner's own hold", async () => {
    await db.execute(sql`INSERT INTO partners (id, name, status, countries, kyc_mode)
      VALUES ('delg', 'Delegated Co', 'active', '["US"]'::jsonb, 'delegated')`);
    mockRequireAdmin.mockResolvedValue({ username: 'dadmin', role: 'admin', partnerId: 'delg' });
    await store.saveTransfer(makeTransfer({ id: 'del1', partnerId: 'delg' }));

    await releaseTransferAction(form({ id: 'del1' }));

    expect((await store.getTransfer('del1'))?.status).toBe('paid');
    expect(await outboxRows()).toEqual([{ kind: 'mock.settle', dedupe_key: 'mocksettle:del1' }]);
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
