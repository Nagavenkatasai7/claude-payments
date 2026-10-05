import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { applyFlagChange, FlagChangeError, FLAG_AUDIT_ACTION, isFlagChangeMessage, killSwitchBannerLines } from '@/lib/flag-switch';
import { invalidateFlagCache, isFlagOn } from '@/lib/flags';
import { createFeatureFlagRepo } from '@/db/repos/feature-flag-repo';
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
  for (const [name, staff, input, msg] of refusals) {
    it(`refuses ${name} and writes nothing`, async () => {
      await expect(applyFlagChange(staff, input, deps())).rejects.toThrow(FlagChangeError);
      await expect(applyFlagChange(staff, input, deps())).rejects.toThrow(msg);
      // The page shows only fixed messages: every refusal text is on the allowlist.
      const e = await applyFlagChange(staff, input, deps()).catch((x: Error) => x);
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
});
