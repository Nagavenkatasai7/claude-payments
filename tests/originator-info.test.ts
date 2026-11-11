import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '@/db/client';
import { auditEvents } from '@/db/schema';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { writeOriginatorInfo } from '@/lib/originator-info';
import { auditSubjectId } from '@/lib/customer-ref';
import { TENANT_AUDIT_ACTIONS, actionLabelKey } from '@/lib/partner-audit-view';
import { freshDb, seedPartner } from './helpers-db';

// Fix pack 5 T18 (P20, P29 row 1): writeOriginatorInfo writes the sender's address and date of
// birth set-if-unset plus ONE customer.travel_rule_set audit row, in ONE transaction, with field
// names (never values) in the meta. All values are invented placeholders.

const logSpy = vi.hoisted(() => ({ lines: [] as unknown[][] }));
vi.mock('@/lib/log', async (orig) => {
  const real = await orig<typeof import('@/lib/log')>();
  return {
    ...real,
    logWarn: (...args: unknown[]) => {
      logSpy.lines.push(args);
      return (real.logWarn as (...a: unknown[]) => void)(...args);
    },
    logError: (...args: unknown[]) => {
      logSpy.lines.push(args);
      return (real.logError as (...a: unknown[]) => void)(...args);
    },
  };
});

const OWNER = 'acme';
const PHONE = '15551230077';
const ADDRESS = '1 Test Street, Testville TE1 1ST';
const DOB = (() => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 30);
  return d.toISOString().slice(0, 10);
})();

let db: Db;
beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, OWNER, 'Acme');
  await createCustomerRepo(db, async () => null).ensureCustomer(OWNER, PHONE);
  logSpy.lines = [];
});

type AuditRow = { partner_id: string; actor: string; actor_type: string; subject_id: string; meta: unknown };
async function travelRuleRows(): Promise<AuditRow[]> {
  const r = (await db.execute(
    sql`SELECT partner_id, actor, actor_type, subject_id, meta FROM audit_events WHERE action = 'customer.travel_rule_set' ORDER BY id`,
  )) as unknown as { rows: AuditRow[] };
  return r.rows;
}
const onFile = () => createCustomerRepo(db, async () => null).originatorOnFile(OWNER, PHONE);
const stored = async () => {
  const c = (await createCustomerRepo(db, async () => null).getCustomer(OWNER, PHONE))!;
  return { address: c.residentialAddress, dob: c.dateOfBirth };
};

describe('writeOriginatorInfo (P20)', () => {
  it('writes both values and ONE customer.travel_rule_set audit row; returns the fields', async () => {
    const fields = await writeOriginatorInfo(
      db,
      { partnerId: OWNER, phone: PHONE },
      { address: ADDRESS, dateOfBirth: DOB },
      { source: 'pay_page', transferId: 'tr_o1' },
    );
    expect(fields).toEqual(['address', 'date_of_birth']);
    expect(await stored()).toEqual({ address: ADDRESS, dob: DOB });
    expect(await travelRuleRows()).toEqual([
      {
        partner_id: OWNER,
        actor: 'pay-page',
        actor_type: 'system',
        subject_id: auditSubjectId(OWNER, PHONE),
        meta: { source: 'pay_page', fields: ['address', 'date_of_birth'], transferId: 'tr_o1' },
      },
    ]);
  });

  it('only the address given -> fields [address]', async () => {
    expect(
      await writeOriginatorInfo(db, { partnerId: OWNER, phone: PHONE }, { address: ADDRESS }, { source: 'pay_page', transferId: 'tr_o2' }),
    ).toEqual(['address']);
    expect(await onFile()).toEqual({ address: true, dateOfBirth: false });
    expect((await travelRuleRows())[0].meta).toEqual({ source: 'pay_page', fields: ['address'], transferId: 'tr_o2' });
  });

  it('a value already on file is not written and not in fields; nothing written -> no audit row, []', async () => {
    await createCustomerRepo(db, async () => null).setResidentialAddressIfUnset(OWNER, PHONE, ADDRESS);
    expect(
      await writeOriginatorInfo(
        db,
        { partnerId: OWNER, phone: PHONE },
        { address: '9 Other Way, Elsewhere EL9 9WW', dateOfBirth: DOB },
        { source: 'pay_page', transferId: 'tr_o3' },
      ),
    ).toEqual(['date_of_birth']);
    expect(await stored()).toEqual({ address: ADDRESS, dob: DOB });
    expect((await travelRuleRows()).map((r) => r.meta)).toEqual([
      { source: 'pay_page', fields: ['date_of_birth'], transferId: 'tr_o3' },
    ]);
    expect(
      await writeOriginatorInfo(
        db,
        { partnerId: OWNER, phone: PHONE },
        { address: ADDRESS, dateOfBirth: DOB },
        { source: 'pay_page', transferId: 'tr_o4' },
      ),
    ).toEqual([]);
    expect(await writeOriginatorInfo(db, { partnerId: OWNER, phone: PHONE }, {}, { source: 'pay_page' })).toEqual([]);
    expect(await travelRuleRows()).toHaveLength(1);
  });

  it('a missing customer row -> nothing written, no audit row, []', async () => {
    expect(
      await writeOriginatorInfo(db, { partnerId: OWNER, phone: '15551239999' }, { address: ADDRESS, dateOfBirth: DOB }, { source: 'pay_page' }),
    ).toEqual([]);
    expect(await travelRuleRows()).toEqual([]);
  });

  it("source 'partner_api' uses meta.actor (the API key id), actorType 'api_key', and carries transferId", async () => {
    await writeOriginatorInfo(
      db,
      { partnerId: OWNER, phone: PHONE },
      { address: ADDRESS },
      { source: 'partner_api', transferId: 'tr_api1', actor: 'key_123' },
    );
    expect(await travelRuleRows()).toEqual([
      {
        partner_id: OWNER,
        actor: 'key_123',
        actor_type: 'api_key',
        subject_id: auditSubjectId(OWNER, PHONE),
        meta: { source: 'partner_api', fields: ['address'], transferId: 'tr_api1' },
      },
    ]);
  });

  it("'payment_link' carries routeId, not transferId", async () => {
    await writeOriginatorInfo(
      db,
      { partnerId: OWNER, phone: PHONE },
      { dateOfBirth: DOB },
      { source: 'payment_link', routeId: 'lnk_1' },
    );
    const [row] = await travelRuleRows();
    expect(row.actor).toBe('pay-page');
    expect(row.actor_type).toBe('system');
    expect(row.meta).toEqual({ source: 'payment_link', fields: ['date_of_birth'], routeId: 'lnk_1' });
  });

  it('called with a transaction (DbOrTx) it runs as a nested savepoint: an outer rollback undoes the values and the audit row', async () => {
    class Rollback extends Error {}
    await expect(
      db.transaction(async (tx) => {
        const fields = await writeOriginatorInfo(
          tx,
          { partnerId: OWNER, phone: PHONE },
          { address: ADDRESS, dateOfBirth: DOB },
          { source: 'partner_api', transferId: 'tr_tx', actor: 'key_9' },
        );
        expect(fields).toEqual(['address', 'date_of_birth']);
        throw new Rollback('outer');
      }),
    ).rejects.toBeInstanceOf(Rollback);
    expect(await onFile()).toEqual({ address: false, dateOfBirth: false });
    expect(await travelRuleRows()).toEqual([]);
  });

  it('a failing audit insert rolls the values back', async () => {
    // A db whose transaction hands out a tx that refuses to insert into audit_events.
    const failingTx = (tx: DbOrTx): DbOrTx =>
      new Proxy(tx, {
        get(target, prop, recv) {
          if (prop === 'insert') {
            return (table: unknown) => {
              if (table === auditEvents) throw new Error('audit insert refused (test)');
              return (target as Db).insert(table as never);
            };
          }
          const v = Reflect.get(target, prop, recv);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    const failing = new Proxy(db, {
      get(target, prop, recv) {
        if (prop === 'transaction') {
          return <T,>(fn: (tx: DbOrTx) => Promise<T>) => target.transaction((tx) => fn(failingTx(tx)));
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    await expect(
      writeOriginatorInfo(failing, { partnerId: OWNER, phone: PHONE }, { address: ADDRESS, dateOfBirth: DOB }, { source: 'pay_page' }),
    ).rejects.toThrow(/audit insert refused/);
    expect(await onFile()).toEqual({ address: false, dateOfBirth: false });
    expect(await travelRuleRows()).toEqual([]);
  });

  it('the audit meta, the returned value and every log line hold no address or DOB text', async () => {
    const fields = await writeOriginatorInfo(
      db,
      { partnerId: OWNER, phone: PHONE },
      { address: ADDRESS, dateOfBirth: DOB },
      { source: 'pay_page', transferId: 'tr_pii' },
    );
    const text = JSON.stringify([fields, await travelRuleRows(), logSpy.lines]);
    expect(text).not.toContain('Test Street');
    expect(text).not.toContain('Testville');
    expect(text).not.toContain(DOB);
    expect(text).not.toContain(PHONE);
  });

  it('customer.travel_rule_set is NOT a tenant audit action', () => {
    expect(TENANT_AUDIT_ACTIONS).not.toContain('customer.travel_rule_set');
    expect(actionLabelKey('customer.travel_rule_set')).toBe('partner.audit.action.other');
  });
});
