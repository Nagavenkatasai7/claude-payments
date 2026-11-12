import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { regDueAt, type RegClass } from '@/lib/reg-clocks';
import type { Db, DbOrTx } from '@/db/client';

// Fix pack 8 T12 test 10 (P9 step 2): a lost stamp re-reads the ticket. A pass-through mock of the
// ticket repo lets a hook stamp the help case with fraud_report FIRST (as a concurrent report
// would), so openHelpCase's own stampRegClass returns false deterministically.

const hook = vi.hoisted(() => ({ cls: null as string | null, resolveOnFind: false }));

vi.mock('@/db/repos/ticket-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/ticket-repo')>();
  return {
    ...real,
    createTicketRepo: (db: DbOrTx, opts?: Parameters<typeof real.createTicketRepo>[1]) => {
      const repo = real.createTicketRepo(db, opts);
      return {
        ...repo,
        // F2 (FC2): staff resolve the found case between the writer's find and its write.
        async findOpenHumanHelpCase(...args: Parameters<typeof repo.findOpenHumanHelpCase>) {
          const found = await repo.findOpenHumanHelpCase(...args);
          if (found && hook.resolveOnFind) await repo.updateStatus(found.id, 'resolved');
          return found;
        },
        async stampRegClass(...args: Parameters<typeof repo.stampRegClass>) {
          if (hook.cls) {
            const [id, partnerId] = args;
            const at = Date.now();
            await repo.stampRegClass(id, partnerId, {
              regClass: hook.cls as RegClass,
              firstNoticeAt: new Date(at),
              dueAt: new Date(regDueAt(hook.cls as RegClass, at)),
            });
          }
          return repo.stampRegClass(...args);
        },
      };
    },
  };
});

import { createTicketRepo } from '@/db/repos/ticket-repo';
import { openHelpCase } from '@/lib/help-case';
import { HUMAN_HELP_CATEGORY, HUMAN_HELP_SUBJECT } from '@/lib/ticket-category';

const PHONE = '15551230043';
const base = { partnerId: 'default', phone: PHONE, channel: 'whatsapp', source: 'keyword' } as const;
let db: Db;

beforeEach(async () => {
  db = await freshDb();
  hook.cls = null;
  hook.resolveOnFind = false;
});

afterEach(() => {
  vi.useRealTimers();
});

const DAY = 86_400_000;
const iso = (v: unknown) => new Date(v as string).toISOString();
async function storedDue(id: string): Promise<string> {
  const r = await db.execute(sql`SELECT due_at FROM tickets WHERE id = ${id}`);
  return iso((r.rows[0] as { due_at: unknown }).due_at);
}

describe('openHelpCase: a lost stamp re-reads the ticket (P9, test 10)', () => {
  it('another class won the stamp -> the result carries the re-read class and due date, no audit row from this call', async () => {
    const a = await db.transaction((tx) => openHelpCase(tx, { ...base, reason: 'question' }));
    hook.cls = 'fraud_report';
    const b = await db.transaction((tx) => openHelpCase(tx, { ...base, reason: 'complaint' }));
    hook.cls = null;
    const t = await createTicketRepo(db).getTicket(a.caseId);
    expect(t!.regClass).toBe('fraud_report');
    // F1: the hook's fraud_report clock is the earlier one; the caller's complaint clock never moves it later.
    expect(Date.parse(t!.dueAt!)).toBeLessThanOrEqual(regDueAt('complaint', Date.now()));
    expect(await storedDue(a.caseId)).toBe(t!.dueAt);
    expect(b).toEqual({ caseId: a.caseId, partnerId: 'default', created: false, regClass: 'fraud_report', dueAt: t!.dueAt, caseCreatedOrStamped: false });
    const r = await db.execute(sql`SELECT count(*)::int AS n FROM audit_events WHERE action = 'ticket.reg_case.open'`);
    expect((r.rows[0] as { n: number }).n).toBe(0);
  });

  it('F1 (FC1): complaint wins the stamp, the caller reports unauthorised -> the earlier fraud_report due date, first class kept', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const firstMs = Date.now();
    const a = await db.transaction((tx) => openHelpCase(tx, { ...base, reason: 'question' }));
    hook.cls = 'complaint';
    const b = await db.transaction((tx) => openHelpCase(tx, { ...base, reason: 'unauthorised' }));
    hook.cls = null;
    const want = new Date(regDueAt('fraud_report', firstMs)).toISOString();
    expect(Date.parse(want)).toBeLessThan(regDueAt('complaint', firstMs));
    expect(b.regClass).toBe('complaint');
    expect(b.caseCreatedOrStamped).toBe(false);
    expect(b.dueAt).toBe(want);
    expect(await storedDue(a.caseId)).toBe(want);
    const r = await db.execute(sql`SELECT count(*)::int AS n FROM audit_events WHERE action = 'ticket.reg_case.open'`);
    expect((r.rows[0] as { n: number }).n).toBe(0);
  });

  it('F1 (FC1): an older classless case that recorded unauthorised -> the lost stamp tightens with the case createdAt clock', async () => {
    const id = 'tk_f1_old';
    await createTicketRepo(db).createTicket({
      id, partnerId: 'default', kind: 'customer', customerPhone: PHONE,
      subject: HUMAN_HELP_SUBJECT, body: 'Reason: unauthorised.', category: HUMAN_HELP_CATEGORY,
    });
    const createdAt = new Date(Date.now() - 6 * DAY);
    await db.execute(sql`UPDATE tickets SET created_at = ${createdAt.toISOString()}::timestamptz WHERE id = ${id}`);
    const t0 = await createTicketRepo(db).getTicket(id);
    expect(t0!.regClass).toBeUndefined();
    hook.cls = 'complaint';
    const b = await db.transaction((tx) => openHelpCase(tx, { ...base, reason: 'unauthorised' }));
    hook.cls = null;
    const want = new Date(regDueAt('fraud_report', Date.parse(t0!.createdAt))).toISOString();
    expect(b).toMatchObject({ caseId: id, created: false, regClass: 'complaint', caseCreatedOrStamped: false, dueAt: want });
    expect(await storedDue(id)).toBe(want);
  });
});

describe('openHelpCase: a case staff resolved after the find is never reused (F2, FC2)', () => {
  it('the found classless case is resolved in between -> a NEW complaint case; the resolved one is untouched', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const nowMs = Date.now();
    const a = await db.transaction((tx) => openHelpCase(tx, { ...base, reason: 'question' }));
    const repo = createTicketRepo(db);
    const msgsBefore = await repo.listMessages(a.caseId, { includeInternal: true });
    hook.resolveOnFind = true;
    const b = await db.transaction((tx) => openHelpCase(tx, { ...base, reason: 'complaint' }));
    hook.resolveOnFind = false;
    const old = await repo.getTicket(a.caseId);
    expect(old!.status).toBe('resolved');
    expect(old!.regClass).toBeUndefined();
    expect(old!.dueAt).toBeUndefined();
    expect(await repo.listMessages(a.caseId, { includeInternal: true })).toEqual(msgsBefore);
    expect(b.caseId).not.toBe(a.caseId);
    const due = new Date(regDueAt('complaint', nowMs)).toISOString();
    expect(b).toEqual({ caseId: b.caseId, partnerId: 'default', created: true, regClass: 'complaint', dueAt: due, caseCreatedOrStamped: true });
    const fresh = await repo.getTicket(b.caseId);
    expect(fresh).toMatchObject({ status: 'open', regClass: 'complaint', firstNoticeAt: new Date(nowMs).toISOString(), dueAt: due });
    const r = await db.execute(sql`SELECT subject_id, meta FROM audit_events WHERE action = 'ticket.reg_case.open'`);
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0] as { subject_id: string; meta: { reused: boolean } | string };
    expect(row.subject_id).toBe(b.caseId);
    const meta = typeof row.meta === 'string' ? JSON.parse(row.meta) : row.meta;
    expect(meta.reused).toBe(false);
  });
});
