import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { createStore } from '@/lib/store';
import { createAuditRepo } from '@/db/repos/aux-repos';
import type { Db } from '@/db/client';
import type { Staff, Transfer } from '@/lib/types';

/**
 * cancelB2bTransferAction is a PUBLIC POST endpoint (Phase 1 Task 5 /
 * Program-Fix 9 / money-05). The B2B page renders Cancel only on an unfunded
 * awaiting_payment row, but a direct POST can name any id. An in_review hold is
 * a compliance decision (Reject / Release, admin), so the action must refuse
 * it, leave the row in_review and write NO b2b.transfer.cancel audit row.
 */

const redis = fakeRedis();
// pg-backed handles rebuilt per test; the hoisted vi.mock factories read these
// module-scope lets at CALL time.
let db: Db;
let store: ReturnType<typeof createStore>;
let currentStaff: Staff;

vi.mock('@/lib/auth', () => ({
  requireScope: async () => ({ staff: currentStaff, scope: { kind: 'platform' } }),
}));
vi.mock('@/lib/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/store')>('@/lib/store');
  return { ...actual, getStore: () => store };
});
vi.mock('@/db/client', async () => {
  const actual = await vi.importActual<typeof import('@/db/client')>('@/db/client');
  return { ...actual, getDb: () => db };
});
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { cancelB2bTransferAction } from '@/app/admin-dashboard/b2b/actions';

function staff(): Staff {
  return {
    username: 'plat',
    name: 'Plat',
    role: 'admin',
    permissions: { canCancel: true, canResend: true, canAssign: true },
    passwordHash: 'x',
    createdAt: '2026-01-01T00:00:00Z',
  };
}

function b2bTransfer(over: Partial<Transfer> & { id: string }): Transfer {
  return {
    phone: '15551234567',
    amountUsd: 200,
    feeUsd: 0,
    totalChargeUsd: 200,
    fxRate: 85,
    amountInr: 17000,
    recipientName: 'Acme Exports',
    recipientPhone: '919876543210',
    payoutMethod: 'bank',
    payoutDestination: 'acct 000111222',
    fundingMethod: 'ach_pull',
    transferType: 'b2b',
    complianceStatus: 'cleared',
    complianceReasons: [],
    status: 'awaiting_payment',
    createdAt: new Date().toISOString(),
    sourceCountry: 'US',
    sourceCurrency: 'USD',
    destinationCountry: 'IN',
    destinationCurrency: 'INR',
    partnerId: 'default',
    amountSource: 200,
    feeSource: 0,
    totalChargeSource: 200,
    ...over,
  };
}

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

async function cancelAuditRows(subjectId: string) {
  const rows = await createAuditRepo(db).listRecent(100);
  return rows.filter((r) => r.action === 'b2b.transfer.cancel' && r.subjectId === subjectId);
}

beforeEach(async () => {
  redis.dump.clear();
  db = await freshDb();
  store = createStore(redis, db);
  currentStaff = staff();
});

describe('cancelB2bTransferAction: a direct POST cannot end a compliance hold (Program-Fix 9)', () => {
  it('refuses an in_review B2B hold with the Reject copy; the row stays in_review and NO cancel audit row is written', async () => {
    await store.saveTransfer(b2bTransfer({ id: 'b2b_hold', status: 'in_review', complianceStatus: 'flagged' }));
    await expect(cancelB2bTransferAction(form({ id: 'b2b_hold' }))).rejects.toThrow(/use Reject/);
    expect((await store.getTransfer('b2b_hold'))?.status).toBe('in_review');
    expect(await cancelAuditRows('b2b_hold')).toHaveLength(0);
  });

  it('control: an UNFUNDED awaiting_payment B2B bill is voided and exactly one cancel audit row is written', async () => {
    await store.saveTransfer(b2bTransfer({ id: 'b2b_open' }));
    await cancelB2bTransferAction(form({ id: 'b2b_open' }));
    expect((await store.getTransfer('b2b_open'))?.status).toBe('cancelled');
    const audit = await cancelAuditRows('b2b_open');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: 'plat', actorType: 'staff', partnerId: 'default', meta: { previousStatus: 'awaiting_payment' } });
  });
});
