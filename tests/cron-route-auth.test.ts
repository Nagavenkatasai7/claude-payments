import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

// /api/cron's Bearer gate (Program-Fix 12 review follow-up): the same
// fail-closed, constant-time compare as /api/worker (src/lib/cron-auth.ts).

const SECRET = 'cron-route-test-secret';
process.env.CRON_SECRET = SECRET;

const runDueSchedules = vi.hoisted(() => vi.fn(async () => ({ fired: 0, failed: 0 })));
vi.mock('@/lib/cron-run', () => ({ runDueSchedules }));
// Program-Fix 32: the daily cron also expires unpaid links after the schedules.
const expireUnpaidLinks = vi.hoisted(() => vi.fn(async () => 2));
vi.mock('@/lib/stale-money', () => ({ expireUnpaidLinks }));
// Program-Fix 37: the daily payload-retention sweep runs after the expiry.
const scrubOldOutboxPayloads = vi.hoisted(() => vi.fn(async () => 3));
vi.mock('@/lib/outbox-retention', () => ({ scrubOldOutboxPayloads }));
vi.mock('@/db/client', () => ({ getDb: () => ({}) }));
// Program-Fix 27: every authorized run writes one cron.run audit row
// (tests/cron-route-audit.test.ts covers the row on a real ledger).
const auditRecord = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/db/repos/aux-repos', async (orig) => ({
  ...(await orig<typeof import('@/db/repos/aux-repos')>()),
  createAuditRepo: () => ({ record: auditRecord }),
}));

import { GET } from '@/app/api/cron/route';

function req(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://smartremit.test/api/cron', { method: 'GET', headers });
}

describe('/api/cron Bearer gate', () => {
  it('401 with no header, a wrong secret, a same-length near miss, a prefix and the bare secret — and never runs the schedules', async () => {
    for (const auth of [undefined, 'Bearer nope', `Bearer ${SECRET.slice(0, -1)}X`, `Bearer ${SECRET.slice(0, -1)}`, SECRET]) {
      const res = await GET(req(auth === undefined ? {} : { authorization: auth }));
      expect(res.status, String(auth)).toBe(401);
    }
    expect(runDueSchedules).not.toHaveBeenCalled();
    expect(expireUnpaidLinks).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled(); // an unauthenticated caller cannot grow audit_events
  });

  it('the right Bearer passes the gate and runs the schedules', async () => {
    const res = await GET(req({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, fired: 0, failed: 0, expired: 2, scrubbed: 3 });
    expect(runDueSchedules).toHaveBeenCalledTimes(1);
    expect(expireUnpaidLinks).toHaveBeenCalledTimes(1);
    expect(scrubOldOutboxPayloads).toHaveBeenCalledTimes(1);
    expect(auditRecord).toHaveBeenCalledTimes(1);
    expect(auditRecord).toHaveBeenCalledWith({
      actor: 'system',
      actorType: 'system',
      action: 'cron.run',
      meta: { fired: 0, failed: 0, expired: 2, scrubbed: 3 },
    });
  });

  it('Program-Fix 32: a failing expiry sweep never fails the cron — `expired` is null and the schedule result still returns', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expireUnpaidLinks.mockRejectedValueOnce(new Error('db down'));
    const res = await GET(req({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, fired: 0, failed: 0, expired: null, scrubbed: 3 });
  });

  it('Program-Fix 37: a failing payload scrub is fail-soft: the schedule result still returns, scrubbed is null', async () => {
    scrubOldOutboxPayloads.mockRejectedValueOnce(new Error('db down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET(req({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, fired: 0, failed: 0, expired: 2, scrubbed: null });
    err.mockRestore();
  });

  it('an unauthorized call never scrubs', async () => {
    scrubOldOutboxPayloads.mockClear();
    await GET(req({ authorization: 'Bearer nope' }));
    expect(scrubOldOutboxPayloads).not.toHaveBeenCalled();
  });
});
