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
  });

  it('the right Bearer passes the gate and runs the schedules', async () => {
    const res = await GET(req({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, fired: 0, failed: 0, expired: 2 });
    expect(runDueSchedules).toHaveBeenCalledTimes(1);
    expect(expireUnpaidLinks).toHaveBeenCalledTimes(1);
  });

  it('Program-Fix 32: a failing expiry sweep never fails the cron — `expired` is null and the schedule result still returns', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expireUnpaidLinks.mockRejectedValueOnce(new Error('db down'));
    const res = await GET(req({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, fired: 0, failed: 0, expired: null });
  });
});
