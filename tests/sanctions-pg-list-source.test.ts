import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb } from './helpers-db';
import { parseOfacSdnXml } from '@/lib/sanctions/ofac-sdn-loader';
import { createSanctionsListRepo, type ActiveSanctionsVersion } from '@/db/repos/sanctions-list-repo';
import { PostgresSanctionsListSource, NoActiveSanctionsListError } from '@/lib/sanctions/pg-list-source';
import { ListSanctionsScreener, SanctionsListUnavailableError } from '@/lib/sanctions/list-screener';
import type { SanctionsList } from '@/lib/sanctions/list-source';

// Program-Fix 14 PR C: the screener's list comes from Postgres. The hot path
// (load) never touches the database once a version is cached — it runs inside
// the mint's transaction, and a second pool connection there is what the pool
// sizing (db/client.ts) rules out. warm() (called BEFORE the sender lock) is
// the only refresh, on a TTL. No version loaded ⇒ load rejects ⇒ the screener
// fails CLOSED (flagged, list_unavailable).

const LIST = parseOfacSdnXml(readFileSync(join(__dirname, 'fixtures', 'ofac-sdn-sample.xml'), 'utf8'));
const V1: ActiveSanctionsVersion = { id: 1, source: 'ofac-sdn', version: LIST.version, hash: LIST.hash, entryCount: 5 };
const LIST2: SanctionsList = { ...LIST, version: '2026-09-22', hash: 'b'.repeat(64) };
const V2: ActiveSanctionsVersion = { ...V1, id: 2, version: LIST2.version, hash: LIST2.hash };

function fakeRepo(active: ActiveSanctionsVersion | null) {
  const state = { active };
  return {
    state,
    activeVersion: vi.fn(async () => state.active),
    loadList: vi.fn(async (v: ActiveSanctionsVersion) => (v.id === 1 ? LIST : LIST2)),
  };
}

describe('PostgresSanctionsListSource', () => {
  let clock: number;
  const now = () => clock;
  beforeEach(() => {
    clock = 1_000_000;
  });

  it('cold: load() reads the active version once, then serves it from memory with no DB call', async () => {
    const repo = fakeRepo(V1);
    const src = new PostgresSanctionsListSource(() => repo, { now });
    const a = await src.load();
    const b = await src.load();
    expect(a).toBe(LIST);
    expect(b).toBe(a); // same object ⇒ the screener does not re-index
    expect(repo.activeVersion).toHaveBeenCalledTimes(1);
    expect(repo.loadList).toHaveBeenCalledTimes(1);
  });

  it('concurrent cold loads share one query (single flight)', async () => {
    const repo = fakeRepo(V1);
    const src = new PostgresSanctionsListSource(() => repo, { now });
    await Promise.all([src.load(), src.load(), src.load()]);
    expect(repo.loadList).toHaveBeenCalledTimes(1);
  });

  it('no active version FAILS CLOSED: load rejects (never an empty "clean" list), and is retried next time', async () => {
    const repo = fakeRepo(null);
    const src = new PostgresSanctionsListSource(() => repo, { now });
    await expect(src.load()).rejects.toBeInstanceOf(NoActiveSanctionsListError);
    repo.state.active = V1;
    await expect(src.load()).resolves.toBe(LIST);
  });

  it('a database error on a cold load rejects (the screener fails closed)', async () => {
    const repo = fakeRepo(V1);
    repo.activeVersion.mockRejectedValueOnce(new Error('connection refused'));
    const src = new PostgresSanctionsListSource(() => repo, { now });
    await expect(src.load()).rejects.toThrow();
  });

  it('warm() within the TTL does not query; after it, a new active version is picked up', async () => {
    const repo = fakeRepo(V1);
    const src = new PostgresSanctionsListSource(() => repo, { now, ttlMs: 60_000 });
    await src.warm();
    expect(await src.load()).toBe(LIST);
    repo.state.active = V2;
    clock += 30_000;
    await src.warm();
    expect(repo.activeVersion).toHaveBeenCalledTimes(1);
    expect(await src.load()).toBe(LIST);
    clock += 31_000;
    await src.warm();
    expect(await src.load()).toBe(LIST2);
  });

  it('warm() after the TTL with the SAME active version re-checks the pointer only (no entry reload)', async () => {
    const repo = fakeRepo(V1);
    const src = new PostgresSanctionsListSource(() => repo, { now, ttlMs: 1000 });
    await src.warm();
    clock += 5000;
    await src.warm();
    expect(repo.activeVersion).toHaveBeenCalledTimes(2);
    expect(repo.loadList).toHaveBeenCalledTimes(1);
  });

  it('a database error during a refresh keeps serving the last loaded version and never throws', async () => {
    const repo = fakeRepo(V1);
    const src = new PostgresSanctionsListSource(() => repo, { now, ttlMs: 1000 });
    await src.warm();
    clock += 5000;
    repo.activeVersion.mockRejectedValueOnce(new Error('timeout'));
    await expect(src.warm()).resolves.toBeUndefined();
    expect(await src.load()).toBe(LIST);
  });

  it('an active version that disappeared (deactivated by hand) drops the cache: screens fail closed', async () => {
    const repo = fakeRepo(V1);
    const src = new PostgresSanctionsListSource(() => repo, { now, ttlMs: 1000 });
    await src.warm();
    clock += 5000;
    repo.state.active = null;
    await src.warm();
    await expect(src.load()).rejects.toBeInstanceOf(NoActiveSanctionsListError);
  });

  it('after warm() found NO active version, load() fails closed WITHOUT a query (it runs inside the mint tx)', async () => {
    const repo = fakeRepo(null);
    const src = new PostgresSanctionsListSource(() => repo, { now });
    await src.warm();
    expect(repo.activeVersion).toHaveBeenCalledTimes(1);
    await expect(src.load()).rejects.toBeInstanceOf(NoActiveSanctionsListError);
    expect(repo.activeVersion).toHaveBeenCalledTimes(1);
    // warm() keeps re-checking while nothing is loaded (no TTL on a miss), so a
    // freshly loaded list is picked up by the very next mint.
    repo.state.active = V1;
    await src.warm();
    expect(await src.load()).toBe(LIST);
  });

  it('warm() never throws, even cold with nothing loaded', async () => {
    const src = new PostgresSanctionsListSource(() => fakeRepo(null), { now });
    await expect(src.warm()).resolves.toBeUndefined();
  });

  it('end to end on Postgres: nothing loaded ⇒ the screener rejects unavailable; after a store it blocks an exact match', async () => {
    const db = await freshDb();
    const src = new PostgresSanctionsListSource(() => createSanctionsListRepo(db), { now });
    const screener = new ListSanctionsScreener(src);
    await expect(screener.screen({ name: 'Testa Fixturelli', sourceCountry: 'US' })).rejects.toBeInstanceOf(
      SanctionsListUnavailableError,
    );
    await createSanctionsListRepo(db).storeList(LIST);
    await expect(screener.screen({ name: 'FIXTURELLI, Testa', sourceCountry: 'US' })).resolves.toMatchObject({
      matched: true,
      entryId: 'sdn:1003',
    });
    expect(screener.listInfo()).toMatchObject({ source: 'ofac-sdn', version: '2026-09-18' });
  });
});
