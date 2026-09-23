import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
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
vi.mock('next/navigation', () => ({ redirect: (p: string) => redirectMock(p) }));

// Program-Fix 49D: the step-up's collaborators. `mfaEnrolled` toggles the
// customer's portal TOTP; '246810' is the one valid code; `reserveAllowed`
// simulates the fix-19 attempt buckets.
let mfaEnrolled = false;
let reserveAllowed = true;
const verifyCodeMock = vi.fn(async (_k: unknown, code: string) => code === '246810');
const reserveMock = vi.fn(async () => reserveAllowed);
const clearMock = vi.fn(async () => undefined);
vi.mock('@/lib/customer-mfa', async () => {
  const actual = await vi.importActual<typeof import('@/lib/customer-mfa')>('@/lib/customer-mfa');
  return {
    ...actual,
    getCustomerMfaStore: () => ({ isEnrolled: async () => mfaEnrolled, verifyCode: verifyCodeMock }),
  };
});
vi.mock('@/lib/customer-auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/customer-auth-store')>('@/lib/customer-auth-store');
  return { ...actual, getCustomerAuthStore: () => ({ reserveLoginAttempt: reserveMock, clearLoginFailures: clearMock }) };
});
vi.mock('next/headers', () => ({ headers: async () => ({ get: (n: string) => (n === 'x-forwarded-for' ? '198.51.100.7' : null) }) }));

import { cancelTransferAction, requestRefundAction } from '@/app/account/receipt/refund-actions';
import { beginSettlement } from '@/lib/settlement';
import { sql } from 'drizzle-orm';

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
  mfaEnrolled = false;
  reserveAllowed = true;
  verifyCodeMock.mockClear();
  reserveMock.mockClear();
  clearMock.mockClear();
  vi.unstubAllEnvs();
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

describe('requestRefundAction — step-up for portal MFA (Program-Fix 49D)', () => {
  it('not enrolled (default): unchanged — no code asked, no reservation spent', async () => {
    await store.saveTransfer(transfer({ status: 'paid' }));
    await requestRefundAction(form({ transferId: 'tr_refund_1' }));
    expect(await refundStatusOf('tr_refund_1')).toBe('requested');
    expect(reserveMock).not.toHaveBeenCalled();
  });

  it('enrolled + no code: bounced back to the receipt with ?error=mfa_code, nothing changes', async () => {
    mfaEnrolled = true;
    await store.saveTransfer(transfer({ status: 'paid' }));
    await expect(requestRefundAction(form({ transferId: 'tr_refund_1' }))).rejects.toThrow(
      'REDIRECT:/account/receipt/tr_refund_1?error=mfa_code',
    );
    expect(await refundStatusOf('tr_refund_1')).toBe('none');
  });

  it('enrolled + wrong code: ?error=mfa_invalid after a reservation, nothing changes', async () => {
    mfaEnrolled = true;
    await store.saveTransfer(transfer({ status: 'paid' }));
    await expect(requestRefundAction(form({ transferId: 'tr_refund_1', code: '111111' }))).rejects.toThrow(
      'REDIRECT:/account/receipt/tr_refund_1?error=mfa_invalid',
    );
    expect(reserveMock).toHaveBeenCalledWith(OWNER, '198.51.100.7');
    expect(await refundStatusOf('tr_refund_1')).toBe('none');
  });

  it('enrolled + throttled: ?error=mfa_throttled and the code is never checked', async () => {
    mfaEnrolled = true;
    reserveAllowed = false;
    await store.saveTransfer(transfer({ status: 'paid' }));
    await expect(requestRefundAction(form({ transferId: 'tr_refund_1', code: '246810' }))).rejects.toThrow(
      'REDIRECT:/account/receipt/tr_refund_1?error=mfa_throttled',
    );
    expect(verifyCodeMock).not.toHaveBeenCalled();
    expect(await refundStatusOf('tr_refund_1')).toBe('none');
  });

  it('enrolled + right code: the refund request goes through', async () => {
    mfaEnrolled = true;
    await store.saveTransfer(transfer({ status: 'paid' }));
    await requestRefundAction(form({ transferId: 'tr_refund_1', code: '246 810' }));
    expect(await refundStatusOf('tr_refund_1')).toBe('requested');
  });

  it('CUSTOMER_MFA_REQUIRED on and not enrolled: ?error=mfa_required, nothing changes', async () => {
    vi.stubEnv('CUSTOMER_MFA_REQUIRED', 'true');
    await store.saveTransfer(transfer({ status: 'paid' }));
    await expect(requestRefundAction(form({ transferId: 'tr_refund_1' }))).rejects.toThrow(
      'REDIRECT:/account/receipt/tr_refund_1?error=mfa_required',
    );
    expect(await refundStatusOf('tr_refund_1')).toBe('none');
  });

  it('an ineligible transfer is still refused with the generic error before any code is asked', async () => {
    mfaEnrolled = true;
    await store.saveTransfer(transfer({ status: 'delivered', deliveredAt: new Date().toISOString() }));
    await expect(requestRefundAction(form({ transferId: 'tr_refund_1' }))).rejects.toThrow(/not eligible/i);
    expect(reserveMock).not.toHaveBeenCalled();
  });
});


// Program-Fix 15 PR C — the receipt's 30-minute cancel. Self-gates, 404-never-
// 403 ownership, the 49D step-up, then the LOCKED sender-cancel service; every
// outcome redirects back to the receipt with a FIXED code (never URL text).
describe('cancelTransferAction (Program-Fix 15 PR C)', { retry: 0 }, () => {
  /** Paid through the real settlement transaction (stage1 + mocksettle rows). */
  async function paidInWindow(over: Partial<Transfer> = {}): Promise<void> {
    const t = transfer({ status: 'awaiting_payment', paidAt: undefined, ...over });
    await store.saveTransfer(t);
    await createTransferRepo(db).setFundingRef(t.id, 'fund-r');
    expect((await beginSettlement(db, t, { kyc: {}, payment: {}, whatsapp: {} })).kind).toBe('started');
  }
  const statusOf = async (id: string) => (await createTransferRepo(db).getTransfer(id))?.status;

  it('redirects to login when there is no session (self-gating)', async () => {
    sessionCustomer = null;
    await paidInWindow();
    await expect(cancelTransferAction(form({ transferId: 'tr_refund_1' }))).rejects.toThrow('REDIRECT:/account/login');
    expect(await statusOf('tr_refund_1')).toBe('paid');
  });

  it('owned, inside the window, nothing sent to the rail: cancels and redirects with cancel=cancelled', async () => {
    await paidInWindow();
    await expect(cancelTransferAction(form({ transferId: 'tr_refund_1' }))).rejects.toThrow(
      'REDIRECT:/account/receipt/tr_refund_1?cancel=cancelled',
    );
    expect(await statusOf('tr_refund_1')).toBe('cancelled');
    expect(await refundStatusOf('tr_refund_1')).toBe('pending');
    expect(revalidateMock).toHaveBeenCalledWith('/account/receipt/tr_refund_1');
    const audit = await db.execute(sql`SELECT action, meta FROM audit_events`);
    const rows = (audit as unknown as { rows: Array<{ action: string; meta: { via: string } }> }).rows;
    expect(rows.map((r) => r.action)).toEqual(['transfer.sender_cancel']);
    expect(rows[0].meta.via).toBe('receipt');
  });

  it('rail row already claimed: escalates and redirects with cancel=requested', async () => {
    await paidInWindow();
    await db.execute(sql`UPDATE outbox SET status = 'processing', attempts = 1, locked_at = now() WHERE dedupe_key = 'mocksettle:tr_refund_1'`);
    await expect(cancelTransferAction(form({ transferId: 'tr_refund_1' }))).rejects.toThrow(
      'REDIRECT:/account/receipt/tr_refund_1?cancel=requested',
    );
    expect(await statusOf('tr_refund_1')).toBe('paid');
    expect(await refundStatusOf('tr_refund_1')).toBe('requested');
  });

  it('past the window: redirects with cancel=closed and changes nothing', async () => {
    await paidInWindow();
    await db.execute(sql`UPDATE outbox SET created_at = now() - interval '31 minutes' WHERE dedupe_key = 'stage1:tr_refund_1'`);
    await expect(cancelTransferAction(form({ transferId: 'tr_refund_1' }))).rejects.toThrow(
      'REDIRECT:/account/receipt/tr_refund_1?cancel=closed',
    );
    expect(await statusOf('tr_refund_1')).toBe('paid');
    expect(await refundStatusOf('tr_refund_1')).toBe('none');
  });

  it("a stranger's transfer is refused like a missing one (404-never-403) and nothing moves", async () => {
    await paidInWindow({ phone: STRANGER });
    await expect(cancelTransferAction(form({ transferId: 'tr_refund_1' }))).rejects.toThrow(/not eligible/i);
    expect(await statusOf('tr_refund_1')).toBe('paid');
    await expect(cancelTransferAction(form({ transferId: 'does_not_exist' }))).rejects.toThrow(/not eligible/i);
  });

  it("another tenant's transfer with the same phone is refused (tenant-scoped)", async () => {
    await seedPartner(db, 'acme');
    await paidInWindow({ partnerId: 'acme' });
    await expect(cancelTransferAction(form({ transferId: 'tr_refund_1' }))).rejects.toThrow(/not eligible/i);
    expect(await statusOf('tr_refund_1')).toBe('paid');
  });

  it('49D step-up: an enrolled customer without a code is bounced with a fixed code and nothing moves', async () => {
    await paidInWindow();
    mfaEnrolled = true;
    sessionCustomer = customer({ mfaEnrolledAt: new Date().toISOString() });
    await expect(cancelTransferAction(form({ transferId: 'tr_refund_1' }))).rejects.toThrow(
      /REDIRECT:\/account\/receipt\/tr_refund_1\?error=mfa_/,
    );
    expect(await statusOf('tr_refund_1')).toBe('paid');
  });

  it('an already-cancelled transfer: redirects with cancel=ineligible', async () => {
    await paidInWindow();
    await expect(cancelTransferAction(form({ transferId: 'tr_refund_1' }))).rejects.toThrow(/cancel=cancelled/);
    await expect(cancelTransferAction(form({ transferId: 'tr_refund_1' }))).rejects.toThrow(
      'REDIRECT:/account/receipt/tr_refund_1?cancel=ineligible',
    );
  });
});
