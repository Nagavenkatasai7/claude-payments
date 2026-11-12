import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import { fakeRedis } from './helpers';
import { regCaseFor } from './helpers-pack8';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { createStore } from '@/lib/store';
import { regDueAt, type RegClass } from '@/lib/reg-clocks';
import { caseSubject } from '@/lib/legal/error-notice-drafts';
import { openErrorNoticeCaseLocked, openRecallTicketLocked, type ErrorNoticeCaseInput } from '@/lib/receipt-cores';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

// Fix pack 8 T11 (R44, P8): the transfer-bound case writer. It runs in the CALLER's transaction and
// opens or reuses the ONE open case of a transfer and class (urgent, with a first notice and a due
// date, never refused by the open-ticket cap); with regClass null it is today's recall ticket path.

const PHONE = '15551239876';
const TX = 'T_case1';
let db: Db;

function transfer(id: string, partnerId = 'p1'): Transfer {
  const paid = new Date(Date.now() - 2 * 3600_000).toISOString();
  return {
    id, phone: PHONE, amountUsd: 100, feeUsd: 1, totalChargeUsd: 101, fxRate: 83, amountInr: 8300,
    recipientName: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'mom@upi',
    fundingMethod: 'bank_transfer', complianceStatus: 'cleared', complianceReasons: [], status: 'delivered',
    createdAt: new Date(Date.now() - 3 * 3600_000).toISOString(), paidAt: paid,
    deliveredAt: new Date(Date.now() - 3600_000).toISOString(), sourceCountry: 'US', sourceCurrency: 'USD',
    destinationCountry: 'IN', destinationCurrency: 'INR', partnerId, amountSource: 100, feeSource: 1,
    totalChargeSource: 101, transferType: 'b2c',
  } as Transfer;
}

function base(over: Partial<ErrorNoticeCaseInput> = {}): ErrorNoticeCaseInput {
  return {
    partnerId: 'p1', phone: PHONE, transferId: TX, regClass: 'error_notice', code: 'not_received',
    subject: caseSubject('not_received'), body: 'b', capScope: 'tenant', now: Date.now(), ...over,
  };
}

const run = (i: ErrorNoticeCaseInput) => db.transaction((tx) => openErrorNoticeCaseLocked(tx, i));

const recallInput = (over: { capScope?: 'tenant' | 'phone'; transferId?: string; partnerId?: string } = {}) => ({
  partnerId: over.partnerId ?? 'p1', phone: PHONE, transferId: over.transferId ?? TX,
  subject: 'Recall request: not_received', body: 'recall body', capScope: over.capScope ?? 'tenant',
});

async function ticketRow(id: string) {
  const r = await db.execute(sql`SELECT * FROM tickets WHERE id = ${id}`);
  return r.rows[0] as Record<string, unknown>;
}
async function ticketsOf(transferId = TX) {
  const r = await db.execute(sql`SELECT id, reg_class FROM tickets WHERE transfer_id = ${transferId} ORDER BY created_at, id`);
  return r.rows as Array<{ id: string; reg_class: string | null }>;
}
async function auditRows() {
  const r = await db.execute(
    sql`SELECT partner_id, actor, actor_type, subject_id, meta FROM audit_events WHERE action = 'ticket.reg_case.open' ORDER BY id`,
  );
  return r.rows as Array<{ partner_id: string; actor: string; actor_type: string; subject_id: string; meta: Record<string, unknown> }>;
}
async function triageKeys() {
  const r = await db.execute(sql`SELECT dedupe_key FROM outbox WHERE kind = 'ticket.triage' ORDER BY id`);
  return (r.rows as Array<{ dedupe_key: string }>).map((x) => x.dedupe_key);
}
async function systemNotes(ticketId: string) {
  const msgs = await createTicketRepo(db).listMessages(ticketId, { includeInternal: true });
  return msgs.filter((m) => m.actorType === 'system').map((m) => ({ body: m.body, internal: m.internal }));
}
const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : new Date(String(d)).toISOString());

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'p1');
  await seedPartner(db, 'p2');
  await createStore(fakeRedis(), db).saveTransfer(transfer(TX));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('openErrorNoticeCaseLocked (fix pack 8 P8)', () => {
  it('1. a classed case opens urgent with its clock', async () => {
    const now = Date.now();
    const r = await run(base({ now }));
    const dueAt = new Date(regDueAt('error_notice', now)).toISOString();
    expect(r).toMatchObject({ kind: 'opened', reused: false, classStamped: true, regClass: 'error_notice', dueAt });
    if (r.kind !== 'opened') throw new Error('unreachable');
    const row = await ticketRow(r.ticketId);
    expect(row).toMatchObject({ priority: 'urgent', category: 'refund', transfer_id: TX, reg_class: 'error_notice' });
    expect(iso(row.first_notice_at)).toBe(new Date(now).toISOString());
    expect(iso(row.due_at)).toBe(dueAt);
    expect(await triageKeys()).toEqual([`triage:${r.ticketId}`]);
    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ partner_id: 'p1', actor: 'system', actor_type: 'system', subject_id: r.ticketId });
    expect(audits[0].meta).toEqual({ regClass: 'error_notice', code: 'not_received', transferId: TX, dueAt, reused: false, stamped: true });
    expect(await systemNotes(r.ticketId)).toEqual([{ body: 'Class: error_notice.', internal: true }]);
    const msgs = await createTicketRepo(db).listMessages(r.ticketId, { includeInternal: false });
    expect(msgs.map((m) => m.body)).toEqual(['b']);
  });

  it('2. same transfer and class again -> reused, one note', async () => {
    const first = await run(base());
    if (first.kind !== 'opened') throw new Error('unreachable');
    const second = await run(base({ code: 'wrong_amount', subject: caseSubject('wrong_amount') }));
    expect(second).toEqual({ kind: 'opened', ticketId: first.ticketId, reused: true, regClass: 'error_notice', dueAt: first.dueAt, classStamped: false });
    await run(base({ code: 'wrong_amount', subject: caseSubject('wrong_amount') }));
    expect(await systemNotes(first.ticketId)).toEqual([
      { body: 'Class: error_notice.', internal: true },
      { body: 'Also reported: wrong_amount.', internal: true },
    ]);
    expect(await triageKeys()).toEqual([`triage:${first.ticketId}`]);
    expect(await auditRows()).toHaveLength(1);
    expect(await ticketsOf()).toHaveLength(1);
  });

  it('3. an open UNCLASSED recall on the transfer is stamped with its own createdAt as first notice', async () => {
    const recall = await openRecallTicketLocked(db, recallInput());
    if (recall.kind !== 'opened') throw new Error('unreachable');
    const createdAt = (await createTicketRepo(db).getTicket(recall.ticketId))!.createdAt;
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2 * 3600_000 });
    const r = await run(base({ now: Date.now() }));
    const dueAt = new Date(regDueAt('error_notice', Date.parse(createdAt))).toISOString();
    expect(r).toEqual({ kind: 'opened', ticketId: recall.ticketId, reused: true, regClass: 'error_notice', dueAt, classStamped: true });
    const row = await ticketRow(recall.ticketId);
    expect(row).toMatchObject({ reg_class: 'error_notice', priority: 'urgent' });
    expect(iso(row.first_notice_at)).toBe(createdAt);
    expect(iso(row.due_at)).toBe(dueAt);
    expect(await systemNotes(recall.ticketId)).toEqual([
      { body: 'Also reported: not_received.', internal: true },
      { body: 'Class: error_notice.', internal: true },
    ]);
    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0].meta).toMatchObject({ reused: true, stamped: true, dueAt, regClass: 'error_notice' });
  });

  it('4. an open case of ANOTHER class is not reused', async () => {
    const fraud = await regCaseFor(db, 'p1', { transferId: TX, regClass: 'fraud_report', phone: PHONE });
    const r = await run(base());
    if (r.kind !== 'opened') throw new Error('unreachable');
    expect(r.ticketId).not.toBe(fraud.id);
    expect(r).toMatchObject({ reused: false, classStamped: true, regClass: 'error_notice' });
    expect((await ticketsOf()).map((t) => t.reg_class).sort()).toEqual(['error_notice', 'fraud_report']);
  });

  it('5. the cap never refuses a regulatory case; regClass null hits the cap', async () => {
    const repo = createTicketRepo(db);
    for (let n = 0; n < 5; n++) {
      await repo.createTicket({ id: `tk_cap${n}`, partnerId: 'p1', kind: 'customer', customerPhone: PHONE, subject: `s${n}`, body: 'x' });
    }
    expect(await run(base({ regClass: null, code: 'other', subject: caseSubject('other') }))).toEqual({ kind: 'cap' });
    expect(await ticketsOf()).toHaveLength(0);
    const r = await run(base());
    expect(r).toMatchObject({ kind: 'opened', reused: false, classStamped: true });
    expect(await ticketsOf()).toHaveLength(1);
  });

  it("6. regClass null keeps today's path (no class, normal priority, phone cap across tenants, no audit)", async () => {
    const r = await run(base({ regClass: null, code: 'other', subject: caseSubject('other') }));
    expect(r).toMatchObject({ kind: 'opened', reused: false, regClass: null, dueAt: null, classStamped: false });
    if (r.kind !== 'opened') throw new Error('unreachable');
    const row = await ticketRow(r.ticketId);
    expect(row).toMatchObject({ subject: 'Recall request: other', priority: 'normal', reg_class: null, first_notice_at: null, due_at: null });
    const again = await run(base({ regClass: null, code: 'other', subject: caseSubject('other') }));
    expect(again).toEqual({ kind: 'opened', ticketId: r.ticketId, reused: true, regClass: null, dueAt: null, classStamped: false });
    expect(await systemNotes(r.ticketId)).toEqual([]);
    expect(await auditRows()).toHaveLength(0);

    // capScope 'phone' counts another tenant's open tickets (today's rule); 'tenant' does not.
    const tx2 = 'T_case2';
    await createStore(fakeRedis(), db).saveTransfer(transfer(tx2));
    const repo = createTicketRepo(db);
    for (let n = 0; n < 5; n++) {
      await repo.createTicket({ id: `tk_p2_${n}`, partnerId: 'p2', kind: 'customer', customerPhone: PHONE, subject: `s${n}`, body: 'x' });
    }
    const phoneCap = await run(base({ transferId: tx2, regClass: null, code: 'other', subject: caseSubject('other'), capScope: 'phone' }));
    expect(phoneCap).toEqual({ kind: 'cap' });
    const tenantCap = await run(base({ transferId: tx2, regClass: null, code: 'other', subject: caseSubject('other'), capScope: 'tenant' }));
    expect(tenantCap).toMatchObject({ kind: 'opened', reused: false });
  });

  it('7. one case under concurrency', async () => {
    const [a, b] = await Promise.all([
      run(base({ code: 'not_received' })),
      run(base({ code: 'wrong_amount', subject: caseSubject('wrong_amount') })),
    ]);
    if (a.kind !== 'opened' || b.kind !== 'opened') throw new Error('unreachable');
    expect(a.ticketId).toBe(b.ticketId);
    expect(await ticketsOf()).toHaveLength(1);
    const notes = (await systemNotes(a.ticketId)).filter((n) => n.body.startsWith('Also reported'));
    expect(notes.length).toBeLessThanOrEqual(1);
    expect(await auditRows()).toHaveLength(1);
  });

  for (const [first, second] of [
    ['error_notice', 'fraud_report'],
    ['error_notice', 'cancellation'],
  ] as Array<[RegClass, RegClass]>) {
    it(`7b/7c. two classes (${first}, ${second}) over one open unclassed recall -> one case per class`, async () => {
      const recall = await openRecallTicketLocked(db, recallInput());
      if (recall.kind !== 'opened') throw new Error('unreachable');
      const [a, b] = await Promise.all([run(base({ regClass: first })), run(base({ regClass: second, code: 'unauthorized' }))]);
      if (a.kind !== 'opened' || b.kind !== 'opened') throw new Error('unreachable');
      expect(a.classStamped).toBe(true);
      expect(b.classStamped).toBe(true);
      expect(a.ticketId).not.toBe(b.ticketId);
      expect([a.ticketId, b.ticketId]).toContain(recall.ticketId);
      const rows = await ticketsOf();
      expect(rows).toHaveLength(2);
      expect(rows.map((t) => t.reg_class).sort()).toEqual([first, second].sort());
      for (const t of rows) {
        const row = await ticketRow(t.id);
        expect(row.first_notice_at).not.toBeNull();
        expect(row.due_at).not.toBeNull();
      }
      const audits = await auditRows();
      expect(audits.map((x) => x.subject_id).sort()).toEqual([a.ticketId, b.ticketId].sort());
    });
  }

  it('8. a resolved or closed case is not reused', async () => {
    const first = await run(base());
    if (first.kind !== 'opened') throw new Error('unreachable');
    await createTicketRepo(db).updateStatus(first.ticketId, 'resolved');
    const second = await run(base());
    if (second.kind !== 'opened') throw new Error('unreachable');
    expect(second.ticketId).not.toBe(first.ticketId);
    expect(second).toMatchObject({ reused: false, classStamped: true });
    await createTicketRepo(db).updateStatus(second.ticketId, 'closed');
    const third = await run(base());
    if (third.kind !== 'opened') throw new Error('unreachable');
    expect([first.ticketId, second.ticketId]).not.toContain(third.ticketId);
  });

  it('9. the due date never moves later', async () => {
    const first = await run(base({ now: Date.now() }));
    if (first.kind !== 'opened') throw new Error('unreachable');
    const before = await ticketRow(first.ticketId);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 5 * 86_400_000 });
    const again = await run(base({ now: Date.now() }));
    expect(again).toMatchObject({ ticketId: first.ticketId, reused: true, dueAt: first.dueAt });
    const after = await ticketRow(first.ticketId);
    expect(iso(after.due_at)).toBe(iso(before.due_at));
    expect(iso(after.first_notice_at)).toBe(iso(before.first_notice_at));
  });

  it('10. rolls back with the caller', async () => {
    await expect(
      db.transaction(async (tx) => {
        await openErrorNoticeCaseLocked(tx, base());
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    expect(await ticketsOf()).toHaveLength(0);
    expect((await db.execute(sql`SELECT count(*)::int AS n FROM ticket_messages`)).rows[0]).toEqual({ n: 0 });
    expect((await db.execute(sql`SELECT count(*)::int AS n FROM outbox`)).rows[0]).toEqual({ n: 0 });
    expect(await auditRows()).toHaveLength(0);
  });

  it("11. nothing of the customer's words or phone in the audit row", async () => {
    await run(base({ body: 'my money never arrived, call 15551239876' }));
    const [a] = await auditRows();
    const s = JSON.stringify(a.meta);
    expect(s).not.toContain(PHONE);
    expect(s).not.toContain('never arrived');
    expect(a.actor).not.toContain(PHONE);
  });

  it('12. openRecallTicketLocked is unchanged', async () => {
    const a = await openRecallTicketLocked(db, recallInput());
    const b = await openRecallTicketLocked(db, recallInput());
    expect(a).toMatchObject({ kind: 'opened', reused: false });
    if (a.kind !== 'opened') throw new Error('unreachable');
    expect(b).toEqual({ kind: 'opened', ticketId: a.ticketId, reused: true });
    expect(Object.keys(a).sort()).toEqual(['kind', 'reused', 'ticketId']);
    const row = await ticketRow(a.ticketId);
    expect(row).toMatchObject({ priority: 'normal', category: 'refund', reg_class: null });
    expect(await systemNotes(a.ticketId)).toEqual([]);
    expect(await auditRows()).toHaveLength(0);
    expect(await triageKeys()).toEqual([`triage:${a.ticketId}`]);
  });
});
