import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { addRegBusinessDays, regDueAt } from '@/lib/reg-clocks';
import type { Db } from '@/db/client';

// Fix pack 8 T12 (R44, P9): a help case opened or reused with the reason 'complaint' gets the
// class complaint, with 'unauthorised' the class fraud_report: urgent, a first notice and a due
// date (reg-clocks), one ticket.reg_case.open audit row. A classed case keeps its first class and
// only ever takes the EARLIER due date; every other reason keeps today's exact case.

const events = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock('@/lib/outbox', async (orig) => ({
  ...(await orig<typeof import('@/lib/outbox')>()),
  pokeWorker: () => {
    events.list.push('poke');
  },
}));

import { openHelpCase, openHelpCaseAndPoke, type HelpCaseReason } from '@/lib/help-case';

const PHONE = '15551230042';
const base = { partnerId: 'default', phone: PHONE, channel: 'whatsapp', source: 'keyword' } as const;
const DAY = 86_400_000;
let db: Db;

const open = (reason: HelpCaseReason, partnerId = 'default') =>
  db.transaction((tx) => openHelpCase(tx, { ...base, partnerId, reason }));

async function ticketRow(id: string) {
  const r = await db.execute(sql`SELECT priority, category, reg_class, first_notice_at, due_at, created_at FROM tickets WHERE id = ${id}`);
  return r.rows[0] as Record<string, unknown>;
}
async function auditRows() {
  const r = await db.execute(
    sql`SELECT partner_id, actor, actor_type, subject_id, meta FROM audit_events WHERE action = 'ticket.reg_case.open' ORDER BY id`,
  );
  return r.rows as Array<{ partner_id: string; actor: string; actor_type: string; subject_id: string; meta: Record<string, unknown> }>;
}
async function outboxKeys(kind: string) {
  const r = await db.execute(sql`SELECT dedupe_key FROM outbox WHERE kind = ${kind} ORDER BY id`);
  return (r.rows as Array<{ dedupe_key: string }>).map((x) => x.dedupe_key);
}
async function systemNotes(id: string) {
  return (await createTicketRepo(db).listMessages(id, { includeInternal: true })).filter((m) => m.actorType === 'system');
}
const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : new Date(String(d)).toISOString());
const ms = (d: unknown) => new Date(iso(d)).getTime();

beforeEach(async () => {
  db = await freshDb();
  events.list = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('openHelpCase: a classed reason opens a regulatory case (P9 step 1)', () => {
  it('a complaint opens a classed, urgent case', async () => {
    const before = Date.now();
    const r = await open('complaint');
    const after = Date.now();
    const row = await ticketRow(r.caseId);
    expect(row).toMatchObject({ priority: 'urgent', category: 'human_help', reg_class: 'complaint' });
    const first = ms(row.first_notice_at);
    expect(first).toBeGreaterThanOrEqual(before);
    expect(first).toBeLessThanOrEqual(after);
    expect(ms(row.due_at)).toBe(regDueAt('complaint', first));
    expect(ms(row.due_at)).toBe(first + 15 * DAY);
    const dueAt = iso(row.due_at);
    expect(r).toEqual({ caseId: r.caseId, partnerId: 'default', created: true, regClass: 'complaint', dueAt, caseCreatedOrStamped: true });
    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ partner_id: 'default', actor: 'system', actor_type: 'system', subject_id: r.caseId });
    expect(audits[0].meta).toEqual({ regClass: 'complaint', code: 'complaint', dueAt, reused: false, stamped: true });
    expect(JSON.stringify(audits[0].meta)).not.toContain(PHONE);
  });

  it('an unauthorised report opens fraud_report', async () => {
    const r = await open('unauthorised');
    const row = await ticketRow(r.caseId);
    expect(row).toMatchObject({ priority: 'urgent', reg_class: 'fraud_report' });
    expect(ms(row.due_at)).toBe(addRegBusinessDays(ms(row.first_notice_at), 10));
    expect(r).toMatchObject({ created: true, regClass: 'fraud_report', dueAt: iso(row.due_at), caseCreatedOrStamped: true });
    const audits = await auditRows();
    expect(audits.map((a) => a.meta)).toEqual([{ regClass: 'fraud_report', code: 'unauthorized', dueAt: iso(row.due_at), reused: false, stamped: true }]);
  });

  it.each(['question', 'other', 'payment_problem', 'account_access', 'cancel_request'] as const)(
    '%s opens NO class (today\'s exact case)',
    async (reason) => {
      const r = await open(reason);
      expect(r).toEqual({ caseId: r.caseId, partnerId: 'default', created: true });
      const row = await ticketRow(r.caseId);
      expect(row).toMatchObject({ priority: 'normal', reg_class: null, first_notice_at: null, due_at: null });
      expect(await auditRows()).toEqual([]);
    },
  );
});

describe('openHelpCase: a reused case (P9 steps 2 and 3)', () => {
  it('question then complaint stamps the open case', async () => {
    const a = await open('question');
    const t0 = Date.now();
    const b = await open('complaint');
    expect(b.caseId).toBe(a.caseId);
    const row = await ticketRow(a.caseId);
    expect(row).toMatchObject({ priority: 'urgent', reg_class: 'complaint' });
    // The first report was a question: the complaint's first notice is now.
    expect(ms(row.first_notice_at)).toBeGreaterThanOrEqual(t0);
    expect(ms(row.due_at)).toBe(regDueAt('complaint', ms(row.first_notice_at)));
    expect(b).toEqual({ caseId: a.caseId, partnerId: 'default', created: false, regClass: 'complaint', dueAt: iso(row.due_at), caseCreatedOrStamped: true });
    const audits = await auditRows();
    expect(audits.map((x) => x.meta)).toEqual([{ regClass: 'complaint', code: 'complaint', dueAt: iso(row.due_at), reused: true, stamped: true }]);
    // Today's escalation is unchanged.
    expect((await systemNotes(a.caseId)).map((m) => m.body)).toEqual([expect.stringMatching(/^Also reported: complaint\./)]);
    expect(await outboxKeys('ops.alert')).toEqual([`help:${a.caseId}`, `help:${a.caseId}:complaint`]);
  });

  it('a classless case that already records the reason is stamped from its createdAt', async () => {
    const a = await open('complaint');
    // As a pack 7 build would have left it: the same case without a class.
    await db.execute(sql`UPDATE tickets SET reg_class = NULL, first_notice_at = NULL, due_at = NULL WHERE id = ${a.caseId}`);
    const createdAt = (await createTicketRepo(db).getTicket(a.caseId))!.createdAt;
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2 * 3600_000 });
    const b = await open('complaint');
    const row = await ticketRow(a.caseId);
    expect(iso(row.first_notice_at)).toBe(createdAt);
    expect(ms(row.due_at)).toBe(regDueAt('complaint', ms(createdAt)));
    expect(b).toEqual({ caseId: a.caseId, partnerId: 'default', created: false, regClass: 'complaint', dueAt: iso(row.due_at), caseCreatedOrStamped: true });
    // audit_events is append-only: the first row is the opening call's; this call adds ONE.
    const audits = await auditRows();
    expect(audits).toHaveLength(2);
    expect(audits[1].meta).toEqual({ regClass: 'complaint', code: 'complaint', dueAt: iso(row.due_at), reused: true, stamped: true });
    // The reason is already recorded: no new note, alert or triage (today's rule).
    expect(await systemNotes(a.caseId)).toEqual([]);
    expect(await outboxKeys('ops.alert')).toEqual([`help:${a.caseId}`]);
    expect(await outboxKeys('ticket.triage')).toEqual([`triage:${a.caseId}`]);
  });

  it('complaint then unauthorised keeps the first class and takes the EARLIER due date', async () => {
    const a = await open('complaint');
    const complaintDue = ms((await ticketRow(a.caseId)).due_at);
    const t0 = Date.now();
    const b = await open('unauthorised');
    const t1 = Date.now();
    const row = await ticketRow(a.caseId);
    expect(row.reg_class).toBe('complaint');
    const due = ms(row.due_at);
    // min(complaint due, now + 10 business days) for a "now" inside the call.
    expect(due).toBeLessThanOrEqual(complaintDue);
    expect(due).toBeGreaterThanOrEqual(Math.min(complaintDue, addRegBusinessDays(t0, 10)));
    expect(due).toBeLessThanOrEqual(Math.min(complaintDue, addRegBusinessDays(t1, 10)));
    expect(b).toEqual({ caseId: a.caseId, partnerId: 'default', created: false, regClass: 'complaint', dueAt: iso(row.due_at), caseCreatedOrStamped: false });
    expect((await systemNotes(a.caseId)).map((m) => m.body)).toEqual([expect.stringMatching(/^Also reported: unauthorised\./)]);
    expect(await auditRows()).toHaveLength(1);
    expect(await outboxKeys('partner.event')).toEqual([]);
  });

  it('unauthorised then complaint never moves the due date later', async () => {
    const a = await open('unauthorised');
    const first = await ticketRow(a.caseId);
    const b = await open('complaint');
    const row = await ticketRow(a.caseId);
    expect(row.reg_class).toBe('fraud_report');
    expect(iso(row.due_at)).toBe(iso(first.due_at));
    expect(ms(row.due_at)).toBe(addRegBusinessDays(ms(first.first_notice_at), 10));
    expect(b).toMatchObject({ created: false, regClass: 'fraud_report', dueAt: iso(first.due_at), caseCreatedOrStamped: false });
    expect(await auditRows()).toHaveLength(1);
  });

  it('complaint twice: reused, nothing new', async () => {
    const a = await open('complaint');
    const first = await ticketRow(a.caseId);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 5 * DAY });
    const b = await open('complaint');
    const row = await ticketRow(a.caseId);
    expect(iso(row.due_at)).toBe(iso(first.due_at));
    expect(b).toEqual({ caseId: a.caseId, partnerId: 'default', created: false, regClass: 'complaint', dueAt: iso(first.due_at), caseCreatedOrStamped: false });
    expect(await systemNotes(a.caseId)).toEqual([]);
    expect(await auditRows()).toHaveLength(1);
  });
});

describe('openHelpCase: transaction, tenant and poke', () => {
  it('rollback: the caller transaction throws after openHelpCase -> no ticket, no audit, no outbox row', async () => {
    await expect(
      db.transaction(async (tx) => {
        await openHelpCase(tx, { ...base, reason: 'complaint' });
        throw new Error('reply enqueue failed');
      }),
    ).rejects.toThrow('reply enqueue failed');
    expect(await createTicketRepo(db).listByCustomer(PHONE)).toEqual([]);
    expect(await auditRows()).toEqual([]);
    const r = await db.execute(sql`SELECT count(*)::int AS n FROM outbox`);
    expect((r.rows[0] as { n: number }).n).toBe(0);
  });

  it("tenant scope: a classed open case under 'acme' is never stamped or reused by a 'default' call", async () => {
    await seedPartner(db, 'acme');
    const theirs = await open('question', 'acme');
    const mine = await open('complaint');
    expect(mine.caseId).not.toBe(theirs.caseId);
    expect(mine).toMatchObject({ partnerId: 'default', created: true, regClass: 'complaint', caseCreatedOrStamped: true });
    expect((await ticketRow(theirs.caseId)).reg_class).toBeNull();
    const theirsClassed = await open('unauthorised', 'acme');
    expect(theirsClassed.caseId).toBe(theirs.caseId);
    const again = await open('complaint');
    expect(again).toMatchObject({ caseId: mine.caseId, created: false, regClass: 'complaint', caseCreatedOrStamped: false });
    expect((await ticketRow(theirs.caseId)).reg_class).toBe('fraud_report');
    expect((await auditRows()).map((a) => [a.partner_id, a.subject_id])).toEqual([
      ['default', mine.caseId],
      ['acme', theirs.caseId],
    ]);
  });

  it('openHelpCaseAndPoke still pokes after the commit with a complaint', async () => {
    const real = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementation((async (fn: Parameters<Db['transaction']>[0]) => {
      const out = await real(fn);
      events.list.push('commit');
      return out;
    }) as Db['transaction']);
    const r = await openHelpCaseAndPoke(db, { ...base, reason: 'complaint' });
    expect(r).toMatchObject({ created: true, regClass: 'complaint', caseCreatedOrStamped: true });
    expect(events.list).toEqual(['commit', 'poke']);
  });
});
