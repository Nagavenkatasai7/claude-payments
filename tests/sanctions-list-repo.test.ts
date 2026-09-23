import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import type { Db } from '@/db/client';
import { parseOfacSdnXml } from '@/lib/sanctions/ofac-sdn-loader';
import type { SanctionsList } from '@/lib/sanctions/list-source';
import {
  createSanctionsListRepo,
  SanctionsListShrinkError,
  SanctionsListStaleError,
  KEEP_INACTIVE_VERSIONS,
} from '@/db/repos/sanctions-list-repo';

// Program-Fix 14 PR C: the Postgres-backed sanctions list (migration 0023).
// Real Postgres (PGlite): the partial unique "one active version" index, the
// FK cascade and the transaction are exactly what is under test.

const LIST = parseOfacSdnXml(readFileSync(join(__dirname, 'fixtures', 'ofac-sdn-sample.xml'), 'utf8'));

function variant(n: number, extraEntries = 0): SanctionsList {
  const entries = [...LIST.entries];
  for (let i = 0; i < extraEntries; i++) {
    entries.push({ id: `sdn:${9000 + n * 100 + i}`, names: [`Synthetic Party ${n} ${i}`], type: 'Entity', programs: ['SDGT'] });
  }
  return { ...LIST, version: `2026-09-${String(18 + n).padStart(2, '0')}`, hash: `${String(n).padStart(2, '0')}${'a'.repeat(62)}`, entries };
}

async function versions(db: Db) {
  const r = await db.execute(
    sql`SELECT id, version, hash, active, entry_count FROM sanctions_list_versions ORDER BY id`,
  );
  return (r as unknown as { rows: Array<Record<string, unknown>> }).rows;
}

describe('sanctions list repo (Postgres, migration 0023)', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
  });

  it('with nothing loaded there is no active version (the screener then fails closed)', async () => {
    const repo = createSanctionsListRepo(db);
    expect(await repo.activeVersion('ofac-sdn')).toBeNull();
  });

  it('stores a list with its entries and activates it in one go; the round trip is lossless', async () => {
    const repo = createSanctionsListRepo(db);
    const res = await repo.storeList(LIST);
    expect(res).toMatchObject({ status: 'activated', entryCount: 5 });
    const active = await repo.activeVersion('ofac-sdn');
    expect(active).toMatchObject({ version: '2026-09-18', hash: LIST.hash, entryCount: 5 });
    const loaded = await repo.loadList(active!);
    expect(loaded.source).toBe('ofac-sdn');
    expect(loaded.version).toBe('2026-09-18');
    expect(loaded.hash).toBe(LIST.hash);
    const byId = (l: SanctionsList) => [...l.entries].sort((a, b) => a.id.localeCompare(b.id));
    expect(byId(loaded).map((e) => ({ ...e, weakNames: e.weakNames ?? [] }))).toEqual(
      byId(LIST).map((e) => ({ ...e, weakNames: e.weakNames ?? [] })),
    );
  });

  it('re-storing the same content is a no-op ("unchanged"): no second version row', async () => {
    const repo = createSanctionsListRepo(db);
    await repo.storeList(LIST);
    const again = await repo.storeList(LIST);
    expect(again.status).toBe('unchanged');
    expect(await versions(db)).toHaveLength(1);
  });

  it('a new version switches the active pointer atomically: exactly one active row', async () => {
    const repo = createSanctionsListRepo(db);
    await repo.storeList(LIST);
    const res = await repo.storeList(variant(1, 1));
    expect(res.status).toBe('activated');
    const rows = await versions(db);
    expect(rows.filter((r) => r.active)).toHaveLength(1);
    expect((await repo.activeVersion('ofac-sdn'))!.hash).toBe(variant(1).hash);
  });

  it('the database itself refuses a second active version for a source', async () => {
    const repo = createSanctionsListRepo(db);
    await repo.storeList(LIST);
    await expect(
      db.execute(sql`INSERT INTO sanctions_list_versions (source, version, hash, entry_count, name_count, active)
                     VALUES ('ofac-sdn', 'x', 'y', 1, 1, true)`),
    ).rejects.toThrow();
  });

  it('refuses a list that shrank sharply against the active one (truncated download) and keeps the last good', async () => {
    const repo = createSanctionsListRepo(db);
    await repo.storeList(variant(1, 20)); // 25 entries
    const tiny = { ...variant(2), entries: LIST.entries.slice(0, 3) };
    await expect(repo.storeList(tiny)).rejects.toBeInstanceOf(SanctionsListShrinkError);
    expect((await repo.activeVersion('ofac-sdn'))!.hash).toBe(variant(1).hash);
    expect(await versions(db)).toHaveLength(1); // the refused insert rolled back
  });

  it('a failure mid-store rolls back the new version and its entries (the old one stays active)', async () => {
    const repo = createSanctionsListRepo(db);
    await repo.storeList(LIST);
    const bad = { ...variant(1), entries: [...LIST.entries, { id: 'sdn:x', names: null as unknown as string[], type: 'Entity', programs: [] }] };
    await expect(repo.storeList(bad)).rejects.toThrow();
    const rows = await versions(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].active).toBe(true);
    const n = await db.execute(sql`SELECT count(*)::int AS n FROM sanctions_list_entries`);
    expect((n as unknown as { rows: Array<{ n: number }> }).rows[0].n).toBe(5);
  });

  it(`keeps at most ${KEEP_INACTIVE_VERSIONS} superseded versions (the entries cascade away)`, async () => {
    const repo = createSanctionsListRepo(db);
    for (let i = 1; i <= KEEP_INACTIVE_VERSIONS + 3; i++) await repo.storeList(variant(i));
    const rows = await versions(db);
    expect(rows).toHaveLength(KEEP_INACTIVE_VERSIONS + 1);
    expect(rows.filter((r) => r.active)).toHaveLength(1);
    const ids = rows.map((r) => r.id);
    const orphans = await db.execute(
      sql`SELECT count(*)::int AS n FROM sanctions_list_entries WHERE version_id NOT IN (SELECT id FROM sanctions_list_versions)`,
    );
    expect((orphans as unknown as { rows: Array<{ n: number }> }).rows[0].n).toBe(0);
    expect(ids.length).toBe(KEEP_INACTIVE_VERSIONS + 1);
  });

  it('an OLDER publication (a replayed or stale export) is refused: the list only moves forward', async () => {
    const repo = createSanctionsListRepo(db);
    await repo.storeList(variant(1));
    await repo.storeList(variant(2));
    await expect(repo.storeList(variant(1))).rejects.toBeInstanceOf(SanctionsListStaleError);
    await expect(repo.storeList({ ...variant(3), version: '2026-09-01' })).rejects.toBeInstanceOf(SanctionsListStaleError);
    expect((await repo.activeVersion('ofac-sdn'))!.hash).toBe(variant(2).hash);
  });

  it('content seen before under a same-or-newer date is re-activated, not re-inserted', async () => {
    const repo = createSanctionsListRepo(db);
    await repo.storeList(variant(1));
    await repo.storeList(variant(2));
    const res = await repo.storeList({ ...variant(1), version: '2026-09-25' });
    expect(res.status).toBe('activated');
    expect(await versions(db)).toHaveLength(2);
  });

  it('refuses a list below the absolute entry floor, even with no active version (first load)', async () => {
    const repo = createSanctionsListRepo(db);
    await expect(repo.storeList(LIST, { minEntries: 6 })).rejects.toBeInstanceOf(SanctionsListShrinkError);
    expect(await repo.activeVersion('ofac-sdn')).toBeNull();
  });

  it('the shrink ratio also applies when the newest version was deactivated by hand', async () => {
    const repo = createSanctionsListRepo(db);
    await repo.storeList(variant(1, 20));
    await db.execute(sql`UPDATE sanctions_list_versions SET active = false`);
    await expect(repo.storeList({ ...variant(2), entries: LIST.entries.slice(0, 3) })).rejects.toBeInstanceOf(
      SanctionsListShrinkError,
    );
  });

  it('loadList refuses a version whose stored entries do not match its entry count', async () => {
    const repo = createSanctionsListRepo(db);
    await repo.storeList(LIST);
    const active = (await repo.activeVersion('ofac-sdn'))!;
    await expect(repo.loadList({ ...active, entryCount: 6 })).rejects.toThrow(/entries/);
  });

  it('stores duplicate entry ids once (first wins) instead of failing the whole load', async () => {
    const repo = createSanctionsListRepo(db);
    const dup = { ...LIST, entries: [...LIST.entries, { ...LIST.entries[0], names: ['Other Name'] }] };
    const res = await repo.storeList(dup);
    expect(res.entryCount).toBe(5);
  });
});
