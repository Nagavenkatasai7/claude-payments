import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb, seedPartner } from './helpers-db';
import { createTicketRepo, type TicketRepo } from '@/db/repos/ticket-repo';
import type { Db } from '@/db/client';

let db: Db;
let repo: TicketRepo;
let n = 0;
const tid = () => `tk_${++n}`;

beforeEach(async () => {
  db = await freshDb();
  repo = createTicketRepo(db);
  await seedPartner(db, 'p1');
  await seedPartner(db, 'p2');
});

describe('ticket-repo — create + read', () => {
  it('creates a customer ticket with its first message in one shot', async () => {
    const t = await repo.createTicket({
      id: tid(), partnerId: 'default', kind: 'customer', customerPhone: '15551230000',
      subject: 'Where is my money?', body: 'My transfer to Anita has not arrived.',
    });
    expect(t.status).toBe('open');
    expect(t.priority).toBe('normal');
    const msgs = await repo.listMessages(t.id, { includeInternal: true });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].actorType).toBe('customer');
    expect(msgs[0].actorId).toBe('15551230000');
  });

  it('creates an internal (employee question) ticket attributed to the staff member', async () => {
    const t = await repo.createTicket({
      id: tid(), partnerId: 'default', kind: 'internal', openedBy: 'support1',
      subject: 'How do I handle a chargeback question?', body: 'Customer asked about chargebacks.',
    });
    expect(t.kind).toBe('internal');
    expect(t.customerPhone).toBe('');
    expect(t.openedBy).toBe('support1');
    const msgs = await repo.listMessages(t.id, { includeInternal: true });
    expect(msgs[0].actorType).toBe('staff');
  });

  it('getOwnedTicket is 404-never-403: out-of-scope partner reads null', async () => {
    const t = await repo.createTicket({
      id: tid(), partnerId: 'p1', kind: 'customer', customerPhone: '15551230000',
      subject: 's', body: 'b',
    });
    expect(await repo.getOwnedTicket('p1', t.id)).not.toBeNull();
    expect(await repo.getOwnedTicket('p2', t.id)).toBeNull();
  });
});

describe('ticket-repo — tenant + customer scoping', () => {
  it('listTickets scoped by partner never returns another tenant', async () => {
    await repo.createTicket({ id: tid(), partnerId: 'p1', kind: 'customer', customerPhone: '1', subject: 'a', body: 'a' });
    await repo.createTicket({ id: tid(), partnerId: 'p2', kind: 'customer', customerPhone: '2', subject: 'b', body: 'b' });
    const p1 = await repo.listTickets({ partnerId: 'p1' });
    expect(p1).toHaveLength(1);
    expect(p1[0].partnerId).toBe('p1');
    // platform view (no partnerId) sees both
    expect(await repo.listTickets({})).toHaveLength(2);
  });

  it('listByCustomer returns only that phone, customer kind only', async () => {
    await repo.createTicket({ id: tid(), partnerId: 'default', kind: 'customer', customerPhone: '15551230000', subject: 'mine', body: 'x' });
    await repo.createTicket({ id: tid(), partnerId: 'default', kind: 'customer', customerPhone: '15559990000', subject: 'theirs', body: 'x' });
    await repo.createTicket({ id: tid(), partnerId: 'default', kind: 'internal', openedBy: 's1', subject: 'internal', body: 'x' });
    const mine = await repo.listByCustomer('15551230000');
    expect(mine).toHaveLength(1);
    expect(mine[0].subject).toBe('mine');
  });

  it('CUSTOMER thread reads NEVER include internal notes', async () => {
    const t = await repo.createTicket({
      id: tid(), partnerId: 'default', kind: 'customer', customerPhone: '15551230000',
      subject: 's', body: 'customer message',
    });
    await repo.appendMessage({ ticketId: t.id, actorType: 'staff', actorId: 'sup1', body: 'public reply' });
    await repo.appendMessage({ ticketId: t.id, actorType: 'staff', actorId: 'sup1', body: 'SECRET internal note', internal: true });
    const customerView = await repo.listMessages(t.id, { includeInternal: false });
    expect(customerView.map((m) => m.body)).toEqual(['customer message', 'public reply']);
    const staffView = await repo.listMessages(t.id, { includeInternal: true });
    expect(staffView).toHaveLength(3);
  });
});

describe('ticket-repo — lifecycle', () => {
  it('status transitions: open→pending→waiting_admin→resolved→closed; closed is terminal', async () => {
    const t = await repo.createTicket({ id: tid(), partnerId: 'default', kind: 'customer', customerPhone: '1', subject: 's', body: 'b' });
    expect((await repo.updateStatus(t.id, 'pending'))?.status).toBe('pending');
    expect((await repo.updateStatus(t.id, 'waiting_admin'))?.status).toBe('waiting_admin');
    expect((await repo.updateStatus(t.id, 'resolved'))?.status).toBe('resolved');
    const closed = await repo.updateStatus(t.id, 'closed');
    expect(closed?.status).toBe('closed');
    expect(closed?.closedAt).toBeTruthy();
    // terminal: nothing moves a closed ticket
    expect(await repo.updateStatus(t.id, 'open')).toBeNull();
    expect(await repo.assign(t.id, 'sup1')).toBeNull();
  });

  it('same-state transition is a no-op returning null', async () => {
    const t = await repo.createTicket({ id: tid(), partnerId: 'default', kind: 'customer', customerPhone: '1', subject: 's', body: 'b' });
    expect(await repo.updateStatus(t.id, 'open')).toBeNull();
  });

  it('assign + appendMessage bump updatedAt (queue ordering + stamp)', async () => {
    const t = await repo.createTicket({ id: tid(), partnerId: 'default', kind: 'customer', customerPhone: '1', subject: 's', body: 'b' });
    const before = (await repo.getTicket(t.id))!.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await repo.appendMessage({ ticketId: t.id, actorType: 'staff', actorId: 'sup1', body: 'r' });
    const after = (await repo.getTicket(t.id))!.updatedAt;
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
  });

  it('setTriage stores AI/staff category + priority', async () => {
    const t = await repo.createTicket({ id: tid(), partnerId: 'default', kind: 'customer', customerPhone: '1', subject: 's', body: 'b' });
    await repo.setTriage(t.id, { category: 'refund', priority: 'urgent' });
    const read = await repo.getTicket(t.id);
    expect(read?.category).toBe('refund');
    expect(read?.priority).toBe('urgent');
  });
});

describe('ticket-repo — aggregates', () => {
  it('countsByStatus + ticketStamp change when tickets move', async () => {
    const t = await repo.createTicket({ id: tid(), partnerId: 'p1', kind: 'customer', customerPhone: '1', subject: 's', body: 'b' });
    await repo.createTicket({ id: tid(), partnerId: 'p1', kind: 'customer', customerPhone: '2', subject: 's2', body: 'b' });
    expect((await repo.countsByStatus('p1')).open).toBe(2);
    const stamp1 = await repo.ticketStamp('p1');
    await new Promise((r) => setTimeout(r, 5));
    await repo.updateStatus(t.id, 'resolved');
    const counts = await repo.countsByStatus('p1');
    expect(counts.open).toBe(1);
    expect(counts.resolved).toBe(1);
    expect(await repo.ticketStamp('p1')).not.toBe(stamp1);
    // scoped stamp ignores other tenants
    expect(await repo.ticketStamp('p2')).toBe('0|');
  });
});
