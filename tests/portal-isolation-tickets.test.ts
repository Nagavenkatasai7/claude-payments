import { describe, it, expect, beforeEach } from 'vitest';
import type { Db } from '@/db/client';
import { freshDb } from './helpers-db';
import { seedTwoPartners, type TwoPartnerFixture } from './helpers-portal-two-partner';
import { createTicketRepo } from '@/db/repos/ticket-repo';

// UI redesign M2-12, Task 12.1: the tenant + customer scoped ticket reads the customer portal uses.
// Review Focus 1: ONE phone is a customer of partners A and B; A's host never lists, opens or counts
// B's ticket. Scoping is in the WHERE (partner, phone, kind), never a phone-only page filtered in JS.

const OTHER_PHONE = '14155550199';
let db: Db;
let A: TwoPartnerFixture;
let B: TwoPartnerFixture;
let phone: string;

beforeEach(async () => {
  db = await freshDb();
  ({ A, B, phone } = await seedTwoPartners(db));
});

describe('ticketRepo.listByCustomerInTenant', () => {
  it("A's list holds A's ticket only, never B's for the same phone", async () => {
    const repo = createTicketRepo(db);
    expect((await repo.listByCustomerInTenant('pa', phone)).map((t) => t.id)).toEqual(A.ticketIds);
    expect((await repo.listByCustomerInTenant('pb', phone)).map((t) => t.id)).toEqual(B.ticketIds);
  });

  it("another phone's ticket under the same partner is not listed", async () => {
    const repo = createTicketRepo(db);
    await repo.createTicket({ id: 'tk_other_phone_1', partnerId: 'pa', kind: 'customer', customerPhone: OTHER_PHONE, subject: 'Other', body: 'Another customer body' });
    expect((await repo.listByCustomerInTenant('pa', phone)).map((t) => t.id)).toEqual(A.ticketIds);
  });

  it('internal tickets are never listed, even with a matching phone field', async () => {
    const repo = createTicketRepo(db);
    await repo.createTicket({ id: 'tk_internal_1', partnerId: 'pa', kind: 'internal', openedBy: 'staff1', customerPhone: phone, subject: 'Internal', body: 'Staff-only question body' });
    expect((await repo.listByCustomerInTenant('pa', phone)).map((t) => t.id)).toEqual(A.ticketIds);
  });

  it('newest update first, bounded by the limit', async () => {
    const repo = createTicketRepo(db);
    await repo.createTicket({ id: 'tk_second_a', partnerId: 'pa', kind: 'customer', customerPhone: phone, subject: 'Second', body: 'Second ticket body' });
    await repo.appendMessage({ ticketId: 'tk_second_a', actorType: 'customer', actorId: phone, body: 'bump' });
    expect((await repo.listByCustomerInTenant('pa', phone)).map((t) => t.id)).toEqual(['tk_second_a', ...A.ticketIds]);
    expect(await repo.listByCustomerInTenant('pa', phone, 1)).toHaveLength(1);
  });
});

describe('ticketRepo.getCustomerTicketInTenant', () => {
  it("opens A's ticket on A; B's id on A is null, exactly like a missing id", async () => {
    const repo = createTicketRepo(db);
    expect((await repo.getCustomerTicketInTenant('pa', phone, A.ticketIds[0]))?.id).toBe(A.ticketIds[0]);
    expect(await repo.getCustomerTicketInTenant('pa', phone, B.ticketIds[0])).toBeNull();
    expect(await repo.getCustomerTicketInTenant('pa', phone, 'tk_does_not_exist')).toBeNull();
  });

  it("another phone's ticket and an internal ticket are null", async () => {
    const repo = createTicketRepo(db);
    await repo.createTicket({ id: 'tk_other_phone_2', partnerId: 'pa', kind: 'customer', customerPhone: OTHER_PHONE, subject: 'Other', body: 'Another customer body' });
    await repo.createTicket({ id: 'tk_internal_2', partnerId: 'pa', kind: 'internal', openedBy: 'staff1', customerPhone: phone, subject: 'Internal', body: 'Staff-only question body' });
    expect(await repo.getCustomerTicketInTenant('pa', phone, 'tk_other_phone_2')).toBeNull();
    expect(await repo.getCustomerTicketInTenant('pa', phone, 'tk_internal_2')).toBeNull();
  });
});

describe('ticketRepo.countOpenByCustomerInTenant', () => {
  it('counts only open/pending/waiting_admin customer tickets of THIS partner and phone', async () => {
    const repo = createTicketRepo(db);
    expect(await repo.countOpenByCustomerInTenant('pa', phone)).toBe(1);
    await repo.createTicket({ id: 'tk_a2', partnerId: 'pa', kind: 'customer', customerPhone: phone, subject: 'Two', body: 'Second ticket body' });
    await repo.createTicket({ id: 'tk_a3', partnerId: 'pa', kind: 'customer', customerPhone: phone, subject: 'Three', body: 'Third ticket body' });
    await repo.updateStatus('tk_a2', 'pending');
    await repo.updateStatus('tk_a3', 'resolved');
    expect(await repo.countOpenByCustomerInTenant('pa', phone)).toBe(2);
    // B's own open ticket never counts on A, and A's never on B.
    expect(await repo.countOpenByCustomerInTenant('pb', phone)).toBe(1);
    expect(await repo.countOpenByCustomerInTenant('pa', OTHER_PHONE)).toBe(0);
  });
});
