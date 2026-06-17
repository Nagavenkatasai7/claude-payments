import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createStore, type Store } from '@/lib/store';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import { createTicketRepo, type TicketRepo } from '@/db/repos/ticket-repo';
import { RECALL_WINDOW_MS } from '@/lib/refund-policy';
import type { Db } from '@/db/client';
import type { Customer, Transfer } from '@/lib/types';

/**
 * Customer-facing recall/dispute action tests (receipt page, U5). The action is
 * a PUBLIC POST endpoint, so the suite drives it as a hostile client would:
 *  - delivered within the 24h window ⇒ opens a customer ticket linked to the
 *    transfer, with the SESSION partner/phone (hostile form fields ignored);
 *  - delivered but window elapsed ⇒ refused, no ticket;
 *  - not-yet-delivered (paid) ⇒ refused (recall is delivered-only);
 *  - someone else's transfer ⇒ refused 404-never-403, no ticket;
 *  - bad/empty reason ⇒ refused;
 *  - open-ticket cap ⇒ refused;
 *  - admin kill switch off ⇒ refused outright;
 *  - no session ⇒ redirect to /account/login.
 * The action NEVER moves money — it only opens a support ticket.
 */

const PHONE = '15551230000';
const OTHER_PHONE = '15559990000';

// Rebuilt per test (freshDb truncates pg); the hoisted vi.mock factories below
// only dereference these at call time.
let db: Db;
let store: Store;
let ps: PartnerStore;
let repo: TicketRepo;
let sessionCustomer: Customer | null = null;

// The signed-in customer belongs to partner p1 — NOT 'default' — so the hostile
// test proves the persisted partnerId comes from the session.
function customer(over: Partial<Customer> = {}): Customer {
  return {
    senderPhone: PHONE,
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    kycStatus: 'verified',
    senderCountry: 'US',
    partnerId: 'p1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as Customer;
}

const redirectMock = vi.fn((path: string) => {
  throw new Error(`REDIRECT:${path}`);
});
vi.mock('@/lib/customer-auth', () => ({
  requireCustomer: async () => {
    if (!sessionCustomer) redirectMock('/account/login');
    return sessionCustomer;
  },
}));
vi.mock('@/lib/store', async (orig) => ({ ...(await orig() as object), getStore: () => store }));
vi.mock('@/lib/partner-store', async (orig) => ({ ...(await orig() as object), getPartnerStore: () => ps }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig() as object), getDb: () => db }));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => redirectMock(p),
  notFound: () => { throw new Error('NOT_FOUND'); },
}));

import { requestRecallAction } from '@/app/account/receipt/recall-actions';

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

let n = 0;
function mkTransfer(over: Partial<Transfer> = {}): Transfer {
  n += 1;
  return {
    id: `T_${n}`, phone: PHONE, amountUsd: 100, feeUsd: 1.99, totalChargeUsd: 101.99,
    fxRate: 85.2, amountInr: 8520, recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'upi', payoutDestination: 'mom@upi', fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared', complianceReasons: [], status: 'delivered',
    // Relative dates — never hardcode dates that interact with time windows.
    createdAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
    paidAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
    deliveredAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    partnerId: 'p1',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 100, feeSource: 1.99, totalChargeSource: 101.99,
    ...over,
  } as Transfer;
}

async function seedTicket(over: { customerPhone?: string } = {}) {
  return repo.createTicket({
    id: `tk_seed${++n}`,
    partnerId: 'p1',
    kind: 'customer',
    customerPhone: over.customerPhone ?? PHONE,
    subject: 'seeded subject',
    body: 'seeded first message body',
  });
}

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'p1');
  store = createStore(fakeRedis(), db);
  ps = createPartnerStore(db);
  repo = createTicketRepo(db);
  sessionCustomer = customer();
  redirectMock.mockClear();
});

describe('requestRecallAction', () => {
  it('opens a ticket for a delivered transfer inside the 24h window — SESSION partner/phone, hostile form fields ignored', async () => {
    await store.saveTransfer(mkTransfer({ id: 'T_deliv' }));
    await expect(
      requestRecallAction(fd({
        transferId: 'T_deliv',
        reason: 'not_received',
        partnerId: 'default',       // hostile — must be ignored
        customerPhone: OTHER_PHONE, // hostile — must be ignored
      })),
    ).rejects.toThrow(/REDIRECT:\/account\/support\/tk_/);

    const mine = await repo.listByCustomer(PHONE);
    expect(mine).toHaveLength(1);
    expect(mine[0].partnerId).toBe('p1');
    expect(mine[0].customerPhone).toBe(PHONE);
    expect(mine[0].kind).toBe('customer');
    expect(mine[0].transferId).toBe('T_deliv');
    expect(mine[0].category).toBe('refund');
    expect(mine[0].subject).toBe('Recall request: not_received');
    expect(await repo.listByCustomer(OTHER_PHONE)).toEqual([]);
  });

  it('refuses a delivered transfer whose recall window has elapsed', async () => {
    await store.saveTransfer(mkTransfer({
      id: 'T_old',
      deliveredAt: new Date(Date.now() - (RECALL_WINDOW_MS + 60 * 1000)).toISOString(),
    }));
    await expect(requestRecallAction(fd({ transferId: 'T_old', reason: 'not_received' })))
      .rejects.toThrow('REDIRECT:/account/receipt/T_old?error=ineligible');
    expect(await repo.listByCustomer(PHONE)).toEqual([]);
  });

  it('refuses a not-yet-delivered (paid) transfer — recall is delivered-only', async () => {
    await store.saveTransfer(mkTransfer({ id: 'T_paid', status: 'paid', deliveredAt: undefined }));
    await expect(requestRecallAction(fd({ transferId: 'T_paid', reason: 'not_received' })))
      .rejects.toThrow('REDIRECT:/account/receipt/T_paid?error=ineligible');
    expect(await repo.listByCustomer(PHONE)).toEqual([]);
  });

  it("refuses another customer's transfer (404-never-403) — no ticket", async () => {
    await store.saveTransfer(mkTransfer({ id: 'T_theirs', phone: OTHER_PHONE }));
    await expect(requestRecallAction(fd({ transferId: 'T_theirs', reason: 'not_received' })))
      .rejects.toThrow('REDIRECT:/account/receipt/T_theirs?error=ineligible');
    expect(await repo.listByCustomer(PHONE)).toEqual([]);
  });

  it('refuses a missing transfer (indistinguishable from not-owned)', async () => {
    await expect(requestRecallAction(fd({ transferId: 'nope', reason: 'not_received' })))
      .rejects.toThrow('REDIRECT:/account/receipt/nope?error=ineligible');
  });

  it('refuses a bad/empty reason before touching the DB', async () => {
    await store.saveTransfer(mkTransfer({ id: 'T_r' }));
    await expect(requestRecallAction(fd({ transferId: 'T_r', reason: '' })))
      .rejects.toThrow('REDIRECT:/account/receipt/T_r?error=reason');
    await expect(requestRecallAction(fd({ transferId: 'T_r', reason: 'haxor' })))
      .rejects.toThrow('REDIRECT:/account/receipt/T_r?error=reason');
    expect(await repo.listByCustomer(PHONE)).toEqual([]);
  });

  it('refuses a transfer with a refund already in flight (refundStatus precedence)', async () => {
    // A delivered transfer normally qualifies, but a refund in the pipeline makes
    // refundDisposition return non-recall — isRecallEligible is false.
    await store.saveTransfer(mkTransfer({ id: 'T_ref', refundStatus: 'requested' }));
    await expect(requestRecallAction(fd({ transferId: 'T_ref', reason: 'not_received' })))
      .rejects.toThrow('REDIRECT:/account/receipt/T_ref?error=ineligible');
    expect(await repo.listByCustomer(PHONE)).toEqual([]);
  });

  it('caps at 5 OPEN tickets', async () => {
    await store.saveTransfer(mkTransfer({ id: 'T_cap' }));
    for (let i = 0; i < 5; i++) await seedTicket();
    await expect(requestRecallAction(fd({ transferId: 'T_cap', reason: 'not_received' })))
      .rejects.toThrow('REDIRECT:/account/receipt/T_cap?error=cap');
    expect(await repo.listByCustomer(PHONE)).toHaveLength(5);
  });

  it('admin kill switch off refuses outright (bounce to support landing)', async () => {
    await store.saveTransfer(mkTransfer({ id: 'T_off' }));
    const p1 = await ps.getPartner('p1');
    await ps.savePartner({
      ...p1!,
      supportConfig: { enableSupportPortal: false },
      updatedAt: new Date().toISOString(),
    });
    await expect(requestRecallAction(fd({ transferId: 'T_off', reason: 'not_received' })))
      .rejects.toThrow('REDIRECT:/account/support');
    expect(await repo.listByCustomer(PHONE)).toEqual([]);
  });

  it('redirects to login when there is no session (self-gating)', async () => {
    sessionCustomer = null;
    await store.saveTransfer(mkTransfer({ id: 'T_nosess' }));
    await expect(requestRecallAction(fd({ transferId: 'T_nosess', reason: 'not_received' })))
      .rejects.toThrow('REDIRECT:/account/login');
    expect(await repo.listByCustomer(PHONE)).toEqual([]);
  });
});
