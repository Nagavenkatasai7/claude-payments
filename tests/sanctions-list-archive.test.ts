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

import {
  archivePending,
  archivePathOf,
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
    const names = realVariant(2).entries.flatMap((e) => [...e.names, ...(e.weakNames ?? [])]);
    for (const { payload } of a) {
      expect(Object.keys(payload)).toEqual(['message']);
      const text = JSON.stringify(payload);
      for (const n of names) expect(text).not.toContain(n);
      expect(text).not.toMatch(/sdn:\d/);
      expect(text).not.toMatch(/token|secret|cred|passw/i);
      expect(text).not.toContain('privstore');
    }
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
