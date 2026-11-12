import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { regDueAt, type RegClass } from '@/lib/reg-clocks';
import type { Db, DbOrTx } from '@/db/client';

// Fix pack 8 T12 test 10 (P9 step 2): a lost stamp re-reads the ticket. A pass-through mock of the
// ticket repo lets a hook stamp the help case with fraud_report FIRST (as a concurrent report
// would), so openHelpCase's own stampRegClass returns false deterministically.

const hook = vi.hoisted(() => ({ cls: null as string | null }));

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

const PHONE = '15551230043';
const base = { partnerId: 'default', phone: PHONE, channel: 'whatsapp', source: 'keyword' } as const;
let db: Db;

beforeEach(async () => {
  db = await freshDb();
  hook.cls = null;
});

describe('openHelpCase: a lost stamp re-reads the ticket (P9, test 10)', () => {
  it('another class won the stamp -> the result carries the re-read class and due date, no audit row from this call', async () => {
    const a = await db.transaction((tx) => openHelpCase(tx, { ...base, reason: 'question' }));
    hook.cls = 'fraud_report';
    const b = await db.transaction((tx) => openHelpCase(tx, { ...base, reason: 'complaint' }));
    hook.cls = null;
    const t = await createTicketRepo(db).getTicket(a.caseId);
    expect(t!.regClass).toBe('fraud_report');
    expect(b).toEqual({ caseId: a.caseId, partnerId: 'default', created: false, regClass: 'fraud_report', dueAt: t!.dueAt, caseCreatedOrStamped: false });
    const r = await db.execute(sql`SELECT count(*)::int AS n FROM audit_events WHERE action = 'ticket.reg_case.open'`);
    expect((r.rows[0] as { n: number }).n).toBe(0);
  });
});
