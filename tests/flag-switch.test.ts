import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  applyFlagChange,
  FlagChangeError,
  FLAG_AUDIT_ACTION,
  isFlagChangeMessage,
  killSwitchBannerLines,
  partnerKillSwitchBannerLines,
  PARTNER_FLAG_KEYS,
  scopeLabel,
} from '@/lib/flag-switch';
import { invalidateFlagCache, isFlagOn } from '@/lib/flags';
import { createFeatureFlagRepo } from '@/db/repos/feature-flag-repo';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';

// Release safety Batch 2 part A: the switch action's core. Access, the key
// list, scope validation, the reason, and the audit row + ops alert in the
// SAME transaction as the flag write.

const ADMIN = { username: 'ops-admin', role: 'admin' as const, partnerId: undefined };
const REASON = 'Rail partner reports an outage';

let db: Db;
const deps = () => ({ db, partnerExists: async (id: string) => id === 'acme' });

async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(q)) as unknown as { rows: T[] }).rows;
}

beforeEach(async () => {
  db = await freshDb();
  invalidateFlagCache(db);
  await seedPartner(db, 'acme');
});
afterEach(() => invalidateFlagCache(db));

describe('applyFlagChange', { retry: 0 }, () => {
  it('turns a global switch on: flag row, flag.change audit row and one ops alert; the read sees it at once', async () => {
    const r = await applyFlagChange(ADMIN, { key: 'sends.paused', scopeType: 'global', scopeId: 'ignored', enabled: 'on', reason: REASON }, deps());
    expect(r).toEqual({ key: 'sends.paused', scopeType: 'global', scopeId: '', enabled: true, previous: false });
    expect(await isFlagOn(db, 'sends.paused')).toBe(true);

    const audit = await rows<{ actor: string; action: string; subject_id: string; meta: Record<string, unknown> }>(
      sql`SELECT actor, action, subject_id, meta FROM audit_events`,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: 'ops-admin', action: FLAG_AUDIT_ACTION, subject_id: 'sends.paused:global:' });
    expect(audit[0].meta).toMatchObject({ enabled: true, previous: false, reason: REASON });

    const alerts = await rows<{ m: string }>(sql`SELECT payload->>'message' AS m FROM outbox WHERE kind = 'ops.alert'`);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].m).toContain('"Pause new sends" is now ON for all partners and corridors');
    expect(alerts[0].m).toContain(REASON);
  });

  it('turning it off again alerts once more; re-saving the same state writes audit but no second alert', async () => {
    await applyFlagChange(ADMIN, { key: 'settlement.paused', scopeType: 'partner', scopeId: 'acme', enabled: 'on', reason: REASON }, deps());
    await applyFlagChange(ADMIN, { key: 'settlement.paused', scopeType: 'partner', scopeId: 'acme', enabled: 'on', reason: 'Still investigating the rail' }, deps());
    await applyFlagChange(ADMIN, { key: 'settlement.paused', scopeType: 'partner', scopeId: 'acme', enabled: 'off', reason: 'Rail is healthy again' }, deps());
    const alerts = await rows<{ m: string }>(sql`SELECT payload->>'message' AS m FROM outbox WHERE kind = 'ops.alert' ORDER BY id`);
    expect(alerts.map((a) => a.m.includes('is now ON') ? 'on' : 'off')).toEqual(['on', 'off']);
    const audit = await rows<{ partner_id: string }>(sql`SELECT partner_id FROM audit_events WHERE action = 'flag.change'`);
    expect(audit).toHaveLength(3);
    expect(audit.every((a) => a.partner_id === 'acme')).toBe(true);
    expect(await isFlagOn(db, 'settlement.paused', { partnerId: 'acme' })).toBe(false);
  });

  it('normalises a corridor scope to the upper-case country code', async () => {
    const r = await applyFlagChange(ADMIN, { key: 'sends.paused', scopeType: 'corridor', scopeId: ' in ', enabled: 'on', reason: REASON }, deps());
    expect(r.scopeId).toBe('IN');
    expect(await isFlagOn(db, 'sends.paused', { corridor: 'IN' })).toBe(true);
  });

  const refusals: Array<[string, Parameters<typeof applyFlagChange>[0], Parameters<typeof applyFlagChange>[1], RegExp]> = [
    ['an agent', { ...ADMIN, role: 'agent' as never }, { key: 'sends.paused', scopeType: 'global', scopeId: '', enabled: 'on', reason: REASON }, /platform admin/],
    ['a partner-scoped admin', { ...ADMIN, partnerId: 'acme' as never }, { key: 'sends.paused', scopeType: 'global', scopeId: '', enabled: 'on', reason: REASON }, /platform admin/],
    ['an unknown key', ADMIN, { key: 'sanctions.off', scopeType: 'global', scopeId: '', enabled: 'on', reason: REASON }, /Unknown switch/],
    ['a prototype key', ADMIN, { key: '__proto__', scopeType: 'global', scopeId: '', enabled: 'on', reason: REASON }, /Unknown switch/],
    ['an unknown scope type', ADMIN, { key: 'sends.paused', scopeType: 'team', scopeId: '', enabled: 'on', reason: REASON }, /valid scope/],
    ['a missing partner', ADMIN, { key: 'sends.paused', scopeType: 'partner', scopeId: 'globex', enabled: 'on', reason: REASON }, /existing partner/],
    ['an unsupported corridor', ADMIN, { key: 'sends.paused', scopeType: 'corridor', scopeId: 'ZZ', enabled: 'on', reason: REASON }, /destination country/],
    ['a short reason', ADMIN, { key: 'sends.paused', scopeType: 'global', scopeId: '', enabled: 'on', reason: 'oops' }, /at least 10/],
    ['a blank reason', ADMIN, { key: 'sends.paused', scopeType: 'global', scopeId: '', enabled: 'on', reason: '   ' }, /reason is required/],
    ['a bad on/off value', ADMIN, { key: 'sends.paused', scopeType: 'global', scopeId: '', enabled: 'maybe', reason: REASON }, /on or off/],
  ];
  // Fix pack 3 T8: a partner-set (tenant:) row is changed only in the partner
  // workspace. Refused BEFORE partnerExists (yesDeps would say the id exists).
  refusals.push(
    ['a tenant: scope id', ADMIN, { key: 'sends.paused', scopeType: 'partner', scopeId: 'tenant:acme', enabled: 'off', reason: REASON }, /partner workspace/],
    ['a tenant: scope id with a corridor', ADMIN, { key: 'sends.paused', scopeType: 'partner', scopeId: ' tenant:acme:IN', enabled: 'off', reason: REASON }, /partner workspace/],
  );
  const yesDeps = () => ({ db, partnerExists: async (id: string) => id === 'acme' || id.trim().startsWith('tenant:') });
  for (const [name, staff, input, msg] of refusals) {
    const d = name.startsWith('a tenant:') ? yesDeps : deps;
    it(`refuses ${name} and writes nothing`, async () => {
      await expect(applyFlagChange(staff, input, d())).rejects.toThrow(FlagChangeError);
      await expect(applyFlagChange(staff, input, d())).rejects.toThrow(msg);
      // The page shows only fixed messages: every refusal text is on the allowlist.
      const e = await applyFlagChange(staff, input, d()).catch((x: Error) => x);
      expect(isFlagChangeMessage((e as Error).message)).toBe(true);
      expect(await createFeatureFlagRepo(db).listAll()).toEqual([]);
      expect(await rows(sql`SELECT 1 FROM audit_events`)).toEqual([]);
      expect(await rows(sql`SELECT 1 FROM outbox`)).toEqual([]);
    });
  }

  it('rolls the flag write back when the audit write fails (one transaction)', async () => {
    const failing = new Proxy(db, {
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
    });
    await expect(
      applyFlagChange(ADMIN, { key: 'sends.paused', scopeType: 'global', scopeId: '', enabled: 'on', reason: REASON }, { db: failing, partnerExists: async () => true }),
    ).rejects.toThrow('audit down');
    expect(await createFeatureFlagRepo(db).listAll()).toEqual([]);
  });

  it('the page allowlist rejects any other text', () => {
    expect(isFlagChangeMessage('<script>alert(1)</script>')).toBe(false);
    expect(isFlagChangeMessage(undefined)).toBe(false);
  });

  it('banner lines: one per enabled kill-switch row, unknown keys and off rows skipped', () => {
    const at = new Date();
    const row = (key: string, scopeType: 'global' | 'partner' | 'corridor', scopeId: string, enabled = true) =>
      ({ key, scopeType, scopeId, enabled, reason: 'x', updatedBy: 'a', updatedAt: at });
    expect(killSwitchBannerLines([
      row('sends.paused', 'global', ''),
      row('settlement.paused', 'partner', 'acme'),
      row('settlement.paused', 'corridor', 'IN', false),
      row('voice.notes', 'global', ''),
    ])).toEqual([
      'New sends are paused for all partners and corridors.',
      'Settlement to partner rails is paused for partner acme.',
    ]);
  });

  it('a tenant: refusal happens before partnerExists is asked', async () => {
    let asked = 0;
    await expect(
      applyFlagChange(ADMIN, { key: 'sends.paused', scopeType: 'partner', scopeId: 'tenant:acme', enabled: 'off', reason: REASON }, { db, partnerExists: async () => { asked++; return true; } }),
    ).rejects.toThrow('Partner-set switches are changed in the partner workspace.');
    expect(asked).toBe(0);
  });
});

describe('platform partner rows email the partner (fix pack 3 T8, contract 13)', { retry: 0 }, () => {
  const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const mails = () => rows<{ p: { to: string[]; subject: string; text: string }; d: string }>(
    sql`SELECT payload AS p, dedupe_key AS d FROM outbox WHERE kind = 'email.send' ORDER BY id`,
  );
  const setAddress = (id: string, sc: { alertEmail?: string; complianceAlertEmail?: string }) =>
    createPartnerRepo(db).updateSupportConfig(id, (prev) => ({ ...prev, ...sc }));
  const allDeps = () => ({ db, partnerExists: async () => true });

  it('a changed platform partner row emails that partner (SmartRemit wording), dedupe flagmail:<key>:acme:<uuid>', async () => {
    await setAddress('acme', { alertEmail: 'ops@acme.example', complianceAlertEmail: 'compliance@acme.example' });
    await applyFlagChange(ADMIN, { key: 'settlement.paused', scopeType: 'partner', scopeId: 'acme', enabled: 'on', reason: REASON }, deps());
    await applyFlagChange(ADMIN, { key: 'settlement.paused', scopeType: 'partner', scopeId: 'acme', enabled: 'off', reason: 'The rail is healthy again' }, deps());
    const m = await mails();
    expect(m).toHaveLength(2);
    expect(m[0].d).toMatch(new RegExp(`^flagmail:settlement\\.paused:acme:${UUID}$`));
    expect(m[0].p).toEqual({
      to: ['compliance@acme.example'],
      subject: 'SmartRemit: a live control changed for your workspace',
      text: 'Pause settlement was changed by SmartRemit (turned on). Details are in your SmartRemit workspace.',
    });
    expect(m[1].p.text).toBe('Pause settlement was changed by SmartRemit (turned off). Details are in your SmartRemit workspace.');
    expect(JSON.stringify(m)).not.toContain(REASON);
  });

  it("no email for 'default', for no address, for a global or corridor row, or for an unchanged save", async () => {
    await setAddress('default', { alertEmail: 'ops@default.example' });
    await applyFlagChange(ADMIN, { key: 'sends.paused', scopeType: 'partner', scopeId: 'default', enabled: 'on', reason: REASON }, allDeps());
    await seedPartner(db, 'globex');
    await applyFlagChange(ADMIN, { key: 'sends.paused', scopeType: 'partner', scopeId: 'globex', enabled: 'on', reason: REASON }, allDeps());
    await setAddress('acme', { alertEmail: 'ops@acme.example' });
    await applyFlagChange(ADMIN, { key: 'sends.paused', scopeType: 'global', scopeId: '', enabled: 'on', reason: REASON }, allDeps());
    await applyFlagChange(ADMIN, { key: 'sends.paused', scopeType: 'corridor', scopeId: 'IN', enabled: 'on', reason: REASON }, allDeps());
    expect(await mails()).toEqual([]);
    // An unchanged save (off -> off; then on -> on) mails once only, on the change.
    await applyFlagChange(ADMIN, { key: 'voice.notes', scopeType: 'partner', scopeId: 'acme', enabled: 'off', reason: REASON }, allDeps());
    expect(await mails()).toEqual([]);
    await applyFlagChange(ADMIN, { key: 'voice.notes', scopeType: 'partner', scopeId: 'acme', enabled: 'on', reason: REASON }, allDeps());
    await applyFlagChange(ADMIN, { key: 'voice.notes', scopeType: 'partner', scopeId: 'acme', enabled: 'on', reason: REASON }, allDeps());
    expect(await mails()).toHaveLength(1);
  });
});

describe('labels and banners for partner-set rows (fix pack 3 T8)', { retry: 0 }, () => {
  const at = new Date();
  const row = (key: string, scopeType: 'global' | 'partner' | 'corridor', scopeId: string, enabled = true) =>
    ({ key, scopeType, scopeId, enabled, reason: 'secret reason text', updatedBy: 'someone-secret', updatedAt: at });

  it("scopeLabel: tenant:acme -> 'set by partner acme'; with a corridor; an unparsable tenant: id as today", () => {
    expect(scopeLabel('partner', 'tenant:acme')).toBe('set by partner acme');
    expect(scopeLabel('partner', 'tenant:acme:IN')).toBe('set by partner acme for IN');
    expect(scopeLabel('partner', 'tenant:acme:ZZ')).toBe('partner tenant:acme:ZZ');
    expect(scopeLabel('partner', 'acme')).toBe('partner acme');
    expect(scopeLabel('global', '')).toBe('all partners and corridors');
    expect(scopeLabel('corridor', 'IN')).toBe('corridor IN');
  });

  it("killSwitchBannerLines: a tenant row reads '<bannerText>, set by partner acme for IN.'", () => {
    expect(killSwitchBannerLines([
      row('sends.paused', 'partner', 'tenant:acme:IN'),
      row('agent.paused', 'partner', 'tenant:acme'),
      row('settlement.paused', 'partner', 'acme'),
    ])).toEqual([
      'New sends are paused, set by partner acme for IN.',
      'The AI agent is paused, set by partner acme.',
      'Settlement to partner rails is paused for partner acme.',
    ]);
  });

  it("partnerKillSwitchBannerLines(rows, 'acme'): who set it, for this tenant only, no reason or username", () => {
    const lines = partnerKillSwitchBannerLines([
      row('sends.paused', 'global', ''),
      row('sends.paused', 'partner', 'acme'),
      row('settlement.paused', 'partner', 'tenant:acme'),
      row('sends.paused', 'partner', 'tenant:acme:IN'),
      row('settlement.paused', 'corridor', 'IN'),
      row('sends.paused', 'partner', 'globex'),
      row('sends.paused', 'partner', 'tenant:globex'),
      row('sends.paused', 'partner', 'tenant:globex:IN'),
      row('agent.paused', 'partner', 'tenant:acme', false),
      row('nope.key', 'global', ''),
      row('voice.notes', 'partner', 'acme'),
      row('sends.paused', 'partner', 'tenant:acme:ZZ'),
    ], 'acme');
    expect(lines).toEqual([
      'New sends are paused for every partner (set by SmartRemit).',
      'New sends are paused for your workspace (set by SmartRemit).',
      'Settlement to partner rails is paused for your workspace (set by your team).',
      'New sends are paused for your workspace for IN (set by your team).',
      'Settlement to partner rails is paused for corridor IN (set by SmartRemit).',
    ]);
    for (const l of lines) {
      expect(l).not.toContain('secret');
    }
  });

  it("PARTNER_FLAG_KEYS equals ['sends.paused', 'settlement.paused', 'agent.paused', 'agent.tools.paused'] and is frozen", () => {
    expect(PARTNER_FLAG_KEYS).toEqual(['sends.paused', 'settlement.paused', 'agent.paused', 'agent.tools.paused']);
    expect(Object.isFrozen(PARTNER_FLAG_KEYS)).toBe(true);
  });
});
