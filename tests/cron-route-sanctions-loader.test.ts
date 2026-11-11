import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// Program-Fix 14 PR C: /api/cron runs the OFAC SDN list loader ONLY when
// SANCTIONS_LOADER_ENABLED is set. OFF (the default, and production until the
// owner flips it): the loader is never called and the response is byte-for-byte
// what it was. ON: it runs after the other sweeps and FAILS SOFT — a throw
// never costs the cron its result.

const SECRET = 'cron-route-sanctions-secret';
process.env.CRON_SECRET = SECRET;

const runDueSchedules = vi.hoisted(() => vi.fn(async () => ({ fired: 2, failed: 1 })));
vi.mock('@/lib/cron-run', () => ({ runDueSchedules }));
vi.mock('@/lib/stale-money', () => ({ expireUnpaidLinks: vi.fn(async () => 4), expirePaymentLinks: vi.fn(async () => 0) }));
vi.mock('@/lib/outbox-retention', () => ({ scrubOldOutboxPayloads: vi.fn(async () => 7) }));
const record = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/db/repos/aux-repos', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db/repos/aux-repos')>()),
  createAuditRepo: () => ({ record }),
}));
const fakeDb = vi.hoisted(() => ({ fake: 'db' }));
vi.mock('@/db/client', () => ({ getDb: () => fakeDb }));
const runOfacSdnLoad = vi.hoisted(() =>
  vi.fn(async () => ({ status: 'activated', version: '2026-09-18', hash: 'h', entryCount: 5, nameCount: 9 })),
);
// Fix pack 5 T30: the generic loader and the two new feeds (mocked: no network).
const runListLoad = vi.hoisted(() =>
  vi.fn(async (_deps: unknown, def: { source: string }) => ({
    status: 'activated', version: `${def.source}-v`, hash: 'h', entryCount: 5, nameCount: 9,
  })),
);
vi.mock('@/lib/sanctions/list-loader', () => ({ runOfacSdnLoad, runListLoad }));
const fetchOfacConsolidated = vi.hoisted(() => vi.fn(async () => ({ source: 'ofac-cons' })));
vi.mock('@/lib/sanctions/ofac-cons-loader', () => ({ fetchOfacConsolidated, OFAC_CONS_MIN_ENTRIES: 100 }));
const fetchUnScList = vi.hoisted(() => vi.fn(async () => ({ source: 'un-sc' })));
vi.mock('@/lib/sanctions/un-sc-loader', () => ({ fetchUnScList, UN_SC_MIN_ENTRIES: 300 }));
// Fix pack 2 (R02): the list health check runs on every daily run.
const checkSanctionsListHealth = vi.hoisted(() => vi.fn(async () => ({ alerted: false })));
vi.mock('@/lib/sanctions/list-health', () => ({ checkSanctionsListHealth }));
// Fix pack 2 T7 (R07): the verified Blob archive runs after a load.
const archivePending = vi.hoisted(() => vi.fn(async () => ({ status: 'done', archived: 1, failed: 0, pruned: 0 })));
vi.mock('@/lib/sanctions/list-archive', () => ({ archivePending, ARCHIVE_BUDGET_MS: 150_000 }));
// Pack 2 review F3 (C3): the poke, observed (a hanging archive must not cost it).
const pokeWorker = vi.hoisted(() => vi.fn());
vi.mock('@/lib/outbox', async (orig) => ({ ...(await orig<typeof import('@/lib/outbox')>()), pokeWorker }));

import { GET } from '@/app/api/cron/route';

const req = () =>
  new NextRequest('https://smartremit.test/api/cron', { method: 'GET', headers: { authorization: `Bearer ${SECRET}` } });

describe('/api/cron — the OFAC SDN loader behind SANCTIONS_LOADER_ENABLED', () => {
  const original = process.env.SANCTIONS_LOADER_ENABLED;
  beforeEach(() => {
    runOfacSdnLoad.mockClear();
    checkSanctionsListHealth.mockClear();
    archivePending.mockClear();
    pokeWorker.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    if (original === undefined) delete process.env.SANCTIONS_LOADER_ENABLED;
    else process.env.SANCTIONS_LOADER_ENABLED = original;
  });

  it('OFF by default: the loader never runs and the response is unchanged', async () => {
    delete process.env.SANCTIONS_LOADER_ENABLED;
    const res = await GET(req());
    expect(await res.json()).toEqual({ ok: true, fired: 2, failed: 1, expired: 4, scrubbed: 7 });
    expect(runOfacSdnLoad).not.toHaveBeenCalled();
  });

  it.each(['', '0', 'false', 'no', 'yes'])('only "1" or "true" enables it (%j stays OFF)', async (v) => {
    process.env.SANCTIONS_LOADER_ENABLED = v;
    await GET(req());
    expect(runOfacSdnLoad).not.toHaveBeenCalled();
  });

  it('ON: runs the loader on the ledger handle and reports its status', async () => {
    process.env.SANCTIONS_LOADER_ENABLED = '1';
    const res = await GET(req());
    expect(runOfacSdnLoad).toHaveBeenCalledTimes(1);
    expect((runOfacSdnLoad.mock.calls[0] as unknown as [{ db: unknown }])[0].db).toBe(fakeDb);
    expect(await res.json()).toEqual({ ok: true, fired: 2, failed: 1, expired: 4, scrubbed: 7, sanctionsList: 'activated' });
  });

  it('ON: a loader throw fails soft (200, sanctionsList null, logged)', async () => {
    process.env.SANCTIONS_LOADER_ENABLED = 'true';
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    runOfacSdnLoad.mockRejectedValueOnce(new Error('boom'));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, fired: 2, sanctionsList: null });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('health check runs after the loader', async () => {
    process.env.SANCTIONS_LOADER_ENABLED = '1';
    await GET(req());
    expect(checkSanctionsListHealth).toHaveBeenCalledTimes(1);
    const [db, now] = checkSanctionsListHealth.mock.calls[0] as unknown as [unknown, Date];
    expect(db).toBe(fakeDb);
    expect(now).toBeInstanceOf(Date);
    expect(runOfacSdnLoad.mock.invocationCallOrder[0]).toBeLessThan(checkSanctionsListHealth.mock.invocationCallOrder[0]);
  });

  it('health check runs with the loader OFF', async () => {
    delete process.env.SANCTIONS_LOADER_ENABLED;
    await GET(req());
    expect(runOfacSdnLoad).not.toHaveBeenCalled();
    expect(checkSanctionsListHealth).toHaveBeenCalledTimes(1);
  });

  it('a health throw is logged; response unchanged', async () => {
    delete process.env.SANCTIONS_LOADER_ENABLED;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    checkSanctionsListHealth.mockRejectedValueOnce(new Error('boom'));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, fired: 2, failed: 1, expired: 4, scrubbed: 7 });
    expect(err.mock.calls.some((c) => String(c[0]).includes('cron.sanctions-list-health'))).toBe(true);
    err.mockRestore();
  });

  // Pack 2 review F3 (C3): loader, then the list health check, then the archive, then the poke.
  it('ON: archivePending runs after the load AND after the health check, with the same db and a budget', async () => {
    process.env.SANCTIONS_LOADER_ENABLED = '1';
    await GET(req());
    expect(archivePending).toHaveBeenCalledTimes(1);
    const [db, opts] = archivePending.mock.calls[0] as unknown as [unknown, { budgetMs: number }];
    expect(db).toBe(fakeDb);
    expect(opts.budgetMs).toBeGreaterThan(0);
    expect(opts.budgetMs).toBeLessThanOrEqual(150_000);
    expect(runOfacSdnLoad.mock.invocationCallOrder[0]).toBeLessThan(checkSanctionsListHealth.mock.invocationCallOrder[0]);
    expect(checkSanctionsListHealth.mock.invocationCallOrder[0]).toBeLessThan(archivePending.mock.invocationCallOrder[0]);
    expect(archivePending.mock.invocationCallOrder[0]).toBeLessThan(pokeWorker.mock.invocationCallOrder[0]);
  });

  it('ON: an archive that never resolves still lets the health check and the poke run, and the cron answers', async () => {
    process.env.SANCTIONS_LOADER_ENABLED = '1';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    archivePending.mockImplementationOnce(() => new Promise(() => {}));
    let settled = false;
    const pending = GET(req()).then((r) => {
      settled = true;
      return r;
    });
    for (let i = 0; i < 40 && !settled; i++) await vi.advanceTimersByTimeAsync(10_000);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, fired: 2, failed: 1, expired: 4, scrubbed: 7, sanctionsList: 'activated' });
    expect(checkSanctionsListHealth).toHaveBeenCalledTimes(1);
    expect(pokeWorker).toHaveBeenCalledTimes(1);
    expect(err.mock.calls.some((c) => String(c[0]).includes('cron.sanctions-archive'))).toBe(true);
    err.mockRestore();
  });

  it('OFF: never runs; response unchanged', async () => {
    delete process.env.SANCTIONS_LOADER_ENABLED;
    const res = await GET(req());
    expect(archivePending).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ ok: true, fired: 2, failed: 1, expired: 4, scrubbed: 7 });
  });

  it('an archive throw fails soft; response unchanged', async () => {
    process.env.SANCTIONS_LOADER_ENABLED = '1';
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    archivePending.mockRejectedValueOnce(new Error('boom'));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, fired: 2, failed: 1, expired: 4, scrubbed: 7, sanctionsList: 'activated' });
    expect(err.mock.calls.some((c) => String(c[0]).includes('cron.sanctions-archive'))).toBe(true);
    expect(checkSanctionsListHealth).toHaveBeenCalledTimes(1);
    expect(pokeWorker).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});

// Fix pack 5 T30 (R08, P27): under SANCTIONS_LIST=lists (and the loader ON)
// the cron also loads OFAC consolidated and UN SC (fetched in parallel, stored
// one after another) and archives every source inside the original budget.
// Outside lists every call and the response are as before.
describe('/api/cron - the list set under SANCTIONS_LIST=lists (fix pack 5 T30)', () => {
  const originalLoader = process.env.SANCTIONS_LOADER_ENABLED;
  const originalList = process.env.SANCTIONS_LIST;
  beforeEach(() => {
    runOfacSdnLoad.mockClear();
    runListLoad.mockClear();
    checkSanctionsListHealth.mockClear();
    archivePending.mockClear();
    pokeWorker.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    if (originalLoader === undefined) delete process.env.SANCTIONS_LOADER_ENABLED;
    else process.env.SANCTIONS_LOADER_ENABLED = originalLoader;
    if (originalList === undefined) delete process.env.SANCTIONS_LIST;
    else process.env.SANCTIONS_LIST = originalList;
  });

  it.each([undefined, 'ofac-sdn', 'mock'])('loader ON, SANCTIONS_LIST %s: only runOfacSdnLoad runs; runListLoad never; archivePending once with no source', async (v) => {
    process.env.SANCTIONS_LOADER_ENABLED = '1';
    if (v === undefined) delete process.env.SANCTIONS_LIST;
    else process.env.SANCTIONS_LIST = v;
    const res = await GET(req());
    expect(await res.json()).toEqual({ ok: true, fired: 2, failed: 1, expired: 4, scrubbed: 7, sanctionsList: 'activated' });
    expect(runOfacSdnLoad).toHaveBeenCalledTimes(1);
    expect(Object.keys((runOfacSdnLoad.mock.calls[0] as unknown as [object])[0])).toEqual(['db']);
    expect(runListLoad).not.toHaveBeenCalled();
    expect(archivePending).toHaveBeenCalledTimes(1);
    expect(Object.keys((archivePending.mock.calls[0] as unknown as [unknown, object])[1])).toEqual(['budgetMs']);
  });

  it('loader OFF, SANCTIONS_LIST=lists: no load at all, response unchanged', async () => {
    delete process.env.SANCTIONS_LOADER_ENABLED;
    process.env.SANCTIONS_LIST = 'lists';
    const res = await GET(req());
    expect(await res.json()).toEqual({ ok: true, fired: 2, failed: 1, expired: 4, scrubbed: 7 });
    expect(runOfacSdnLoad).not.toHaveBeenCalled();
    expect(runListLoad).not.toHaveBeenCalled();
    expect(archivePending).not.toHaveBeenCalled();
    expect(checkSanctionsListHealth).toHaveBeenCalledTimes(1);
  });

  it('loader ON + lists: the three loads are STARTED before any finishes; stores happen one after another', async () => {
    process.env.SANCTIONS_LOADER_ENABLED = '1';
    process.env.SANCTIONS_LIST = 'lists';
    type Serial = <T>(fn: () => Promise<T>) => Promise<T>;
    const events: string[] = [];
    const gates: Record<string, () => void> = {};
    const serials: Serial[] = [];
    const fake = (name: string) => async (deps: { db: unknown; serialStore?: Serial }) => {
      events.push(`start ${name}`);
      expect(deps.db).toBe(fakeDb);
      serials.push(deps.serialStore!);
      // The "fetch": waits for the test to release it.
      await new Promise<void>((r) => { gates[name] = r; });
      return deps.serialStore!(async () => {
        events.push(`store ${name} begin`);
        await new Promise((r) => setTimeout(r, 5));
        events.push(`store ${name} end`);
        return { status: 'activated' as const, version: `${name}-v`, hash: 'h', entryCount: 5, nameCount: 9 };
      });
    };
    runOfacSdnLoad.mockImplementationOnce(fake('ofac-sdn') as never);
    runListLoad.mockImplementation(((deps: { db: unknown; serialStore?: Serial }, def: { source: string }) => fake(def.source)(deps)) as never);
    const pending = GET(req());
    for (let i = 0; i < 50 && Object.keys(gates).length < 3; i++) await new Promise((r) => setTimeout(r, 1));
    // All three started, none finished.
    expect(events).toEqual(['start ofac-sdn', 'start ofac-cons', 'start un-sc']);
    // One mutex for all three.
    expect(new Set(serials).size).toBe(1);
    // Release every fetch at once: the stores must not overlap.
    for (const g of Object.values(gates)) g();
    const res = await pending;
    const stores = events.filter((e) => e.startsWith('store'));
    expect(stores).toHaveLength(6);
    for (let i = 0; i < 6; i += 2) {
      expect(stores[i]).toMatch(/ begin$/);
      expect(stores[i + 1]).toBe(stores[i].replace(' begin', ' end'));
    }
    const defs = runListLoad.mock.calls.map((c) => c[1] as unknown as { source: string; label: string; minEntries: number; parseErrorPrefix: string });
    expect(defs.map(({ source, label, minEntries, parseErrorPrefix }) => ({ source, label, minEntries, parseErrorPrefix }))).toEqual([
      { source: 'ofac-cons', label: 'OFAC consolidated (non-SDN)', minEntries: 100, parseErrorPrefix: 'OFAC CONS:' },
      { source: 'un-sc', label: 'UN Security Council', minEntries: 300, parseErrorPrefix: 'UN SC:' },
    ]);
    expect(await res.json()).toEqual({
      ok: true, fired: 2, failed: 1, expired: 4, scrubbed: 7, sanctionsList: 'activated',
      sanctionsLists: { 'ofac-sdn': 'activated', 'ofac-cons': 'activated', 'un-sc': 'activated' },
    });
    runListLoad.mockReset();
    runListLoad.mockImplementation(async (_d: unknown, def: { source: string }) => ({
      status: 'activated', version: `${def.source}-v`, hash: 'h', entryCount: 5, nameCount: 9,
    }));
  });

  it('the defs fetch through the new loaders (download and parse only)', async () => {
    process.env.SANCTIONS_LOADER_ENABLED = '1';
    process.env.SANCTIONS_LIST = 'lists';
    await GET(req());
    const defs = runListLoad.mock.calls.map((c) => c[1] as unknown as { fetch(): Promise<unknown> });
    fetchOfacConsolidated.mockClear();
    fetchUnScList.mockClear();
    expect(await defs[0].fetch()).toEqual({ source: 'ofac-cons' });
    expect(await defs[1].fetch()).toEqual({ source: 'un-sc' });
    expect(fetchOfacConsolidated).toHaveBeenCalledTimes(1);
    expect(fetchUnScList).toHaveBeenCalledTimes(1);
  });

  it('one feed rejecting or throwing does not stop the others; sanctionsLists null for a throw', async () => {
    process.env.SANCTIONS_LOADER_ENABLED = '1';
    process.env.SANCTIONS_LIST = 'lists';
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    runOfacSdnLoad.mockRejectedValueOnce(new Error('boom'));
    runListLoad.mockImplementationOnce(async () => ({ status: 'failed', reason: 'fetch' }) as never);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true, fired: 2, failed: 1, expired: 4, scrubbed: 7, sanctionsList: null,
      sanctionsLists: { 'ofac-sdn': null, 'ofac-cons': 'failed', 'un-sc': 'activated' },
    });
    expect(runListLoad).toHaveBeenCalledTimes(2);
    expect(err.mock.calls.some((c) => String(c[0]).includes('cron.sanctions-list'))).toBe(true);
    // A list-load throw too.
    err.mockClear();
    runListLoad.mockRejectedValueOnce(new Error('kaput'));
    const res2 = await GET(req());
    expect((await res2.json()).sanctionsLists).toEqual({ 'ofac-sdn': 'activated', 'ofac-cons': null, 'un-sc': 'activated' });
    expect(err.mock.calls.some((c) => String(c[0]).includes('cron.sanctions-list'))).toBe(true);
    err.mockRestore();
  });

  it('the health check runs after the loads and before the archives', async () => {
    process.env.SANCTIONS_LOADER_ENABLED = '1';
    process.env.SANCTIONS_LIST = 'lists';
    await GET(req());
    const health = checkSanctionsListHealth.mock.invocationCallOrder[0];
    expect(Math.max(runOfacSdnLoad.mock.invocationCallOrder[0], ...runListLoad.mock.invocationCallOrder)).toBeLessThan(health);
    expect(health).toBeLessThan(Math.min(...archivePending.mock.invocationCallOrder));
    expect(Math.max(...archivePending.mock.invocationCallOrder)).toBeLessThan(pokeWorker.mock.invocationCallOrder[0]);
  });

  it('archivePending runs once per source in SANCTIONS_SOURCES order with the REMAINING budget; a source is skipped once it is spent', async () => {
    process.env.SANCTIONS_LOADER_ENABLED = '1';
    process.env.SANCTIONS_LIST = 'lists';
    vi.useFakeTimers({ toFake: ['Date'] });
    // Each archive spends 60 s of the 150 s budget.
    archivePending.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 60_000);
      return { status: 'done', archived: 1, failed: 0, pruned: 0 };
    });
    let calls: Array<[unknown, { source: string; budgetMs: number }]>;
    try {
      await GET(req());
    } finally {
      calls = [...archivePending.mock.calls] as unknown as Array<[unknown, { source: string; budgetMs: number }]>;
      archivePending.mockReset();
      archivePending.mockImplementation(async () => ({ status: 'done', archived: 1, failed: 0, pruned: 0 }));
    }
    expect(calls.map((c) => c[1].source)).toEqual(['ofac-sdn', 'ofac-cons', 'un-sc']);
    const budgets = calls.map((c) => c[1].budgetMs);
    expect(budgets).toEqual([150_000, 90_000, 30_000]);
    for (const c of calls) expect(c[0]).toBe(fakeDb);
    expect(pokeWorker).toHaveBeenCalledTimes(1);
  });

  it('a hung archive of one source still lets the poke run and the cron answer, inside the budget plus one grace', async () => {
    process.env.SANCTIONS_LOADER_ENABLED = '1';
    process.env.SANCTIONS_LIST = 'lists';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    archivePending.mockImplementationOnce(() => new Promise(() => {}));
    const t0 = Date.now();
    let settled = false;
    let doneAt = 0;
    const pending = GET(req()).then((r) => {
      settled = true;
      doneAt = Date.now();
      return r;
    });
    for (let i = 0; i < 40 && !settled; i++) await vi.advanceTimersByTimeAsync(10_000);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(doneAt - t0).toBeLessThanOrEqual(150_000 + 10_000 + 10_000);
    // The hung one used the whole budget: the others were skipped.
    expect(archivePending).toHaveBeenCalledTimes(1);
    expect(pokeWorker).toHaveBeenCalledTimes(1);
    expect(err.mock.calls.some((c) => String(c[0]).includes('cron.sanctions-archive'))).toBe(true);
    err.mockRestore();
  });
});
