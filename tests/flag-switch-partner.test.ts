import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';

// Fix pack 3 T8 (R26, contracts 11 and 13): the partner-set pause writer. The
// SESSION tenant is the only scope; a partner may change only partner-operable
// keys; the flag row, the audit row, the ops alert and the partner email are
// written in ONE transaction.

let db: Db;
let failingDb: Db | null = null;
vi.mock('@/db/client', async (orig) => ({
  ...(await orig<typeof import('@/db/client')>()),
  getDb: () => failingDb ?? db,
}));

import { applyPartnerFlagChange, FLAG_AUDIT_ACTION } from '@/lib/flag-switch';
import { invalidateFlagCache, readFlag } from '@/lib/flags';
import { createFeatureFlagRepo } from '@/db/repos/feature-flag-repo';
import { createPartnerRepo } from '@/db/repos/partner-repo';

const ACTOR = { username: 'acme-admin', partnerId: 'acme' };
const REASON = 'Our payout desk is closed today';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(q)) as unknown as { rows: T[] }).rows;
}

async function setAddress(id: string, sc: { alertEmail?: string; complianceAlertEmail?: string }): Promise<void> {
  await createPartnerRepo(db).updateSupportConfig(id, (prev) => ({ ...prev, ...sc }));
}

async function expectNothingWritten(): Promise<void> {
  expect(await createFeatureFlagRepo(db).listAll()).toEqual([]);
  expect(await rows(sql`SELECT 1 FROM audit_events`)).toEqual([]);
  expect(await rows(sql`SELECT 1 FROM outbox`)).toEqual([]);
}

beforeEach(async () => {
  db = await freshDb();
  failingDb = null;
  invalidateFlagCache(db);
  await seedPartner(db, 'acme');
  await seedPartner(db, 'globex');
});
afterEach(() => {
  invalidateFlagCache(db);
  failingDb = null;
});

describe('applyPartnerFlagChange', { retry: 0 }, () => {
  it('pauses sends for the own tenant: row partner/tenant:acme, readFlag on for acme, off for globex', async () => {
    const r = await applyPartnerFlagChange(ACTOR, { key: 'sends.paused', enabled: true, reason: REASON });
    expect(r).toEqual({ ok: true, changed: true });
    const all = await createFeatureFlagRepo(db).listAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ key: 'sends.paused', scopeType: 'partner', scopeId: 'tenant:acme', enabled: true, updatedBy: 'acme-admin', reason: REASON });
    expect(await readFlag(db, 'sends.paused', { partnerId: 'acme' })).toBe('on');
    expect(await readFlag(db, 'sends.paused', { partnerId: 'globex' })).toBe('off');
  });

  it("with a corridor: scope id tenant:acme:IN; lower-case 'in' normalised", async () => {
    const r = await applyPartnerFlagChange(ACTOR, { key: 'settlement.paused', corridor: ' in ', enabled: true, reason: REASON });
    expect(r).toEqual({ ok: true, changed: true });
    const all = await createFeatureFlagRepo(db).listAll();
    expect(all.map((x) => `${x.scopeType}/${x.scopeId}`)).toEqual(['partner/tenant:acme:IN']);
    expect(await readFlag(db, 'settlement.paused', { partnerId: 'acme', corridor: 'IN' })).toBe('on');
    expect(await readFlag(db, 'settlement.paused', { partnerId: 'acme', corridor: 'MX' })).toBe('off');
  });

  it('one tx: flag row, one flag.change audit row, one ops.alert with ids only and no reason', async () => {
    await applyPartnerFlagChange(ACTOR, { key: 'sends.paused', enabled: true, reason: REASON });
    const audit = await rows<{ partner_id: string; actor: string; actor_type: string; action: string; subject_id: string; meta: Record<string, unknown> }>(
      sql`SELECT partner_id, actor, actor_type, action, subject_id, meta FROM audit_events`,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      partner_id: 'acme',
      actor: 'acme-admin',
      actor_type: 'staff',
      action: FLAG_AUDIT_ACTION,
      subject_id: 'sends.paused:partner:tenant:acme',
    });
    expect(audit[0].meta).toEqual({
      key: 'sends.paused',
      scopeType: 'partner',
      scopeId: 'tenant:acme',
      corridor: null,
      enabled: true,
      previous: false,
      reason: REASON,
      actorScope: 'partner',
    });
    const alerts = await rows<{ m: string; d: string }>(
      sql`SELECT payload->>'message' AS m, dedupe_key AS d FROM outbox WHERE kind = 'ops.alert'`,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].d).toMatch(new RegExp(`^flag:sends\\.paused:partner:tenant:acme:${UUID}$`));
    expect(alerts[0].m).toBe('🛑 SmartRemit ops: "Pause new sends" is now ON, set by partner acme (by acme-admin).');
    expect(alerts[0].m).not.toContain(REASON);
    // No address on the seeded partner: no email row.
    expect(await rows(sql`SELECT 1 FROM outbox WHERE kind = 'email.send'`)).toEqual([]);
  });

  it('emails complianceAlertEmail ?? alertEmail with the fixed wording and a unique dedupe key', async () => {
    await setAddress('acme', { alertEmail: 'ops@acme.example', complianceAlertEmail: 'compliance@acme.example' });
    await applyPartnerFlagChange(ACTOR, { key: 'sends.paused', enabled: true, reason: REASON });
    const mails = await rows<{ p: { to: string[]; subject: string; text: string }; d: string }>(
      sql`SELECT payload AS p, dedupe_key AS d FROM outbox WHERE kind = 'email.send'`,
    );
    expect(mails).toHaveLength(1);
    expect(mails[0].d).toMatch(new RegExp(`^flagmail:sends\\.paused:tenant:acme:${UUID}$`));
    expect(mails[0].p).toEqual({
      to: ['compliance@acme.example'],
      subject: 'SmartRemit: a live control changed for your workspace',
      text: 'Pause new sends was changed by your team (turned on). Details are in your SmartRemit workspace.',
    });

    await setAddress('globex', { alertEmail: 'ops@globex.example' });
    await applyPartnerFlagChange({ username: 'globex-admin', partnerId: 'globex' }, { key: 'sends.paused', enabled: true, reason: REASON });
    const g = await rows<{ to: string }>(sql`SELECT payload->'to'->>0 AS to FROM outbox WHERE kind = 'email.send' AND dedupe_key LIKE 'flagmail:sends.paused:tenant:globex:%'`);
    expect(g).toEqual([{ to: 'ops@globex.example' }]);
  });

  it("the 'default' tenant is not refused, but gets no email", async () => {
    await setAddress('default', { alertEmail: 'ops@default.example' });
    const r = await applyPartnerFlagChange({ username: 'd-admin', partnerId: 'default' }, { key: 'sends.paused', enabled: true, reason: REASON });
    expect(r).toEqual({ ok: true, changed: true });
    expect(await rows(sql`SELECT 1 FROM outbox WHERE kind = 'email.send'`)).toEqual([]);
    expect(await rows(sql`SELECT 1 FROM outbox WHERE kind = 'ops.alert'`)).toHaveLength(1);
  });

  it('re-saving the same state: audit row, changed false, no alert, no email; turning off alerts OFF', async () => {
    await setAddress('acme', { alertEmail: 'ops@acme.example' });
    await applyPartnerFlagChange(ACTOR, { key: 'sends.paused', enabled: true, reason: REASON });
    const again = await applyPartnerFlagChange(ACTOR, { key: 'sends.paused', enabled: true, reason: 'Still closed for the holiday' });
    expect(again).toEqual({ ok: true, changed: false });
    expect(await rows(sql`SELECT 1 FROM audit_events`)).toHaveLength(2);
    expect(await rows(sql`SELECT 1 FROM outbox WHERE kind = 'ops.alert'`)).toHaveLength(1);
    expect(await rows(sql`SELECT 1 FROM outbox WHERE kind = 'email.send'`)).toHaveLength(1);

    const off = await applyPartnerFlagChange(ACTOR, { key: 'sends.paused', enabled: false, reason: 'The desk is open again' });
    expect(off).toEqual({ ok: true, changed: true });
    const alerts = await rows<{ m: string }>(sql`SELECT payload->>'message' AS m FROM outbox WHERE kind = 'ops.alert' ORDER BY id`);
    expect(alerts.map((a) => a.m)).toEqual([
      '🛑 SmartRemit ops: "Pause new sends" is now ON, set by partner acme (by acme-admin).',
      '✅ SmartRemit ops: "Pause new sends" is now OFF, set by partner acme (by acme-admin).',
    ]);
    const mails = await rows<{ t: string }>(sql`SELECT payload->>'text' AS t FROM outbox WHERE kind = 'email.send' ORDER BY id`);
    expect(mails[1].t).toBe('Pause new sends was changed by your team (turned off). Details are in your SmartRemit workspace.');
    expect(await readFlag(db, 'sends.paused', { partnerId: 'acme' })).toBe('off');
  });

  it('agent.paused and agent.tools.paused: tenant row; a corridor is refused bad_corridor', async () => {
    expect(await applyPartnerFlagChange(ACTOR, { key: 'agent.paused', enabled: true, reason: REASON })).toEqual({ ok: true, changed: true });
    expect(await applyPartnerFlagChange(ACTOR, { key: 'agent.tools.paused', enabled: true, reason: REASON })).toEqual({ ok: true, changed: true });
    const all = await createFeatureFlagRepo(db).listAll();
    expect(all.map((x) => `${x.key}/${x.scopeType}/${x.scopeId}`).sort()).toEqual([
      'agent.paused/partner/tenant:acme',
      'agent.tools.paused/partner/tenant:acme',
    ]);
    const before = (await rows(sql`SELECT 1 FROM audit_events`)).length;
    expect(await applyPartnerFlagChange(ACTOR, { key: 'agent.paused', corridor: 'IN', enabled: true, reason: REASON })).toEqual({ ok: false, code: 'bad_corridor' });
    expect(await applyPartnerFlagChange(ACTOR, { key: 'agent.tools.paused', corridor: 'IN', enabled: true, reason: REASON })).toEqual({ ok: false, code: 'bad_corridor' });
    expect(await rows(sql`SELECT 1 FROM audit_events`)).toHaveLength(before);
    expect(await createFeatureFlagRepo(db).listAll()).toHaveLength(2);
  });

  const refusals: Array<[string, Parameters<typeof applyPartnerFlagChange>[1], 'not_operable' | 'bad_corridor' | 'reason']> = [
    ['a platform-only key (voice.notes)', { key: 'voice.notes', enabled: true, reason: REASON }, 'not_operable'],
    ['an unknown key', { key: 'sanctions.off', enabled: true, reason: REASON }, 'not_operable'],
    ['a prototype key', { key: '__proto__', enabled: true, reason: REASON }, 'not_operable'],
    ["an unsupported corridor 'ZZ'", { key: 'sends.paused', corridor: 'ZZ', enabled: true, reason: REASON }, 'bad_corridor'],
    ["an unsupported corridor 'PH'", { key: 'sends.paused', corridor: 'PH', enabled: true, reason: REASON }, 'bad_corridor'],
    ['a short reason', { key: 'sends.paused', enabled: true, reason: 'oops' }, 'reason'],
    ['a blank reason', { key: 'sends.paused', enabled: true, reason: '   ' }, 'reason'],
  ];
  for (const [name, input, code] of refusals) {
    it(`refuses ${name} with ${code} and writes nothing`, async () => {
      expect(await applyPartnerFlagChange(ACTOR, input)).toEqual({ ok: false, code });
      await expectNothingWritten();
    });
  }

  it('refuses a session tenant id that would not parse back (not_operable) and writes nothing', async () => {
    expect(await applyPartnerFlagChange({ username: 'x', partnerId: 'bad:id' }, { key: 'sends.paused', enabled: true, reason: REASON })).toEqual({ ok: false, code: 'not_operable' });
    expect(await applyPartnerFlagChange({ username: 'x', partnerId: '' }, { key: 'sends.paused', enabled: true, reason: REASON })).toEqual({ ok: false, code: 'not_operable' });
    await expectNothingWritten();
  });

  it('the scope id never comes from input: an input carrying partnerId or scopeId fields is ignored', async () => {
    const forged = { key: 'sends.paused', enabled: true, reason: REASON, partnerId: 'globex', scopeId: 'tenant:globex', scopeType: 'global' } as unknown as Parameters<typeof applyPartnerFlagChange>[1];
    expect(await applyPartnerFlagChange(ACTOR, forged)).toEqual({ ok: true, changed: true });
    const all = await createFeatureFlagRepo(db).listAll();
    expect(all.map((x) => `${x.scopeType}/${x.scopeId}`)).toEqual(['partner/tenant:acme']);
    expect(await readFlag(db, 'sends.paused', { partnerId: 'globex' })).toBe('off');
    const audit = await rows<{ partner_id: string }>(sql`SELECT partner_id FROM audit_events`);
    expect(audit).toEqual([{ partner_id: 'acme' }]);
  });

  it('enabled is true only for the boolean true', async () => {
    const odd = { key: 'sends.paused', enabled: 'on', reason: REASON } as unknown as Parameters<typeof applyPartnerFlagChange>[1];
    expect(await applyPartnerFlagChange(ACTOR, odd)).toEqual({ ok: true, changed: false });
    expect((await createFeatureFlagRepo(db).listAll())[0]).toMatchObject({ enabled: false });
  });

  it('rolls back when the audit insert fails', async () => {
    await setAddress('acme', { alertEmail: 'ops@acme.example' });
    failingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return (fn: (tx: unknown) => Promise<unknown>) =>
            target.transaction(async (tx) => {
              const proxied = new Proxy(tx, {
                get(t, p, r) {
                  if (p === 'insert') {
                    return (table: { [k: symbol]: unknown }) => {
                      const name = (table as unknown as { _: { name: string } })._?.name
                        ?? (table as Record<symbol, string>)[Symbol.for('drizzle:Name')];
                      if (name === 'audit_events') throw new Error('audit down');
                      return t.insert(table as never);
                    };
                  }
                  const v = Reflect.get(t, p, r);
                  return typeof v === 'function' ? v.bind(t) : v;
                },
              });
              return fn(proxied);
            });
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as Db;
    await expect(applyPartnerFlagChange(ACTOR, { key: 'sends.paused', enabled: true, reason: REASON })).rejects.toThrow('audit down');
    failingDb = null;
    await expectNothingWritten();
  });
});
