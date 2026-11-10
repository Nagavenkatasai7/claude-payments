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
vi.mock('@/lib/sanctions/list-loader', () => ({ runOfacSdnLoad }));
// Fix pack 2 (R02): the list health check runs on every daily run.
const checkSanctionsListHealth = vi.hoisted(() => vi.fn(async () => ({ alerted: false })));
vi.mock('@/lib/sanctions/list-health', () => ({ checkSanctionsListHealth }));
// Fix pack 2 T7 (R07): the verified Blob archive runs after a load.
const archivePending = vi.hoisted(() => vi.fn(async () => ({ status: 'done', archived: 1, failed: 0, pruned: 0 })));
vi.mock('@/lib/sanctions/list-archive', () => ({ archivePending }));

import { GET } from '@/app/api/cron/route';

const req = () =>
  new NextRequest('https://smartremit.test/api/cron', { method: 'GET', headers: { authorization: `Bearer ${SECRET}` } });

describe('/api/cron — the OFAC SDN loader behind SANCTIONS_LOADER_ENABLED', () => {
  const original = process.env.SANCTIONS_LOADER_ENABLED;
  beforeEach(() => {
    runOfacSdnLoad.mockClear();
    checkSanctionsListHealth.mockClear();
    archivePending.mockClear();
  });
  afterEach(() => {
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

  it('ON: archivePending runs after the load with the same db', async () => {
    process.env.SANCTIONS_LOADER_ENABLED = '1';
    await GET(req());
    expect(archivePending).toHaveBeenCalledTimes(1);
    expect((archivePending.mock.calls[0] as unknown as [unknown])[0]).toBe(fakeDb);
    expect(runOfacSdnLoad.mock.invocationCallOrder[0]).toBeLessThan(archivePending.mock.invocationCallOrder[0]);
    expect(archivePending.mock.invocationCallOrder[0]).toBeLessThan(checkSanctionsListHealth.mock.invocationCallOrder[0]);
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
    err.mockRestore();
  });
});
