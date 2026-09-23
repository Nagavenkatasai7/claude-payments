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
vi.mock('@/lib/stale-money', () => ({ expireUnpaidLinks: vi.fn(async () => 4) }));
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

import { GET } from '@/app/api/cron/route';

const req = () =>
  new NextRequest('https://smartremit.test/api/cron', { method: 'GET', headers: { authorization: `Bearer ${SECRET}` } });

describe('/api/cron — the OFAC SDN loader behind SANCTIONS_LOADER_ENABLED', () => {
  const original = process.env.SANCTIONS_LOADER_ENABLED;
  beforeEach(() => {
    runOfacSdnLoad.mockClear();
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
});
