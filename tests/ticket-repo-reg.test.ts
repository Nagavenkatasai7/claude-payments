import { describe, it, expect, beforeEach, vi } from 'vitest';

// Fix pack 8 T7 (P6, R44): the ticket ledger's regulatory fields: create with a class and a
// clock, find an open case, stamp once, tighten the due date, the triage guard and the digest
// sweep. PGlite; dates relative to now.

const logSpy = vi.hoisted(() => ({ logWarn: vi.fn() }));
vi.mock('@/lib/log', async (orig) => {
  const real = await orig<typeof import('@/lib/log')>();
  logSpy.logWarn.mockImplementation(real.logWarn);
  return { ...real, logWarn: logSpy.logWarn };
});
import { freshDb, seedPartner } from './helpers-db';
import { seedPartnerTransfer } from './helpers-partner-app';
import { createTicketRepo, type TicketRepo } from '@/db/repos/ticket-repo';
import type { Db } from '@/db/client';
import { count, eq } from 'drizzle-orm';
import { tickets } from '@/db/schema';
import type { RegClass } from '@/lib/reg-clocks';
import type { TicketStatus } from '@/lib/types';

const DAY = 86_400_000;
const PHONE = '15551230000';

let db: Db;
let repo: TicketRepo;
let n = 0;
const tid = () => `tkr_${++n}`;

beforeEach(async () => {
  db = await freshDb();
  repo = createTicketRepo(db);
  await seedPartner(db, 'pa');
  await seedPartner(db, 'pb');
  await seedPartnerTransfer(db, { id: 't1', partnerId: 'pa' });
  await seedPartnerTransfer(db, { id: 't2', partnerId: 'pa' });
  await seedPartnerTransfer(db, { id: 'tb', partnerId: 'pb' });
  logSpy.logWarn.mockClear();
});

async function ticketCount(): Promise<number> {
  const [r] = await db.select({ n: count() }).from(tickets);
  return Number(r.n);
}

function regCase(o: {
  id?: string;
  partnerId?: string;
  transferId?: string;
  regClass?: RegClass;
  dueInMs?: number;
  phone?: string;
  kind?: 'customer' | 'internal';
}) {
  const now = Date.now();
  return repo.createTicket({
    id: o.id ?? tid(),
    partnerId: o.partnerId ?? 'pa',
    kind: o.kind ?? 'customer',
    ...(o.kind === 'internal' ? { openedBy: 's1' } : { customerPhone: o.phone ?? PHONE }),
    ...(o.transferId ? { transferId: o.transferId } : {}),
    subject: 's',
    body: 'b',
    regClass: o.regClass ?? 'error_notice',
    firstNoticeAt: new Date(now),
    dueAt: new Date(now + (o.dueInMs ?? 10 * DAY)),
  });
}

function plain(o: { id?: string; partnerId?: string; transferId?: string; phone?: string; category?: string } = {}) {
  return repo.createTicket({
    id: o.id ?? tid(),
    partnerId: o.partnerId ?? 'pa',
    kind: 'customer',
    customerPhone: o.phone ?? PHONE,
    ...(o.transferId ? { transferId: o.transferId } : {}),
    ...(o.category ? { category: o.category } : {}),
    subject: 's',
    body: 'b',
  });
}

async function setStatus(id: string, status: TicketStatus): Promise<void> {
  await db.update(tickets).set({ status }).where(eq(tickets.id, id));
}

async function rawRow(id: string) {
  const [r] = await db.select().from(tickets).where(eq(tickets.id, id));
  return r;
}

describe('ticket-repo reg — create', () => {
  it('create with a class writes it, the two dates and urgent priority', async () => {
    const first = new Date(Date.now() - DAY);
    const due = new Date(Date.now() + 5 * DAY);
    const t = await repo.createTicket({
      id: tid(), partnerId: 'pa', kind: 'customer', customerPhone: PHONE, transferId: 't1',
      subject: 's', body: 'b', priority: 'low',
      regClass: 'error_notice', firstNoticeAt: first, dueAt: due,
    });
    expect(t.priority).toBe('urgent');
    expect(t.regClass).toBe('error_notice');
    const read = await repo.getTicket(t.id);
    expect(read?.priority).toBe('urgent');
    expect(read?.regClass).toBe('error_notice');
    expect(read?.firstNoticeAt).toBe(first.toISOString());
    expect(read?.dueAt).toBe(due.toISOString());
  });

  it('create without a class is unchanged', async () => {
    const t = await plain();
    expect(t.priority).toBe('normal');
    expect('regClass' in t).toBe(false);
    expect('firstNoticeAt' in t).toBe(false);
    expect('dueAt' in t).toBe(false);
    const read = (await repo.getTicket(t.id))!;
    expect('regClass' in read).toBe(false);
    expect('firstNoticeAt' in read).toBe(false);
    expect('dueAt' in read).toBe(false);
  });

  it('a partial regulatory input or an unknown class throws before writing', async () => {
    const base = { partnerId: 'pa', kind: 'customer' as const, customerPhone: PHONE, subject: 's', body: 'b' };
    const msg = 'reg case needs class, first notice and due';
    await expect(repo.createTicket({ ...base, id: tid(), regClass: 'complaint' })).rejects.toThrow(new TypeError(msg));
    await expect(repo.createTicket({ ...base, id: tid(), regClass: 'complaint', firstNoticeAt: new Date() })).rejects.toThrow(TypeError);
    await expect(repo.createTicket({ ...base, id: tid(), firstNoticeAt: new Date(), dueAt: new Date() })).rejects.toThrow(msg);
    await expect(repo.createTicket({ ...base, id: tid(), dueAt: new Date() })).rejects.toThrow(msg);
    await expect(
      repo.createTicket({ ...base, id: tid(), regClass: 'other' as RegClass, firstNoticeAt: new Date(), dueAt: new Date() }),
    ).rejects.toThrow(msg);
    expect(await ticketCount()).toBe(0);
  });
});

describe('ticket-repo reg — findOpenRegCase', () => {
  it('finds the newest open case of that transfer and class under that tenant only', async () => {
    const older = await regCase({ transferId: 't1' });
    await new Promise((r) => setTimeout(r, 5));
    const newer = await regCase({ transferId: 't1' });
    expect((await repo.findOpenRegCase('pa', 't1', 'error_notice'))?.id).toBe(newer.id);
    await setStatus(newer.id, 'waiting_admin');
    expect((await repo.findOpenRegCase('pa', 't1', 'error_notice'))?.id).toBe(newer.id);
    await setStatus(newer.id, 'resolved');
    expect((await repo.findOpenRegCase('pa', 't1', 'error_notice'))?.id).toBe(older.id);
    await setStatus(older.id, 'closed');
    expect(await repo.findOpenRegCase('pa', 't1', 'error_notice')).toBeNull();
  });

  it('returns null for another class, transfer, tenant, an unclassed or an internal ticket', async () => {
    await regCase({ transferId: 't1', regClass: 'cancellation' });
    await regCase({ transferId: 't2' });
    await regCase({ partnerId: 'pb', transferId: 'tb' });
    await plain({ transferId: 't1' });
    await regCase({ transferId: 't1', kind: 'internal' });
    expect(await repo.findOpenRegCase('pa', 't1', 'error_notice')).toBeNull();
    expect(await repo.findOpenRegCase('pb', 't1', 'cancellation')).toBeNull();
    expect(await repo.findOpenRegCase('pa', 'tb', 'error_notice')).toBeNull();
  });
});

describe('ticket-repo reg — findOpenComplaintNoTransfer', () => {
  it('finds the open transfer-less complaint of that customer under that tenant only', async () => {
    await regCase({ regClass: 'complaint' });
    await new Promise((r) => setTimeout(r, 5));
    const newest = await regCase({ regClass: 'complaint' });
    expect((await repo.findOpenComplaintNoTransfer('pa', PHONE))?.id).toBe(newest.id);
  });

  it('returns null for every non-matching case', async () => {
    const resolved = await regCase({ regClass: 'complaint' });
    await setStatus(resolved.id, 'resolved');
    const closed = await regCase({ regClass: 'complaint' });
    await setStatus(closed.id, 'closed');
    await regCase({ regClass: 'complaint', transferId: 't1' });
    await regCase({ regClass: 'error_notice' });
    await regCase({ regClass: 'complaint', phone: '15559990000' });
    await regCase({ regClass: 'complaint', partnerId: 'pb' });
    await plain();
    await regCase({ regClass: 'complaint', kind: 'internal' });
    expect(await repo.findOpenComplaintNoTransfer('pa', PHONE)).toBeNull();
  });
});

describe('ticket-repo reg — stampRegClass', () => {
  it('stamps an unclassed case once', async () => {
    const t = await plain({ transferId: 't1' });
    expect(t.priority).toBe('normal');
    const first = new Date(Date.now() - DAY);
    const due = new Date(Date.now() + 5 * DAY);
    expect(await repo.stampRegClass(t.id, 'pa', { regClass: 'complaint', firstNoticeAt: first, dueAt: due })).toBe(true);
    const read = (await repo.getTicket(t.id))!;
    expect(read.regClass).toBe('complaint');
    expect(read.priority).toBe('urgent');
    expect(read.firstNoticeAt).toBe(first.toISOString());
    expect(read.dueAt).toBe(due.toISOString());

    expect(
      await repo.stampRegClass(t.id, 'pa', {
        regClass: 'fraud_report', firstNoticeAt: new Date(), dueAt: new Date(Date.now() + 30 * DAY),
      }),
    ).toBe(false);
    const again = (await repo.getTicket(t.id))!;
    expect(again.regClass).toBe('complaint');
    expect(again.firstNoticeAt).toBe(first.toISOString());
    expect(again.dueAt).toBe(due.toISOString());
  });

  it('is tenant-scoped', async () => {
    const t = await plain({ transferId: 't1' });
    const before = await rawRow(t.id);
    expect(
      await repo.stampRegClass(t.id, 'pb', { regClass: 'complaint', firstNoticeAt: new Date(), dueAt: new Date() }),
    ).toBe(false);
    const after = await rawRow(t.id);
    expect(after).toEqual(before);
  });

  it('F2 (FC2): a resolved or closed unclassed case is never stamped and nothing is written', async () => {
    for (const status of ['resolved', 'closed'] as const) {
      const t = await plain({ transferId: 't1' });
      await setStatus(t.id, status);
      const before = await rawRow(t.id);
      expect(
        await repo.stampRegClass(t.id, 'pa', { regClass: 'complaint', firstNoticeAt: new Date(), dueAt: new Date(Date.now() + DAY) }),
      ).toBe(false);
      expect(await rawRow(t.id)).toEqual(before);
    }
  });
});

describe('ticket-repo reg — lockOpenCase (F2, FC2)', () => {
  it('returns the fresh row for open, pending and waiting_admin', async () => {
    for (const status of ['open', 'pending', 'waiting_admin'] as const) {
      const t = await plain({ transferId: 't1' });
      await setStatus(t.id, status);
      const got = await db.transaction((tx) => createTicketRepo(tx).lockOpenCase(t.id, 'pa'));
      expect(got).toEqual(await repo.getTicket(t.id));
      expect(got?.status).toBe(status);
    }
  });

  it('returns null for resolved and closed, another tenant and an unknown id', async () => {
    const resolved = await plain({ transferId: 't1' });
    await setStatus(resolved.id, 'resolved');
    const closed = await plain({ transferId: 't1' });
    await setStatus(closed.id, 'closed');
    const open = await plain({ transferId: 't1' });
    expect(await repo.lockOpenCase(resolved.id, 'pa')).toBeNull();
    expect(await repo.lockOpenCase(closed.id, 'pa')).toBeNull();
    expect(await repo.lockOpenCase(open.id, 'pb')).toBeNull();
    expect(await repo.lockOpenCase('tk_unknown', 'pa')).toBeNull();
  });
});

describe('ticket-repo reg — setTriage guard', () => {
  it('keeps priority and category of a classed ticket and returns applied false', async () => {
    const t = await regCase({ transferId: 't1' });
    const res = await repo.setTriage(t.id, { category: 'delay', priority: 'low' });
    expect(res).toEqual({ applied: false });
    const read = (await repo.getTicket(t.id))!;
    expect(read.priority).toBe('urgent');
    expect(read.category).toBeUndefined();
  });

  it('still changes an unclassed ticket and returns applied true', async () => {
    const t = await plain();
    expect(await repo.setTriage(t.id, { category: 'delay', priority: 'low' })).toEqual({ applied: true });
    const read = (await repo.getTicket(t.id))!;
    expect(read.category).toBe('delay');
    expect(read.priority).toBe('low');
  });

  it('keeps the mfa_recovery category (priority still applies)', async () => {
    const t = await plain({ category: 'mfa_recovery' });
    expect(await repo.setTriage(t.id, { category: 'refund', priority: 'low' })).toEqual({ applied: true });
    const read = (await repo.getTicket(t.id))!;
    expect(read.category).toBe('mfa_recovery');
    expect(read.priority).toBe('low');
  });

  it('a missing id returns applied false', async () => {
    expect(await repo.setTriage('nope', { category: 'x', priority: 'low' })).toEqual({ applied: false });
  });
});

describe('ticket-repo reg — listRegClockDue', () => {
  it('counts only open statuses and returns ids oldest due first', async () => {
    const overdue = await regCase({ dueInMs: -2 * DAY });
    const soon = await regCase({ dueInMs: 1 * DAY });
    await regCase({ dueInMs: 2 * DAY, regClass: 'complaint' });
    await regCase({ dueInMs: 10 * DAY });
    const resolved = await regCase({ dueInMs: -1 * DAY });
    await setStatus(resolved.id, 'resolved');
    expect((await rawRow(resolved.id)).closedAt).toBeNull();
    await plain();
    const out = await repo.listRegClockDue({ now: new Date(), withinMs: 3 * DAY, limit: 2 });
    expect(out).toEqual({ total: 3, overdue: 1, ids: [overdue.id, soon.id] });
  });

  it('is platform-wide and returns no other field', async () => {
    const a = await regCase({ dueInMs: 1 * DAY });
    const b = await regCase({ partnerId: 'pb', dueInMs: 2 * DAY });
    const out = await repo.listRegClockDue({ now: new Date(), withinMs: 3 * DAY });
    expect(out).toEqual({ total: 2, overdue: 0, ids: [a.id, b.id] });
    expect(Object.keys(out).sort()).toEqual(['ids', 'overdue', 'total']);
  });

  it('is empty when nothing is due', async () => {
    await regCase({ dueInMs: 10 * DAY });
    expect(await repo.listRegClockDue({ now: new Date(), withinMs: 3 * DAY })).toEqual({ total: 0, overdue: 0, ids: [] });
  });
});

describe('ticket-repo reg — rowToTicket', () => {
  it('drops an unknown reg_class text', async () => {
    const t = await regCase({ transferId: 't1' });
    await db.update(tickets).set({ regClass: 'zzz' }).where(eq(tickets.id, t.id));
    logSpy.logWarn.mockClear();
    const read = (await repo.getTicket(t.id))!;
    expect('regClass' in read).toBe(false);
    expect(logSpy.logWarn).toHaveBeenCalledTimes(1);
    expect(logSpy.logWarn).toHaveBeenCalledWith('ticket.reg_class_unknown', 'unknown class', { ticketId: t.id });
  });
});

describe('ticket-repo reg — tightenDueAt', () => {
  it('never moves a due date later', async () => {
    const t = await regCase({ transferId: 't1', dueInMs: 10 * DAY });
    const d3 = new Date(Date.now() + 3 * DAY);
    await repo.tightenDueAt(t.id, 'pa', d3);
    expect((await repo.getTicket(t.id))?.dueAt).toBe(d3.toISOString());
    await repo.tightenDueAt(t.id, 'pa', new Date(Date.now() + 5 * DAY));
    expect((await repo.getTicket(t.id))?.dueAt).toBe(d3.toISOString());
    await repo.tightenDueAt(t.id, 'pb', new Date(Date.now() + 1 * DAY));
    expect((await repo.getTicket(t.id))?.dueAt).toBe(d3.toISOString());
  });

  it('writes nothing on an unclassed ticket', async () => {
    const t = await plain();
    const before = await rawRow(t.id);
    await new Promise((r) => setTimeout(r, 5));
    await repo.tightenDueAt(t.id, 'pa', new Date(Date.now() + DAY));
    const after = await rawRow(t.id);
    expect(after.dueAt).toBeNull();
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });
});
