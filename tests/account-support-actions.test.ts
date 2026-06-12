import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createStore, type Store } from '@/lib/store';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import { createTicketRepo, type TicketRepo } from '@/db/repos/ticket-repo';
import type { Db } from '@/db/client';
import type { Customer, Transfer } from '@/lib/types';

// /account/support server actions (B2) — PGlite + mocked customer session,
// the same recipe as account-verify-action.test.ts. The actions are PUBLIC
// POST endpoints, so the suite drives them exactly as a hostile client would:
// forged partner ids, someone else's phone/transfer/ticket, closed tickets.

const PHONE = '15551230000';
const OTHER_PHONE = '15559990000';

// Rebuilt per test in beforeEach (freshDb truncates the pg side); the hoisted
// vi.mock factories below only dereference these at call time.
let db: Db;
let store: Store;
let ps: PartnerStore;
let repo: TicketRepo;

// The signed-in customer belongs to partner p1 — NOT 'default' — so the
// hostile-form test can prove the persisted partnerId comes from the session.
const customer = {
  senderPhone: PHONE,
  firstSeenAt: '2026-01-01T00:00:00.000Z',
  kycStatus: 'pending',
  senderCountry: 'US',
  partnerId: 'p1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as Customer;

vi.mock('@/lib/customer-auth', () => ({ requireCustomer: async () => customer }));
vi.mock('@/lib/store', async (orig) => ({ ...(await orig() as object), getStore: () => store }));
vi.mock('@/lib/partner-store', async (orig) => ({ ...(await orig() as object), getPartnerStore: () => ps }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig() as object), getDb: () => db }));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => { throw new Error(`REDIRECT:${p}`); },
  notFound: () => { throw new Error('NOT_FOUND'); },
}));

import { createTicketAction, replyToTicketAction } from '@/app/account/support/actions';

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const VALID = { subject: 'Where is my money?', message: 'My transfer has not arrived yet.' };

let n = 0;
function mkTransfer(over: Partial<Transfer> = {}): Transfer {
  n += 1;
  return {
    id: `T_${n}`, phone: PHONE, amountUsd: 100, feeUsd: 1.99, totalChargeUsd: 101.99,
    fxRate: 85.2, amountInr: 8520, recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'upi', payoutDestination: 'mom@upi', fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared', complianceReasons: [], status: 'delivered',
    // Relative date — never hardcode dates that interact with time windows.
    createdAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(), partnerId: 'p1',
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
});

describe('createTicketAction', () => {
  it('persists ticket + first message with the SESSION partner/phone — hostile form fields ignored', async () => {
    await expect(
      createTicketAction(fd({
        ...VALID,
        partnerId: 'default',        // hostile — must be ignored
        customerPhone: OTHER_PHONE,  // hostile — must be ignored
      })),
    ).rejects.toThrow(/REDIRECT:\/account\/support\/tk_/);

    const mine = await repo.listByCustomer(PHONE);
    expect(mine).toHaveLength(1);
    expect(mine[0].id).toMatch(/^tk_/);
    expect(mine[0].partnerId).toBe('p1');
    expect(mine[0].customerPhone).toBe(PHONE);
    expect(mine[0].kind).toBe('customer');
    expect(mine[0].subject).toBe(VALID.subject);
    expect(mine[0].transferId).toBeUndefined();
    expect(await repo.listByCustomer(OTHER_PHONE)).toEqual([]);

    const msgs = await repo.listMessages(mine[0].id, { includeInternal: true });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ actorType: 'customer', actorId: PHONE, body: VALID.message, internal: false });
  });

  it('rejects out-of-bounds subject/message without writing anything', async () => {
    await expect(createTicketAction(fd({ subject: 'ab', message: VALID.message })))
      .rejects.toThrow('REDIRECT:/account/support/new?error=subject');
    await expect(createTicketAction(fd({ subject: VALID.subject, message: 'too short' })))
      .rejects.toThrow('REDIRECT:/account/support/new?error=message');
    expect(await repo.listByCustomer(PHONE)).toEqual([]);
  });

  it("transfer link: rejects another customer's transfer id; accepts the customer's own", async () => {
    await store.saveTransfer(mkTransfer({ id: 'T_mine', phone: PHONE }));
    await store.saveTransfer(mkTransfer({ id: 'T_theirs', phone: OTHER_PHONE }));

    await expect(createTicketAction(fd({ ...VALID, transferId: 'T_theirs' })))
      .rejects.toThrow('REDIRECT:/account/support/new?error=transfer');
    expect(await repo.listByCustomer(PHONE)).toEqual([]);

    await expect(createTicketAction(fd({ ...VALID, transferId: 'T_mine' })))
      .rejects.toThrow(/REDIRECT:\/account\/support\/tk_/);
    const mine = await repo.listByCustomer(PHONE);
    expect(mine).toHaveLength(1);
    expect(mine[0].transferId).toBe('T_mine');
  });

  it('caps at 5 OPEN tickets (open/pending/waiting_admin count; resolved does not)', async () => {
    const seeded = [];
    for (let i = 0; i < 5; i++) seeded.push(await seedTicket());
    // pending + waiting_admin still count against the cap.
    await repo.updateStatus(seeded[0].id, 'pending');
    await repo.updateStatus(seeded[1].id, 'waiting_admin');

    await expect(createTicketAction(fd(VALID)))
      .rejects.toThrow('REDIRECT:/account/support/new?error=cap');
    expect(await repo.listByCustomer(PHONE)).toHaveLength(5);

    // A resolved ticket frees a slot.
    await repo.updateStatus(seeded[2].id, 'resolved');
    await expect(createTicketAction(fd(VALID))).rejects.toThrow(/REDIRECT:\/account\/support\/tk_/);
    expect(await repo.listByCustomer(PHONE)).toHaveLength(6);
  });

  it('admin kill switch: enableSupportPortal=false refuses creates outright', async () => {
    const p1 = await ps.getPartner('p1');
    await ps.savePartner({
      ...p1!,
      supportConfig: { enableSupportPortal: false },
      updatedAt: new Date().toISOString(),
    });
    await expect(createTicketAction(fd(VALID))).rejects.toThrow('REDIRECT:/account/support');
    expect(await repo.listByCustomer(PHONE)).toEqual([]);
  });
});

describe('replyToTicketAction', () => {
  it("refuses another customer's ticket (404-never-403) — nothing written", async () => {
    const theirs = await seedTicket({ customerPhone: OTHER_PHONE });
    await expect(replyToTicketAction(theirs.id, fd({ message: 'let me in' })))
      .rejects.toThrow('NOT_FOUND');
    expect(await repo.listMessages(theirs.id, { includeInternal: true })).toHaveLength(1);
    expect((await repo.getTicket(theirs.id))?.status).toBe('open');
  });

  it('refuses internal tickets and missing ids identically', async () => {
    const internal = await repo.createTicket({
      id: 'tk_int1', partnerId: 'p1', kind: 'internal', openedBy: 'support1',
      subject: 'staff question', body: 'internal body',
    });
    await expect(replyToTicketAction(internal.id, fd({ message: 'hi' }))).rejects.toThrow('NOT_FOUND');
    await expect(replyToTicketAction('tk_nope', fd({ message: 'hi' }))).rejects.toThrow('NOT_FOUND');
    expect(await repo.listMessages(internal.id, { includeInternal: true })).toHaveLength(1);
  });

  it('appends a customer reply and flips pending → open (back into the staff queue)', async () => {
    const t = await seedTicket();
    await repo.updateStatus(t.id, 'pending');

    await expect(replyToTicketAction(t.id, fd({ message: 'Here is the info you asked for.' })))
      .rejects.toThrow(`REDIRECT:/account/support/${t.id}`);

    expect((await repo.getTicket(t.id))?.status).toBe('open');
    const msgs = await repo.listMessages(t.id, { includeInternal: true });
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toMatchObject({
      actorType: 'customer', actorId: PHONE, body: 'Here is the info you asked for.', internal: false,
    });
  });

  it('a reply on an already-open ticket leaves the status open', async () => {
    const t = await seedTicket();
    await expect(replyToTicketAction(t.id, fd({ message: 'one more detail' })))
      .rejects.toThrow(`REDIRECT:/account/support/${t.id}`);
    expect((await repo.getTicket(t.id))?.status).toBe('open');
  });

  it('closed tickets are read-only: the action refuses and writes nothing', async () => {
    const t = await seedTicket();
    await repo.updateStatus(t.id, 'closed');
    await expect(replyToTicketAction(t.id, fd({ message: 'hello?' })))
      .rejects.toThrow(`REDIRECT:/account/support/${t.id}?error=closed`);
    expect(await repo.listMessages(t.id, { includeInternal: true })).toHaveLength(1);
    expect((await repo.getTicket(t.id))?.status).toBe('closed');
  });

  it('rejects empty replies without writing', async () => {
    const t = await seedTicket();
    await expect(replyToTicketAction(t.id, fd({ message: '   ' })))
      .rejects.toThrow(`REDIRECT:/account/support/${t.id}?error=message`);
    expect(await repo.listMessages(t.id, { includeInternal: true })).toHaveLength(1);
  });
});

describe('customer thread read', () => {
  it('excludes internal notes — the includeInternal:false view the thread page uses', async () => {
    await expect(createTicketAction(fd(VALID))).rejects.toThrow(/REDIRECT:\/account\/support\/tk_/);
    const t = (await repo.listByCustomer(PHONE))[0];

    // Staff answer + an internal note, seeded via the repo directly.
    await repo.appendMessage({ ticketId: t.id, actorType: 'staff', actorId: 'sup1', body: 'public answer' });
    await repo.appendMessage({ ticketId: t.id, actorType: 'staff', actorId: 'sup1', body: 'SECRET internal note', internal: true });

    // Exactly the read the customer thread page performs.
    const customerView = await repo.listMessages(t.id, { includeInternal: false });
    expect(customerView.map((m) => m.body)).toEqual([VALID.message, 'public answer']);
    expect(customerView.some((m) => m.internal)).toBe(false);

    const staffView = await repo.listMessages(t.id, { includeInternal: true });
    expect(staffView).toHaveLength(3);
  });
});
