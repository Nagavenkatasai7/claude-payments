import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { createStore } from '@/lib/store';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { EnvKeyProvider } from '@/lib/field-crypto';
import type { Db } from '@/db/client';
import type { Customer, Transfer } from '@/lib/types';

/**
 * Customer-facing refund-request action tests (account dashboard hardening).
 * Focus — the action self-gates, enforces OWNERSHIP 404-never-403, and mirrors
 * the request_refund bot tool's eligibility EXACTLY:
 *   - paid + refundStatus none ⇒ flips to 'requested';
 *   - delivered ⇒ refused (no state change);
 *   - not-owner ⇒ refused (no state change), indistinguishable from missing;
 *   - already-requested ⇒ refused (no double-request);
 *   - no session ⇒ redirect to /account/login.
 * The action NEVER moves money — it only flags the transfer for ops review.
 */

const crypto = new EnvKeyProvider(Buffer.alloc(32, 7));

// pg-backed handles rebuilt per test — module-scope `let`, dereferenced inside
// the hoisted vi.mock factory closures at CALL time (never captured early).
let db: Db;
let store: ReturnType<typeof createStore>;
let sessionCustomer: Customer | null = null;

vi.mock('@/lib/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/store')>('@/lib/store');
  return { ...actual, getStore: () => store };
});
vi.mock('@/db/client', async () => {
  const actual = await vi.importActual<typeof import('@/db/client')>('@/db/client');
  return { ...actual, getDb: () => db };
});

const redirectMock = vi.fn((path: string) => {
  throw new Error(`REDIRECT:${path}`);
});
vi.mock('@/lib/customer-auth', () => ({
  requireCustomer: async () => {
    if (!sessionCustomer) redirectMock('/account/login');
    return sessionCustomer;
  },
}));

const revalidateMock = vi.fn();
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidateMock(p) }));

import { requestRefundAction } from '@/app/account/receipt/refund-actions';

const OWNER = '15551230000';
const STRANGER = '15559990000';

function customer(over: Partial<Customer> = {}): Customer {
  const now = new Date().toISOString();
  return {
    senderPhone: OWNER,
    firstSeenAt: now,
    kycStatus: 'verified',
    senderCountry: 'US',
    partnerId: 'default',
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function transfer(over: Partial<Transfer> = {}): Transfer {
  return {
    id: 'tr_refund_1',
    phone: OWNER,
    amountUsd: 200, feeUsd: 1.99, totalChargeUsd: 201.99,
    fxRate: 85.2, amountInr: 17040,
    recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234',
    fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared', complianceReasons: [],
    status: 'paid',
    createdAt: new Date().toISOString(),
    paidAt: new Date().toISOString(),
    sourceCountry: 'US', sourceCurrency: 'USD',
    destinationCountry: 'IN', destinationCurrency: 'INR',
    partnerId: 'default',
    amountSource: 200, feeSource: 1.99, totalChargeSource: 201.99,
    ...over,
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
  sessionCustomer = customer();
  redirectMock.mockClear();
  revalidateMock.mockClear();
});

async function refundStatusOf(id: string): Promise<string> {
  const t = await createTransferRepo(db).getTransfer(id);
  return t?.refundStatus ?? 'none';
}

describe('requestRefundAction', () => {
  it('redirects to login when there is no session (self-gating)', async () => {
    sessionCustomer = null;
    await store.saveTransfer(transfer());
    await expect(requestRefundAction(form({ transferId: 'tr_refund_1' }))).rejects.toThrow(
      'REDIRECT:/account/login',
    );
    expect(await refundStatusOf('tr_refund_1')).toBe('none');
  });

  it('flips none → requested for a paid, not-delivered, owned transfer', async () => {
    await store.saveTransfer(transfer({ status: 'paid' }));
    await requestRefundAction(form({ transferId: 'tr_refund_1' }));
    expect(await refundStatusOf('tr_refund_1')).toBe('requested');
    // Refresh the receipt + account views so the new label shows.
    expect(revalidateMock).toHaveBeenCalledWith('/account/receipt/tr_refund_1');
    expect(revalidateMock).toHaveBeenCalledWith('/account');
  });

  it('refuses a delivered transfer and changes nothing', async () => {
    await store.saveTransfer(transfer({ status: 'delivered', deliveredAt: new Date().toISOString() }));
    await expect(requestRefundAction(form({ transferId: 'tr_refund_1' }))).rejects.toThrow(
      /not eligible/i,
    );
    expect(await refundStatusOf('tr_refund_1')).toBe('none');
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it("refuses when the session customer doesn't own the transfer (404-never-403)", async () => {
    // Transfer belongs to a stranger; the session is the OWNER constant.
    await store.saveTransfer(transfer({ phone: STRANGER, status: 'paid' }));
    await expect(requestRefundAction(form({ transferId: 'tr_refund_1' }))).rejects.toThrow(
      /not eligible/i,
    );
    expect(await refundStatusOf('tr_refund_1')).toBe('none');
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it('refuses a transfer whose refund is already requested', async () => {
    await store.saveTransfer(transfer({ status: 'paid' }));
    // Put it into 'requested' first.
    await createTransferRepo(db).updateRefund('tr_refund_1', { refundStatus: 'requested' });
    await expect(requestRefundAction(form({ transferId: 'tr_refund_1' }))).rejects.toThrow(
      /not eligible/i,
    );
    expect(await refundStatusOf('tr_refund_1')).toBe('requested');
  });

  it('refuses a non-existent transfer (indistinguishable from not-owned)', async () => {
    await expect(requestRefundAction(form({ transferId: 'does_not_exist' }))).rejects.toThrow(
      /not eligible/i,
    );
  });

  it('refuses an awaiting_payment transfer (not paid yet)', async () => {
    await store.saveTransfer(transfer({ status: 'awaiting_payment', paidAt: undefined }));
    await expect(requestRefundAction(form({ transferId: 'tr_refund_1' }))).rejects.toThrow(
      /not eligible/i,
    );
    expect(await refundStatusOf('tr_refund_1')).toBe('none');
  });
});
