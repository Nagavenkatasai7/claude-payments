import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createPartnerRepo, updateLiveControlsKey } from '@/db/repos/partner-repo';
import { EMPTY_LIVE_CONTROLS, type LiveControlsKey } from '@/lib/live-controls';
import type { Db } from '@/db/client';
import type { PartnerId } from '@/lib/types';
import { captureQueries, freshDb, seedPartner } from './helpers-db';

// Fix pack 3 T1 (contracts 1, 2): migration 0037 and the ONE raw-jsonb key
// writer of partners.live_controls.

const pid = (s: string) => s as PartnerId;

async function rawColumn(db: Db, id: string): Promise<{ raw: string; updatedAt: Date }> {
  const r = await db.execute(sql`SELECT live_controls::text AS raw, updated_at FROM partners WHERE id = ${id}`);
  const row = (r as unknown as { rows: Array<{ raw: string; updated_at: string | Date }> }).rows[0];
  return { raw: row.raw, updatedAt: new Date(row.updated_at) };
}

async function setRaw(db: Db, id: string, json: string) {
  await db.execute(sql`UPDATE partners SET live_controls = ${json}::jsonb, updated_at = now() - interval '1 hour' WHERE id = ${id}`);
}

let db: Db;
beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'acme');
});

describe('migration 0037', () => {
  it("freshDb applies 0037: live_controls jsonb, NOT NULL, default '{}'", async () => {
    const r = await db.execute(sql`
      SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'partners' AND column_name = 'live_controls'`);
    const rows = (r as unknown as { rows: Array<{ data_type: string; is_nullable: string; column_default: string }> }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe('jsonb');
    expect(rows[0].is_nullable).toBe('NO');
    expect(rows[0].column_default).toBe("'{}'::jsonb");
  });

  it("seedPartner gets '{}'; getPartner maps EMPTY_LIVE_CONTROLS", async () => {
    expect((await rawColumn(db, 'acme')).raw).toBe('{}');
    expect((await rawColumn(db, 'default')).raw).toBe('{}');
    const p = await createPartnerRepo(db).getPartner(pid('acme'));
    expect(p?.liveControls).toEqual(EMPTY_LIVE_CONTROLS);
  });
});

describe('updateLiveControlsKey', () => {
  it("writes one key; a second key's writer keeps the first", async () => {
    const cert = { certifiedAt: new Date().toISOString(), certifiedBy: 'ops-admin' };
    const r1 = await updateLiveControlsKey(pid('acme'), 'certification', cert, db);
    expect(r1).toEqual({ found: true, previousRaw: undefined });
    const r2 = await updateLiveControlsKey(pid('acme'), 'complianceUsers', ['a', 'b'], db);
    expect(r2).toEqual({ found: true, previousRaw: undefined });
    const p = await createPartnerRepo(db).getPartner(pid('acme'));
    expect(p?.liveControls?.certification).toEqual(cert);
    expect(p?.liveControls?.complianceUsers).toEqual(['a', 'b']);
    const r3 = await updateLiveControlsKey(pid('acme'), 'complianceUsers', ['c'], db);
    expect(r3).toEqual({ found: true, previousRaw: ['a', 'b'] });
    // Only acme changed.
    expect((await rawColumn(db, 'default')).raw).toBe('{}');
  });

  it('an unknown key and a malformed sibling are preserved byte-for-byte', async () => {
    await setRaw(db, 'acme', '{"zeta": {"keep": [1, 2.50, "x"]}, "posture": {"version": 9}, "licence": "L-1"}');
    const subValues = async () => {
      const r = await db.execute(sql`
        SELECT (live_controls -> 'zeta')::text AS zeta, (live_controls -> 'posture')::text AS posture,
               (live_controls -> 'licence')::text AS licence FROM partners WHERE id = 'acme'`);
      return (r as unknown as { rows: Array<Record<string, string>> }).rows[0];
    };
    const before = await subValues();
    await updateLiveControlsKey(pid('acme'), 'contract', { ref: 'MSA', signedOn: '2026-01-01', recordedBy: 'a', recordedAt: new Date().toISOString() }, db);
    const row = await subValues();
    expect(row).toEqual(before);
    expect(row.zeta).toContain('2.50');
    expect(JSON.parse(row.posture)).toEqual({ version: 9 });
    expect(row.licence).toBe('"L-1"');
  });

  it('the function form receives the RAW sub-value', async () => {
    await setRaw(db, 'acme', '{"complianceUsers": ["Not Valid", "a"]}');
    const seen: unknown[] = [];
    const r = await updateLiveControlsKey(
      pid('acme'),
      'complianceUsers',
      (prev: unknown) => {
        seen.push(prev);
        return [...(prev as string[]), 'b'];
      },
      db,
    );
    expect(seen).toEqual([['Not Valid', 'a']]);
    expect(r).toEqual({ found: true, previousRaw: ['Not Valid', 'a'] });
    const raw = JSON.parse((await rawColumn(db, 'acme')).raw) as Record<string, unknown>;
    expect(raw.complianceUsers).toEqual(['Not Valid', 'a', 'b']);

    const seen2: unknown[] = [];
    await updateLiveControlsKey(pid('acme'), 'optIns', (prev: unknown) => (seen2.push(prev), {}), db);
    expect(seen2).toEqual([undefined]);
  });

  it('not found -> { found: false, previousRaw: undefined }, nothing written', async () => {
    let called = false;
    const r = await updateLiveControlsKey(pid('ghost'), 'complianceUsers', () => ((called = true), ['a']), db);
    expect(r).toEqual({ found: false, previousRaw: undefined });
    expect(called).toBe(false);
    const n = await db.execute(sql`SELECT count(*)::int AS n FROM partners WHERE id = 'ghost'`);
    expect((n as unknown as { rows: Array<{ n: number }> }).rows[0].n).toBe(0);
  });

  it('undefined value or unknown key throws, nothing written', async () => {
    await setRaw(db, 'acme', '{"complianceUsers": ["a"]}');
    const before = await rawColumn(db, 'acme');
    await expect(updateLiveControlsKey(pid('acme'), 'complianceUsers', undefined, db)).rejects.toBeInstanceOf(TypeError);
    await expect(updateLiveControlsKey(pid('acme'), 'complianceUsers', () => undefined, db)).rejects.toBeInstanceOf(TypeError);
    await expect(
      updateLiveControlsKey(pid('acme'), 'fundingMode' as LiveControlsKey, { mode: 'x' }, db),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      updateLiveControlsKey(pid('acme'), "posture'}, '{}') --" as LiveControlsKey, {}, db),
    ).rejects.toBeInstanceOf(TypeError);
    const after = await rawColumn(db, 'acme');
    expect(after.raw).toBe(before.raw);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it('locks with FOR NO KEY UPDATE', async () => {
    const stop = captureQueries();
    await updateLiveControlsKey(pid('acme'), 'complianceUsers', ['a'], db);
    const qs = stop().map((q) => q.sql.toLowerCase());
    const select = qs.find((q) => q.startsWith('select'));
    expect(select).toBeDefined();
    expect(select).toContain('for no key update');
    expect(qs.some((q) => /for update/.test(q))).toBe(false);
    expect(qs.some((q) => q.startsWith('update') && q.includes('jsonb_set'))).toBe(true);
  });

  it('a function that returns the raw value unchanged still writes it back (updated_at moves)', async () => {
    await setRaw(db, 'acme', '{"complianceUsers": ["a"]}');
    const before = await rawColumn(db, 'acme');
    await updateLiveControlsKey(pid('acme'), 'complianceUsers', (prev: unknown) => prev, db);
    const after = await rawColumn(db, 'acme');
    expect(after.raw).toBe(before.raw);
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
  });

  it("savePartner after a key write leaves live_controls unchanged; ensureDefaultPartner inserts '{}'", async () => {
    const repo = createPartnerRepo(db);
    await updateLiveControlsKey(pid('acme'), 'complianceUsers', ['a'], db);
    const before = await rawColumn(db, 'acme');
    const p = await repo.getPartner(pid('acme'));
    // A full-row save from a stale read whose liveControls was emptied must not touch the column.
    await repo.savePartner({ ...p!, name: 'Acme Renamed', liveControls: { optIns: {}, complianceUsers: [] } });
    expect((await rawColumn(db, 'acme')).raw).toBe(before.raw);
    expect((await repo.getPartner(pid('acme')))?.name).toBe('Acme Renamed');

    await repo.savePartner({ id: pid('fresh'), name: 'Fresh', countries: ['US'], status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    expect((await rawColumn(db, 'fresh')).raw).toBe('{}');

    await db.execute(sql`DELETE FROM partners WHERE id = 'default'`);
    const def = await repo.ensureDefaultPartner();
    expect(def.liveControls).toEqual(EMPTY_LIVE_CONTROLS);
    expect((await rawColumn(db, 'default')).raw).toBe('{}');
  });

  it('updated_at moves', async () => {
    await setRaw(db, 'acme', '{}');
    const before = await rawColumn(db, 'acme');
    await updateLiveControlsKey(pid('acme'), 'optIns', { b2b: { counselRef: 'm' } }, db);
    const after = await rawColumn(db, 'acme');
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
  });

  it('runs inside a caller transaction and rolls back with it', async () => {
    await expect(
      db.transaction(async (tx) => {
        await updateLiveControlsKey(pid('acme'), 'complianceUsers', ['a'], tx);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect((await rawColumn(db, 'acme')).raw).toBe('{}');
  });
});
