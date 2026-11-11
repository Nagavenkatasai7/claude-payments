import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import type { Db } from '@/db/client';
import { parseOfacSdnXml, hashEntries } from '@/lib/sanctions/ofac-sdn-loader';
import type { SanctionsList } from '@/lib/sanctions/list-source';
import { createSanctionsListRepo, KEEP_INACTIVE_VERSIONS } from '@/db/repos/sanctions-list-repo';
import { easternDay } from '@/lib/sanctions/list-loader';

// Fix pack 2 T7 (R07): every list version is archived to the PRIVATE Blob
// store, verified by a sha256 read-back, BEFORE its entries may be pruned.
// `@vercel/blob` is an in-memory Map (a local run never has the token).

const objects = vi.hoisted(() => new Map<string, Buffer>());
const putMock = vi.hoisted(() => vi.fn());
const getMock = vi.hoisted(() => vi.fn());
vi.mock('@vercel/blob', () => ({
  put: (...a: unknown[]) => putMock(...a),
  get: (...a: unknown[]) => getMock(...a),
  del: vi.fn(),
}));

// Review round 3 (M7): an injected cost per re-hash (each entriesOf read the
// archive makes advances the test clock), to show what the run spends where.
const rehash = vi.hoisted(() => ({ costMs: 0, clock: { t: 0 }, reads: [] as number[] }));
vi.mock('@/db/repos/sanctions-list-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/sanctions-list-repo')>();
  return {
    ...real,
    createSanctionsListRepo: (d: Parameters<typeof real.createSanctionsListRepo>[0]) => {
      const r = real.createSanctionsListRepo(d);
      return {
        ...r,
        entriesOf: async (id: number) => {
          rehash.reads.push(id);
          rehash.clock.t += rehash.costMs;
          return r.entriesOf(id);
        },
      };
    },
  };
});

import {
  alertArchiveLag,
  archivePending,
  archivePathOf,
  ARCHIVE_LAG_ALERT_DAYS,
  readArchivedVersion,
  MAX_ARCHIVES_PER_RUN,
  SANCTIONS_ARCHIVE_PREFIX,
} from '@/lib/sanctions/list-archive';
import { OBJECT_TIMEOUT_MS } from '@/lib/blob';

// Joined at runtime from plain words so no token-shaped literal exists.
const PRIVATE_TOKEN = ['fake', 'blob', 'rw', 'privstore', 'for-tests'].join('_');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

const LIST = parseOfacSdnXml(readFileSync(join(__dirname, 'fixtures', 'ofac-sdn-sample.xml'), 'utf8'));
function realVariant(n: number): SanctionsList {
  const entries = [
    ...LIST.entries,
    { id: `sdn:${8000 + n}`, names: [`Synthetic Real Party ${n}`], type: 'Entity', programs: ['SDGT'] },
  ];
  return { ...LIST, version: `2026-09-${String(18 + n).padStart(2, '0')}`, hash: hashEntries(entries), entries };
}

function defaultPut(pathname: string, body: Buffer, opts: { allowOverwrite?: boolean }) {
  if (objects.has(pathname) && opts.allowOverwrite !== true) throw new Error('This blob already exists');
  objects.set(pathname, Buffer.from(body));
  return Promise.resolve({ pathname, url: `https://privstore.private.blob.vercel-storage.com/${pathname}` });
}
function defaultGet(pathname: string) {
  const b = objects.get(pathname);
  if (!b) return Promise.resolve(null);
  return Promise.resolve({
    statusCode: 200,
    stream: new Blob([new Uint8Array(b)]).stream(),
    headers: new Headers(),
    blob: { contentType: 'application/gzip', size: b.length },
  });
}

async function q<T = Record<string, unknown>>(db: Db, query: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(query)) as unknown as { rows: T[] }).rows;
}
const alerts = (db: Db) =>
  q<{ payload: { message: string }; dedupe_key: string }>(
    db,
    sql`SELECT payload, dedupe_key FROM outbox WHERE kind = 'ops.alert' ORDER BY id`,
  );
const versionRows = (db: Db) =>
  q<{ id: number; hash: string; archive_path: string | null; archive_sha256: string | null; archived_at: unknown }>(
    db,
    sql`SELECT id, hash, archive_path, archive_sha256, archived_at FROM sanctions_list_versions ORDER BY id`,
  );
async function entryCount(db: Db, id: number): Promise<number> {
  const r = await q<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM sanctions_list_entries WHERE version_id = ${id}`);
  return r[0].n;
}

describe('sanctions list archive (R07)', () => {
  let db: Db;
  const saved = process.env.PARTNER_DOCS_BLOB_READ_WRITE_TOKEN;
  beforeEach(async () => {
    db = await freshDb();
    objects.clear();
    putMock.mockReset().mockImplementation(defaultPut);
    getMock.mockReset().mockImplementation(defaultGet);
    process.env.PARTNER_DOCS_BLOB_READ_WRITE_TOKEN = PRIVATE_TOKEN;
    rehash.costMs = 0;
    rehash.clock.t = 0;
    rehash.reads.length = 0;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.PARTNER_DOCS_BLOB_READ_WRITE_TOKEN;
    else process.env.PARTNER_DOCS_BLOB_READ_WRITE_TOKEN = saved;
  });

  it('round trip: gunzipped object hashes to versions.hash; archive_sha256 = sha256(stored bytes); path under sanctions-archive/ofac-sdn/', async () => {
    const repo = createSanctionsListRepo(db);
    await repo.storeList(LIST);
    const res = await archivePending(db);
    expect(res).toEqual({ status: 'done', archived: 1, failed: 0, pruned: 0 });
    const [row] = await versionRows(db);
    expect(row.archive_path).toBe(archivePathOf({ source: 'ofac-sdn', version: LIST.version, hash: LIST.hash }));
    expect(row.archive_path).toBe(`sanctions-archive/ofac-sdn/${LIST.version}-${LIST.hash}.jsonl.gz`);
    expect(row.archive_path!.startsWith(`${SANCTIONS_ARCHIVE_PREFIX}ofac-sdn/`)).toBe(true);
    const stored = objects.get(row.archive_path!)!;
    expect(row.archive_sha256).toBe(sha(stored));
    expect(sha(gunzipSync(stored).toString('utf8'))).toBe(LIST.hash);
    expect(row.archived_at).not.toBeNull();
    const text = await readArchivedVersion(row.archive_path!);
    expect(text).not.toBeNull();
    expect(sha(text!)).toBe(LIST.hash);
    expect(await readArchivedVersion('sanctions-archive/ofac-sdn/missing.jsonl.gz')).toBeNull();
    expect(await readArchivedVersion('partner-applications/x/doc.pdf')).toBeNull();
  });

  it('put is private, no suffix, no overwrite, explicit token', async () => {
    await createSanctionsListRepo(db).storeList(LIST);
    await archivePending(db);
    expect(putMock).toHaveBeenCalledTimes(1);
    const [pathname, body, opts] = putMock.mock.calls[0] as [string, Buffer, Record<string, unknown>];
    expect(pathname.startsWith('sanctions-archive/ofac-sdn/')).toBe(true);
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(opts).toMatchObject({
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: 'application/gzip',
      token: PRIVATE_TOKEN,
    });
    expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
    const [, getOpts] = getMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(getOpts).toMatchObject({ access: 'private', token: PRIVATE_TOKEN, useCache: false });
  });

  it('second run is a no-op', async () => {
    await createSanctionsListRepo(db).storeList(LIST);
    await archivePending(db);
    putMock.mockClear();
    getMock.mockClear();
    expect(await archivePending(db)).toEqual({ status: 'done', archived: 0, failed: 0, pruned: 0 });
    expect(putMock).not.toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();
  });

  it('archives at most MAX_ARCHIVES_PER_RUN versions per run, oldest first', async () => {
    const repo = createSanctionsListRepo(db);
    for (const n of [1, 2, 3, 4]) await repo.storeList(realVariant(n));
    expect((await archivePending(db)).archived).toBe(MAX_ARCHIVES_PER_RUN);
    const rows = await versionRows(db);
    expect(rows.map((r) => r.archived_at !== null)).toEqual([true, true, true, false]);
    expect((await archivePending(db)).archived).toBe(1);
  });

  // Pack 2 review F3 (C3): a total budget. A version is not STARTED unless
  // 2 x OBJECT_TIMEOUT_MS (its put + its read-back) is still left.
  it('time budget: a slow put leaves < 2 x OBJECT_TIMEOUT_MS -> no further version is started (deferred)', async () => {
    const repo = createSanctionsListRepo(db);
    for (const n of [1, 2, 3, 4]) await repo.storeList(realVariant(n));
    const clock = { t: 7_000_000 };
    putMock.mockImplementation((...a: Parameters<typeof defaultPut>) => {
      clock.t += 10_000;
      return defaultPut(...a);
    });
    const res = await archivePending(db, { budgetMs: 2 * OBJECT_TIMEOUT_MS + 5_000, clock: () => clock.t });
    // The one archived version (the oldest, beyond KEEP_INACTIVE_VERSIONS) is pruned as before.
    expect(res).toEqual({ status: 'done', archived: 1, failed: 0, pruned: 6, deferred: 2 });
    expect(putMock).toHaveBeenCalledTimes(1);
    expect((await versionRows(db)).map((r) => r.archived_at !== null)).toEqual([true, false, false, false]);
    expect(await alerts(db)).toEqual([]);
  });

  it('time budget below 2 x OBJECT_TIMEOUT_MS -> nothing is started, nothing pruned', async () => {
    const repo = createSanctionsListRepo(db);
    for (const n of [1, 2, 3, 4]) await repo.storeList(realVariant(n));
    const res = await archivePending(db, { budgetMs: 2 * OBJECT_TIMEOUT_MS - 1 });
    expect(res).toEqual({ status: 'done', archived: 0, failed: 0, pruned: 0, deferred: 3 });
    expect(putMock).not.toHaveBeenCalled();
    for (const r of await versionRows(db)) expect(await entryCount(db, r.id)).toBe(6);
  });

  it('put throws but the object exists and verifies -> stamped (heal)', async () => {
    await createSanctionsListRepo(db).storeList(LIST);
    // A crashed earlier run left the object; the no-overwrite put now throws.
    const path = archivePathOf({ source: 'ofac-sdn', version: LIST.version, hash: LIST.hash });
    const { canonicalLines } = await import('@/lib/sanctions/ofac-sdn-loader');
    const earlier = gzipSync(Buffer.from(canonicalLines(LIST.entries), 'utf8'));
    objects.set(path, earlier);
    const res = await archivePending(db);
    expect(putMock).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ archived: 1, failed: 0 });
    const [row] = await versionRows(db);
    expect(row.archive_sha256).toBe(sha(earlier));
    expect(await alerts(db)).toEqual([]);
  });

  it('put throws, nothing readable -> not stamped, not pruned, one failed alert per day', async () => {
    const repo = createSanctionsListRepo(db);
    for (const n of [1, 2, 3, 4]) await repo.storeList(realVariant(n));
    putMock.mockImplementation(() => Promise.reject(new Error('network down')));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await archivePending(db);
    expect(res).toEqual({ status: 'done', archived: 0, failed: 3, pruned: 0 });
    await archivePending(db);
    err.mockRestore();
    expect((await versionRows(db)).every((r) => r.archived_at === null)).toBe(true);
    for (const r of await versionRows(db)) expect(await entryCount(db, r.id)).toBe(6);
    const a = await alerts(db);
    expect(a).toHaveLength(1);
    expect(a[0].dedupe_key).toBe(`sanctions-archive-failed:ofac-sdn:${easternDay(Date.now())}`);
  });

  it('read-back differs -> not stamped', async () => {
    await createSanctionsListRepo(db).storeList(LIST);
    getMock.mockImplementation((pathname: string) => {
      objects.set(pathname, gzipSync(Buffer.from('something else', 'utf8')));
      return defaultGet(pathname);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await archivePending(db);
    vi.restoreAllMocks();
    expect(res).toMatchObject({ archived: 0, failed: 1 });
    expect((await versionRows(db))[0].archived_at).toBeNull();
    expect(await alerts(db)).toHaveLength(1);
  });

  it('a read-back that is not gzip -> not stamped', async () => {
    await createSanctionsListRepo(db).storeList(LIST);
    getMock.mockImplementation((pathname: string) => {
      objects.set(pathname, Buffer.from('not gzip at all'));
      return defaultGet(pathname);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await archivePending(db);
    vi.restoreAllMocks();
    expect(res).toMatchObject({ archived: 0, failed: 1 });
    expect((await versionRows(db))[0].archived_at).toBeNull();
  });

  it('duplicate-uid version -> skipped, never pruned', async () => {
    const repo = createSanctionsListRepo(db);
    // The parser keeps a repeated uid (and hashes it); storeList keeps the first only.
    const dupEntries = [...realVariant(1).entries, { ...LIST.entries[0], names: ['Other Name'] }];
    const dup: SanctionsList = { ...realVariant(1), hash: hashEntries(dupEntries), entries: dupEntries };
    await repo.storeList(dup);
    for (const n of [2, 3, 4]) await repo.storeList(realVariant(n));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await archivePending(db);
    const res = await archivePending(db);
    vi.restoreAllMocks();
    const rows = await versionRows(db);
    expect(rows[0].archived_at).toBeNull();
    expect(rows.slice(1).every((r) => r.archived_at !== null)).toBe(true);
    expect(res.failed).toBe(1);
    expect(await entryCount(db, rows[0].id)).toBe(6); // beyond KEEP, unarchived: kept
    expect([...objects.keys()].some((k) => k.includes(dup.hash))).toBe(false); // never put
    expect(await alerts(db)).toHaveLength(1);
  });

  // Pack 2 review R4 (H3): a version whose stored entries do not hash to its
  // version hash can never archive. It must not hold the oldest-first queue:
  // the run moves past it, and still attempts up to MAX_ARCHIVES_PER_RUN
  // other versions. Its entries are never pruned.
  function dupVariant(n: number): SanctionsList {
    const dupEntries = [...realVariant(n).entries, { ...LIST.entries[0], names: ['Other Name'] }];
    return { ...realVariant(n), hash: hashEntries(dupEntries), entries: dupEntries };
  }

  it('three mismatched versions at the head do not block later versions; their entries are never pruned', async () => {
    const repo = createSanctionsListRepo(db);
    for (const n of [1, 2, 3]) await repo.storeList(dupVariant(n));
    for (const n of [4, 5, 6, 7]) await repo.storeList(realVariant(n));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = await archivePending(db);
    expect(first).toMatchObject({ status: 'done', archived: MAX_ARCHIVES_PER_RUN, failed: 3 });
    expect((await versionRows(db)).map((r) => r.archived_at !== null)).toEqual([false, false, false, true, true, true, false]);
    const second = await archivePending(db);
    vi.restoreAllMocks();
    expect(second).toMatchObject({ archived: 1, failed: 3 });
    const rows = await versionRows(db);
    expect(rows.map((r) => r.archived_at !== null)).toEqual([false, false, false, true, true, true, true]);
    // Mismatched, inactive and beyond KEEP_INACTIVE_VERSIONS: kept, never put.
    for (const r of rows.slice(0, 3)) {
      expect(await entryCount(db, r.id)).toBe(6);
      expect([...objects.keys()].some((k) => k.includes(r.hash))).toBe(false);
    }
    // The archived ones beyond KEEP are pruned as before.
    expect(await entryCount(db, rows[3].id)).toBe(0);
  });

  // Review round 3 (M7): a version whose stored entry count differs from its
  // recorded entry_count can never hash to its version hash. One grouped count
  // finds it without a re-hash, so the run spends its budget on the real
  // candidates (archived first, oldest first) and still raises the mismatch alert.
  async function countMismatched(n: number): Promise<number> {
    const repo = createSanctionsListRepo(db);
    await repo.storeList(realVariant(n));
    const id = (await versionRows(db)).at(-1)!.id;
    await db.execute(sql`DELETE FROM sanctions_list_entries WHERE version_id = ${id} AND entry_id = ${'sdn:' + (8000 + n)}`);
    return id;
  }

  it('count-mismatched versions at the head are not re-hashed: the good version behind them is archived in the same run', async () => {
    const bad: number[] = [];
    for (const n of [1, 2, 3, 4, 5]) bad.push(await countMismatched(n));
    await createSanctionsListRepo(db).storeList(realVariant(6));
    rehash.costMs = 10_000; // each re-hash costs 10 s of the 150 s budget
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await archivePending(db, { clock: () => rehash.clock.t });
    quiet.mockRestore(); // not restoreAllMocks: that also drops the Blob mocks' implementations
    expect(res).toEqual({ status: 'done', archived: 1, failed: 5, pruned: 0 });
    const rows = await versionRows(db);
    expect(rows.map((r) => r.archived_at !== null)).toEqual([false, false, false, false, false, true]);
    expect(rehash.reads).toEqual([rows[5].id]); // only the real candidate was read and hashed
    // Never archived, never put, never pruned.
    for (const id of bad) {
      expect(await entryCount(db, id)).toBe(5);
      expect([...objects.keys()].some((k) => k.includes(rows.find((r) => r.id === id)!.hash))).toBe(false);
    }
    const a = await alerts(db);
    expect(a.map((x) => x.dedupe_key)).toEqual([`sanctions-archive-mismatch:ofac-sdn:${easternDay(Date.now())}`]);
    expect(a[0].payload.message).toMatch(/5 ofac-sdn version/);
  });

  it('count-mismatched versions do not count toward MAX_ARCHIVES_PER_RUN; real candidates keep the oldest-first order', async () => {
    const repo = createSanctionsListRepo(db);
    await repo.storeList(realVariant(1));
    const bad = [await countMismatched(2), await countMismatched(3)];
    for (const n of [4, 5, 6]) await repo.storeList(realVariant(n));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await archivePending(db);
    quiet.mockRestore(); // not restoreAllMocks: that also drops the Blob mocks' implementations
    expect(res).toMatchObject({ status: 'done', archived: MAX_ARCHIVES_PER_RUN, failed: 2 });
    const rows = await versionRows(db);
    expect(rows.map((r) => r.archived_at !== null)).toEqual([true, false, false, true, true, false]);
    expect(rehash.reads).toEqual([rows[0].id, rows[3].id, rows[4].id]);
    for (const id of bad) expect(await entryCount(db, id)).toBe(5);
  });

  it('a version whose counts agree again is re-hashed and archived on the next run (the check is per run, nothing is remembered)', async () => {
    const repo = createSanctionsListRepo(db);
    await repo.storeList(realVariant(1));
    const id = (await versionRows(db))[0].id;
    await db.execute(sql`UPDATE sanctions_list_versions SET entry_count = entry_count + 1 WHERE id = ${id}`);
    await repo.storeList(realVariant(2));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await archivePending(db)).toMatchObject({ archived: 1, failed: 1 });
    quiet.mockRestore(); // not restoreAllMocks: that also drops the Blob mocks' implementations
    expect(rehash.reads).not.toContain(id);
    await db.execute(sql`UPDATE sanctions_list_versions SET entry_count = entry_count - 1 WHERE id = ${id}`);
    expect(await archivePending(db)).toMatchObject({ archived: 1, failed: 0 });
    expect((await versionRows(db))[0].archived_at).not.toBeNull();
  });

  it('a mismatch alert says a person must act and that the next run will not repair it (counts and source only)', async () => {
    const repo = createSanctionsListRepo(db);
    await repo.storeList(dupVariant(1));
    await repo.storeList(realVariant(2));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await archivePending(db);
    await archivePending(db);
    vi.restoreAllMocks();
    const a = await alerts(db);
    expect(a).toHaveLength(1);
    expect(a[0].dedupe_key).toBe(`sanctions-archive-mismatch:ofac-sdn:${easternDay(Date.now())}`);
    const msg = a[0].payload.message;
    expect(msg).toMatch(/1 ofac-sdn version/);
    expect(msg).toMatch(/a person must/i);
    expect(msg).toMatch(/will not repair/i);
    expect(msg).not.toMatch(/retries/);
    expect(Object.keys(a[0].payload)).toEqual(['message']);
    expect(msg).not.toMatch(/sdn:\d/);
    for (const n of dupVariant(1).entries.flatMap((e) => e.names)) expect(msg).not.toContain(n);
  });

  it("Blob unconfigured -> 'unconfigured', entries kept, one alert per day only when pending", async () => {
    delete process.env.PARTNER_DOCS_BLOB_READ_WRITE_TOKEN;
    expect(await archivePending(db)).toEqual({ status: 'unconfigured', archived: 0, failed: 0, pruned: 0 });
    expect(await alerts(db)).toEqual([]); // nothing pending: no alert
    const repo = createSanctionsListRepo(db);
    for (const n of [1, 2, 3, 4]) await repo.storeList(realVariant(n));
    expect(await archivePending(db)).toEqual({ status: 'unconfigured', archived: 0, failed: 0, pruned: 0 });
    await archivePending(db);
    expect(putMock).not.toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();
    for (const r of await versionRows(db)) expect(await entryCount(db, r.id)).toBe(6);
    const a = await alerts(db);
    expect(a).toHaveLength(1);
    expect(a[0].dedupe_key).toBe(`sanctions-archive-unconfigured:${easternDay(Date.now())}`);
  });

  it('pack 5 LC3: Blob unconfigured, pending ofac-cons and un-sc on the same day -> one alert per source, each naming its own; the ofac-sdn key keeps no source', async () => {
    delete process.env.PARTNER_DOCS_BLOB_READ_WRITE_TOKEN;
    const repo = createSanctionsListRepo(db);
    await repo.storeList({ ...realVariant(1), source: 'ofac-cons' });
    await repo.storeList({ ...realVariant(2), source: 'un-sc' });
    const day = easternDay(Date.now());
    for (const source of ['ofac-cons', 'un-sc', 'ofac-cons', 'un-sc']) {
      expect(await archivePending(db, { source })).toEqual({ status: 'unconfigured', archived: 0, failed: 0, pruned: 0 });
    }
    let a = await alerts(db);
    expect(a.map((r) => r.dedupe_key)).toEqual([
      `sanctions-archive-unconfigured:ofac-cons:${day}`,
      `sanctions-archive-unconfigured:un-sc:${day}`,
    ]);
    expect(a[0].payload.message).toContain('ofac-cons list versions are kept in the database');
    expect(a[0].payload.message).not.toContain('un-sc');
    expect(a[1].payload.message).toContain('un-sc list versions are kept in the database');
    expect(a[1].payload.message).not.toContain('ofac-cons');
    // ofac-sdn (the old modes' only caller) keeps the key byte-identical.
    await repo.storeList(realVariant(3));
    await archivePending(db);
    a = await alerts(db);
    expect(a).toHaveLength(3);
    expect(a[2].dedupe_key).toBe(`sanctions-archive-unconfigured:${day}`);
    expect(a[2].payload.message).toBe(
      `⚠️ SmartRemit ops: the sanctions list archive cannot run: the private partner-docs Blob store is not ` +
        `configured. ofac-sdn list versions are kept in the database (none is pruned) until it is.`,
    );
  });

  it('prunes only after a verified archive (4 loads + archive -> old entries gone, rows kept)', async () => {
    const repo = createSanctionsListRepo(db);
    for (const n of [1, 2, 3, 4]) await repo.storeList(realVariant(n));
    const res = await archivePending(db);
    expect(res).toEqual({ status: 'done', archived: 3, failed: 0, pruned: 6 });
    const rows = await versionRows(db);
    expect(rows).toHaveLength(4);
    expect(await entryCount(db, rows[0].id)).toBe(0); // oldest: inactive beyond KEEP, archived
    for (const r of rows.slice(1)) expect(await entryCount(db, r.id)).toBe(6);
    expect(KEEP_INACTIVE_VERSIONS).toBe(2);
    // The archive still holds the pruned version, byte-for-byte.
    const text = await readArchivedVersion(rows[0].archive_path!);
    expect(sha(text!)).toBe(rows[0].hash);
  });

  it(`pack 5 LC2: alertArchiveLag raises ONE deduped alert per source per day when the oldest unarchived version is older than ${3} days`, async () => {
    expect(ARCHIVE_LAG_ALERT_DAYS).toBe(3);
    const repo = createSanctionsListRepo(db);
    await repo.storeList({ ...realVariant(1), source: 'ofac-cons' });
    await repo.storeList({ ...realVariant(2), source: 'ofac-cons' });
    await repo.storeList({ ...realVariant(3), source: 'un-sc' });
    const now = new Date();
    // Young (just loaded): nothing.
    expect(await alertArchiveLag(db, 'ofac-cons', now)).toBe(false);
    expect(await alerts(db)).toEqual([]);
    // Make the first ofac-cons version 4 days old (the loop deferred it).
    const [first] = await repo.pendingArchive('ofac-cons', 1);
    const fourDays = new Date(now.getTime() - 4 * 86_400_000 - 60_000);
    await db.execute(sql`UPDATE sanctions_list_versions SET loaded_at = ${fourDays.toISOString()} WHERE id = ${first.id}`);
    expect(await alertArchiveLag(db, 'ofac-cons', now)).toBe(true);
    expect(await alertArchiveLag(db, 'ofac-cons', now)).toBe(true); // same day: deduped
    expect(await alertArchiveLag(db, 'un-sc', now)).toBe(false); // young
    expect(await alertArchiveLag(db, 'in-mha-uapa', now)).toBe(false); // nothing pending
    const a = await alerts(db);
    expect(a).toHaveLength(1);
    expect(a[0].dedupe_key).toBe(`sanctions-archive-lag:ofac-cons:${easternDay(now.getTime())}`);
    expect(Object.keys(a[0].payload)).toEqual(['message']);
    expect(a[0].payload.message).toBe(
      `⚠️ SmartRemit ops: the sanctions list archive is behind for ofac-cons: the oldest unarchived version is 4 day(s) old ` +
        `and 2 version(s) wait. They keep their entries (nothing unarchived is pruned). ` +
        `Check the sanctions lists page and the logs.`,
    );
    // Exactly 3 days old: not over the limit.
    await db.execute(sql`UPDATE sanctions_list_versions SET loaded_at = ${new Date(now.getTime() - 3 * 86_400_000).toISOString()} WHERE source = 'un-sc'`);
    expect(await alertArchiveLag(db, 'un-sc', now)).toBe(false);
  });

  it('pack 5 LC2: alertArchiveLag never throws on a db error', async () => {
    const broken = { select: () => { throw new Error('db down'); } } as unknown as Db;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(alertArchiveLag(broken, 'ofac-cons', new Date())).resolves.toBe(false);
    err.mockRestore();
  });

  it('alert payloads carry no names, entry ids or token words', async () => {
    const repo = createSanctionsListRepo(db);
    for (const n of [1, 2]) await repo.storeList(realVariant(n));
    putMock.mockImplementation(() => Promise.reject(new Error(`boom ${PRIVATE_TOKEN} Synthetic Real Party 1`)));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await archivePending(db);
    delete process.env.PARTNER_DOCS_BLOB_READ_WRITE_TOKEN;
    await archivePending(db);
    vi.restoreAllMocks();
    const a = await alerts(db);
    expect(a).toHaveLength(2);
    // Pack 2 review R5 (J5): check the names of BOTH stored versions, so the
    // name the injected error carries ('Synthetic Real Party 1') is checked.
    const names = [1, 2].flatMap((n) => realVariant(n).entries.flatMap((e) => [...e.names, ...(e.weakNames ?? [])]));
    expect(names).toContain('Synthetic Real Party 1');
    for (const { payload } of a) {
      expect(Object.keys(payload)).toEqual(['message']);
      const text = JSON.stringify(payload);
      for (const n of names) expect(text).not.toContain(n);
      expect(text).not.toContain('Synthetic Real Party');
      expect(text).not.toMatch(/sdn:\d/);
      expect(text).not.toMatch(/token|secret|cred|passw/i);
      expect(text).not.toContain('privstore');
    }
  });

  it('a store error that carries only an entry name (no token word) does not reach the alert', async () => {
    const repo = createSanctionsListRepo(db);
    for (const n of [1, 2]) await repo.storeList(realVariant(n));
    putMock.mockImplementation(() => Promise.reject(new Error('boom Synthetic Real Party 1')));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await archivePending(db);
    vi.restoreAllMocks();
    const a = await alerts(db);
    expect(a.map((r) => r.dedupe_key)).toEqual([expect.stringMatching(/^sanctions-archive-failed:/)]);
    const names = [1, 2].flatMap((n) => realVariant(n).entries.flatMap((e) => [...e.names, ...(e.weakNames ?? [])]));
    const text = JSON.stringify(a[0].payload);
    for (const n of names) expect(text).not.toContain(n);
    expect(text).not.toContain('Synthetic Real Party');
  });

  it('never throws on a db error', async () => {
    const broken = {
      select: () => {
        throw new Error('db down');
      },
      transaction: () => Promise.reject(new Error('db down')),
      execute: () => Promise.reject(new Error('db down')),
      insert: () => {
        throw new Error('db down');
      },
    } as unknown as Db;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(archivePending(broken)).resolves.toMatchObject({ status: 'done', archived: 0 });
    delete process.env.PARTNER_DOCS_BLOB_READ_WRITE_TOKEN;
    await expect(archivePending(broken)).resolves.toMatchObject({ status: 'unconfigured', archived: 0 });
    vi.restoreAllMocks();
  });
});
