import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import { fakeRedis } from './helpers';
import { createStore } from '@/lib/store';
import { regDueAt, type RegClass } from '@/lib/reg-clocks';
import { caseSubject } from '@/lib/legal/error-notice-drafts';
import type { Db, DbOrTx } from '@/db/client';
import type { Transfer } from '@/lib/types';

// Fix pack 8 T11 test 7d (P8 step 3, critics M6/P6/R4): a lost stamp re-reads the ticket. A
// pass-through mock of the ticket repo lets a hook stamp the recall case with a class FIRST (as a
// concurrent report would), so the writer's own stampRegClass returns false deterministically.

const hook = vi.hoisted(() => ({ cls: null as string | null, shiftMs: 0 }));

vi.mock('@/db/repos/ticket-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/ticket-repo')>();
  return {
    ...real,
    createTicketRepo: (db: DbOrTx, opts?: Parameters<typeof real.createTicketRepo>[1]) => {
      const repo = real.createTicketRepo(db, opts);
      return {
        ...repo,
        async stampRegClass(...args: Parameters<typeof repo.stampRegClass>) {
          if (hook.cls) {
            const [id, partnerId] = args;
            const at = Date.now() + hook.shiftMs;
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
import { openErrorNoticeCaseLocked, openRecallTicketLocked, type ErrorNoticeCaseInput } from '@/lib/receipt-cores';

const PHONE = '15551239877';
const TX = 'T_race1';
let db: Db;

function transfer(): Transfer {
  return {
    id: TX, phone: PHONE, amountUsd: 100, feeUsd: 1, totalChargeUsd: 101, fxRate: 83, amountInr: 8300,
    recipientName: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'mom@upi',
    fundingMethod: 'bank_transfer', complianceStatus: 'cleared', complianceReasons: [], status: 'delivered',
    createdAt: new Date(Date.now() - 3 * 3600_000).toISOString(), paidAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    deliveredAt: new Date(Date.now() - 3600_000).toISOString(), sourceCountry: 'US', sourceCurrency: 'USD',
    destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'p1', amountSource: 100, feeSource: 1,
    totalChargeSource: 101, transferType: 'b2c',
  } as Transfer;
}

function input(regClass: RegClass): ErrorNoticeCaseInput {
  return {
    partnerId: 'p1', phone: PHONE, transferId: TX, regClass, code: 'not_received',
    subject: caseSubject('not_received'), body: 'b', capScope: 'tenant', now: Date.now(),
  };
}

async function openRecall(): Promise<string> {
  const r = await openRecallTicketLocked(db, {
    partnerId: 'p1', phone: PHONE, transferId: TX, subject: 'Recall request: other', body: 'recall', capScope: 'tenant',
  });
  if (r.kind !== 'opened') throw new Error('unreachable');
  return r.ticketId;
}

async function auditCount(): Promise<number> {
  const r = await db.execute(sql`SELECT count(*)::int AS n FROM audit_events WHERE action = 'ticket.reg_case.open'`);
  return (r.rows[0] as { n: number }).n;
}

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'p1');
  await createStore(fakeRedis(), db).saveTransfer(transfer());
  hook.cls = null;
  hook.shiftMs = 0;
});

describe('openErrorNoticeCaseLocked: a lost stamp re-reads the ticket (P8 step 3, test 7d)', () => {
  it('(i) another class won the stamp -> a NEW case of the asked class; the recall keeps the other class', async () => {
    const recallId = await openRecall();
    hook.cls = 'fraud_report';
    const r = await db.transaction((tx) => openErrorNoticeCaseLocked(tx, input('error_notice')));
    hook.cls = null;
    if (r.kind !== 'opened') throw new Error('unreachable');
    expect(r.ticketId).not.toBe(recallId);
    expect(r).toMatchObject({ reused: false, classStamped: true, regClass: 'error_notice' });
    const repo = createTicketRepo(db);
    expect((await repo.getTicket(recallId))!.regClass).toBe('fraud_report');
    expect((await repo.getTicket(r.ticketId))!.regClass).toBe('error_notice');
    expect(await auditCount()).toBe(1);
  });

  it('(ii) the SAME class won the stamp -> the recall case is returned as reused, nothing written by this call', async () => {
    const recallId = await openRecall();
    hook.cls = 'error_notice';
    const r = await db.transaction((tx) => openErrorNoticeCaseLocked(tx, input('error_notice')));
    hook.cls = null;
    const stamped = await createTicketRepo(db).getTicket(recallId);
    expect(r).toEqual({ kind: 'opened', ticketId: recallId, reused: true, regClass: 'error_notice', dueAt: stamped!.dueAt, classStamped: false });
    expect(await auditCount()).toBe(0);
    const notes = (await createTicketRepo(db).listMessages(recallId, { includeInternal: true })).filter((m) => m.actorType === 'system');
    expect(notes).toEqual([]);
  });

  it('(iii) F1 (FC1): the SAME class won with a LATER due date -> tightened to this call\'s earlier date, reused, no audit row', async () => {
    const recallId = await openRecall();
    const repo = createTicketRepo(db);
    const createdAt = (await repo.getTicket(recallId))!.createdAt;
    hook.cls = 'error_notice';
    hook.shiftMs = 5 * 86_400_000;
    const r = await db.transaction((tx) => openErrorNoticeCaseLocked(tx, input('error_notice')));
    hook.cls = null;
    const want = new Date(regDueAt('error_notice', Date.parse(createdAt))).toISOString();
    expect(Date.parse(want)).toBeLessThan(regDueAt('error_notice', Date.now() + 5 * 86_400_000));
    expect(r).toEqual({ kind: 'opened', ticketId: recallId, reused: true, regClass: 'error_notice', dueAt: want, classStamped: false });
    expect((await repo.getTicket(recallId))!.dueAt).toBe(want);
    const row = await db.execute(sql`SELECT due_at FROM tickets WHERE id = ${recallId}`);
    expect(new Date((row.rows[0] as { due_at: string }).due_at).toISOString()).toBe(want);
    expect(await auditCount()).toBe(0);
  });
});
