import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import type { Db } from '@/db/client';
import { createHash } from 'node:crypto';
import { parseOfacSdnXml, canonicalLines, hashEntries } from '@/lib/sanctions/ofac-sdn-loader';
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

/** Fix pack 2 T7: a variant whose hash is REAL (hashEntries), so the archive's hash check holds. */
function realVariant(n: number): SanctionsList {
  const entries = [
    ...LIST.entries,
    { id: `sdn:${8000 + n}`, names: [`Synthetic Real Party ${n}`], type: 'Entity', programs: ['SDGT'] },
  ];
  return { ...LIST, version: `2026-09-${String(18 + n).padStart(2, '0')}`, hash: hashEntries(entries), entries };
}

async function entryCounts(db: Db): Promise<Map<number, number>> {
  const r = await db.execute(
    sql`SELECT v.id, count(e.entry_id)::int AS n FROM sanctions_list_versions v
        LEFT JOIN sanctions_list_entries e ON e.version_id = v.id GROUP BY v.id ORDER BY v.id`,
  );
  return new Map((r as unknown as { rows: Array<{ id: number | string; n: number }> }).rows.map((x) => [Number(x.id), x.n]));
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

  // Fix pack 2 T7 (R07): storeList deletes nothing; entries go only after a verified archive.
  it('keeps every version row and all entries when nothing is archived', async () => {
    const repo = createSanctionsListRepo(db);
    for (let i = 1; i <= KEEP_INACTIVE_VERSIONS + 3; i++) await repo.storeList(realVariant(i));
    const rows = await versions(db);
    expect(rows).toHaveLength(KEEP_INACTIVE_VERSIONS + 3);
    expect(rows.filter((r) => r.active)).toHaveLength(1);
    const counts = await entryCounts(db);
    for (const r of rows) expect(counts.get(Number(r.id))).toBe(Number(r.entry_count));
    expect(await repo.pruneArchivedEntries('ofac-sdn')).toBe(0);
    expect(await entryCounts(db)).toEqual(counts);
  });

  it('pruneArchivedEntries deletes only entries of archived versions beyond KEEP; rows, hashes, active entries remain', async () => {
    const repo = createSanctionsListRepo(db);
    const lists = [1, 2, 3, 4, 5].map(realVariant);
    for (const l of lists) await repo.storeList(l);
    const at = new Date();
    for (const v of await repo.pendingArchive('ofac-sdn', 10)) {
      expect(await repo.markArchived(v.id, v.hash, `sanctions-archive/ofac-sdn/${v.version}-${v.hash}.jsonl.gz`, 'f'.repeat(64), at)).toBe(true);
    }
    const before = await versions(db);
    const deleted = await repo.pruneArchivedEntries('ofac-sdn');
    expect(deleted).toBe(2 * 6); // versions 1 and 2: inactive beyond the newest KEEP (4, 3)
    const after = await versions(db);
    expect(after).toEqual(before); // rows and hashes untouched
    const counts = await entryCounts(db);
    const idOf = (n: number) => Number(before.find((r) => r.hash === lists[n - 1].hash)!.id);
    expect(counts.get(idOf(1))).toBe(0);
    expect(counts.get(idOf(2))).toBe(0);
    expect(counts.get(idOf(3))).toBe(6);
    expect(counts.get(idOf(4))).toBe(6);
    expect(counts.get(idOf(5))).toBe(6); // active
    const active = (await repo.activeVersion('ofac-sdn'))!;
    expect((await repo.loadList(active)).entries).toHaveLength(6);
    expect(await repo.pruneArchivedEntries('ofac-sdn')).toBe(0); // idempotent
  });

  it('never prunes an unarchived version beyond KEEP', async () => {
    const repo = createSanctionsListRepo(db);
    const lists = [1, 2, 3, 4, 5].map(realVariant);
    for (const l of lists) await repo.storeList(l);
    const pending = await repo.pendingArchive('ofac-sdn', 10);
    const v2 = pending.find((v) => v.hash === lists[1].hash)!;
    await repo.markArchived(v2.id, v2.hash, 'sanctions-archive/x', 'f'.repeat(64), new Date());
    expect(await repo.pruneArchivedEntries('ofac-sdn')).toBe(6);
    const counts = await entryCounts(db);
    const v1 = pending.find((v) => v.hash === lists[0].hash)!;
    expect(counts.get(v1.id)).toBe(6); // beyond KEEP but not archived: kept
    expect(counts.get(v2.id)).toBe(0);
  });

  it('re-activating a pruned version re-inserts its entries; loadList count check passes', async () => {
    const repo = createSanctionsListRepo(db);
    const lists = [1, 2, 3, 4].map(realVariant);
    for (const l of lists) await repo.storeList(l);
    for (const v of await repo.pendingArchive('ofac-sdn', 10)) {
      await repo.markArchived(v.id, v.hash, 'sanctions-archive/x', 'f'.repeat(64), new Date());
    }
    expect(await repo.pruneArchivedEntries('ofac-sdn')).toBe(6); // version 1
    const res = await repo.storeList({ ...lists[0], version: '2026-09-30' });
    expect(res.status).toBe('activated');
    const active = (await repo.activeVersion('ofac-sdn'))!;
    expect(active.hash).toBe(lists[0].hash);
    const loaded = await repo.loadList(active);
    expect(loaded.entries).toHaveLength(6);
    expect(hashEntries(loaded.entries)).toBe(lists[0].hash);
    expect(await versions(db)).toHaveLength(4);
  });

  it('markArchived stamps once; a hash mismatch never stamps', async () => {
    const repo = createSanctionsListRepo(db);
    await repo.storeList(realVariant(1));
    const [v] = await repo.pendingArchive('ofac-sdn', 10);
    const at = new Date();
    expect(await repo.markArchived(v.id, 'b'.repeat(64), 'p', 's', at)).toBe(false);
    expect(await repo.pendingArchive('ofac-sdn', 10)).toHaveLength(1);
    expect(await repo.markArchived(v.id, v.hash, 'sanctions-archive/p', 's1', at)).toBe(true);
    expect(await repo.markArchived(v.id, v.hash, 'sanctions-archive/q', 's2', at)).toBe(false);
    const r = await db.execute(sql`SELECT archive_path, archive_sha256, archived_at FROM sanctions_list_versions`);
    const row = (r as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
    expect(row.archive_path).toBe('sanctions-archive/p');
    expect(row.archive_sha256).toBe('s1');
    expect(row.archived_at).not.toBeNull();
    expect(await repo.pendingArchive('ofac-sdn', 10)).toEqual([]);
  });

  it('entriesOf -> canonicalLines hashes to versions.hash', async () => {
    const repo = createSanctionsListRepo(db);
    await repo.storeList(LIST);
    await repo.storeList(realVariant(2));
    const pending = await repo.pendingArchive('ofac-sdn', 10);
    expect(pending.map((v) => v.version)).toEqual(['2026-09-18', '2026-09-20']); // oldest first
    for (const v of pending) {
      expect(v).toMatchObject({ source: 'ofac-sdn' });
      const entries = await repo.entriesOf(v.id);
      expect(entries).toHaveLength(v.entryCount);
      expect(createHash('sha256').update(canonicalLines(entries), 'utf8').digest('hex')).toBe(v.hash);
    }
    expect(await repo.pendingArchive('ofac-sdn', 1)).toHaveLength(1);
  });

  it('archiveSummary counts', async () => {
    const repo = createSanctionsListRepo(db);
    expect(await repo.archiveSummary('ofac-sdn')).toEqual({ versions: 0, archived: 0, pending: 0, withEntries: 0 });
    for (const n of [1, 2, 3, 4]) await repo.storeList(realVariant(n));
    for (const v of (await repo.pendingArchive('ofac-sdn', 10)).slice(0, 3)) {
      await repo.markArchived(v.id, v.hash, 'sanctions-archive/x', 's', new Date());
    }
    await repo.pruneArchivedEntries('ofac-sdn');
    expect(await repo.archiveSummary('ofac-sdn')).toEqual({ versions: 4, archived: 3, pending: 1, withEntries: 3 });
    expect(await repo.archiveSummary('other')).toEqual({ versions: 0, archived: 0, pending: 0, withEntries: 0 });
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

  it('freshDb applies 0036: the five columns exist and are nullable', async () => {
    const raw = await db.execute(sql.raw(
      `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
       WHERE (table_name = 'customers' AND column_name IN ('screening_flagged_at', 'screening_cleared_at'))
          OR (table_name = 'sanctions_list_versions' AND column_name IN ('archive_path', 'archive_sha256', 'archived_at'))
       ORDER BY table_name, column_name`,
    ));
    const rows = (raw as unknown as { rows: Array<Record<string, unknown>> }).rows;
    expect(rows).toEqual([
      { table_name: 'customers', column_name: 'screening_cleared_at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
      { table_name: 'customers', column_name: 'screening_flagged_at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
      { table_name: 'sanctions_list_versions', column_name: 'archive_path', data_type: 'text', is_nullable: 'YES', column_default: null },
      { table_name: 'sanctions_list_versions', column_name: 'archive_sha256', data_type: 'text', is_nullable: 'YES', column_default: null },
      { table_name: 'sanctions_list_versions', column_name: 'archived_at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
    ]);
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

  // Fix pack 2 T2 (R02): the list's age is the DB checked_at, read live.
  it('activeVersion returns checkedAt', async () => {
    const repo = createSanctionsListRepo(db);
    const before = Date.now();
    await repo.storeList(LIST);
    const active = (await repo.activeVersion('ofac-sdn'))!;
    expect(active.checkedAt).toBeInstanceOf(Date);
    expect(active.checkedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(active.checkedAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('an unchanged store advances checkedAt', async () => {
    const repo = createSanctionsListRepo(db);
    await repo.storeList(LIST);
    await db.execute(sql`UPDATE sanctions_list_versions SET checked_at = now() - interval '40 hours'`);
    const old = (await repo.activeVersion('ofac-sdn'))!.checkedAt!;
    expect(Date.now() - old.getTime()).toBeGreaterThan(39 * 3_600_000);
    expect((await repo.storeList(LIST)).status).toBe('unchanged');
    const now = (await repo.activeVersion('ofac-sdn'))!.checkedAt!;
    expect(Date.now() - now.getTime()).toBeLessThan(60_000);
  });

  it('stores duplicate entry ids once (first wins) instead of failing the whole load', async () => {
    const repo = createSanctionsListRepo(db);
    const dup = { ...LIST, entries: [...LIST.entries, { ...LIST.entries[0], names: ['Other Name'] }] };
    const res = await repo.storeList(dup);
    expect(res.entryCount).toBe(5);
  });
});
