import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';

// Program-Fix 27 (vercel-09): every authorized /api/cron run leaves ONE
// append-only audit row ('cron.run', actorType 'system') carrying the run's
// counts only: no phone, name, schedule id or transfer id. It is an INSERT on
// the real PGlite ledger, so it also proves the row passes migration 0019's
// append-only trigger.

const SECRET = 'cron-route-audit-secret';
process.env.CRON_SECRET = SECRET;

const runDueSchedules = vi.hoisted(() => vi.fn(async () => ({ fired: 2, failed: 1 })));
vi.mock('@/lib/cron-run', () => ({ runDueSchedules }));
const expireUnpaidLinks = vi.hoisted(() => vi.fn(async () => 4));
vi.mock('@/lib/stale-money', () => ({ expireUnpaidLinks }));
const scrubOldOutboxPayloads = vi.hoisted(() => vi.fn(async () => 7));
vi.mock('@/lib/outbox-retention', () => ({ scrubOldOutboxPayloads }));
const dbRef = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@/db/client', () => ({ getDb: () => dbRef.current }));

import { GET } from '@/app/api/cron/route';

function req(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://smartremit.test/api/cron', { method: 'GET', headers });
}

type Row = { partner_id: string | null; actor: string; actor_type: string; action: string; subject_id: string | null; meta: unknown };

async function cronRows(): Promise<Row[]> {
  const db = dbRef.current as Awaited<ReturnType<typeof freshDb>>;
  const r = await db.execute(
    sql`SELECT partner_id, actor, actor_type, action, subject_id, meta FROM audit_events WHERE action = 'cron.run' ORDER BY id`,
  );
  return (r as unknown as { rows: Row[] }).rows;
}

beforeEach(async () => {
  dbRef.current = await freshDb();
});

describe('/api/cron audit row (Program-Fix 27, vercel-09)', () => {
  it('each /api/cron run writes one cron.run audit row with its counts', async () => {
    const first = await GET(req({ authorization: `Bearer ${SECRET}` }));
    expect(first.status).toBe(200);
    expect(await cronRows()).toEqual([
      {
        partner_id: null,
        actor: 'system',
        actor_type: 'system',
        action: 'cron.run',
        subject_id: null,
        meta: { fired: 2, failed: 1, expired: 4, scrubbed: 7 },
      },
    ]);

    // The 17:00 UTC catch-up run is a second run: a second row, never an update.
    runDueSchedules.mockResolvedValueOnce({ fired: 0, failed: 0 });
    await GET(req({ authorization: `Bearer ${SECRET}` }));
    const rows = await cronRows();
    expect(rows).toHaveLength(2);
    expect(rows[1].meta).toEqual({ fired: 0, failed: 0, expired: 4, scrubbed: 7 });
  });

  it('a failed sweep is recorded as null, not dropped', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expireUnpaidLinks.mockRejectedValueOnce(new Error('db down'));
    await GET(req({ authorization: `Bearer ${SECRET}` }));
    expect((await cronRows())[0].meta).toEqual({ fired: 2, failed: 1, expired: null, scrubbed: 7 });
    err.mockRestore();
  });

  it('an unauthorized call writes no audit row', async () => {
    const res = await GET(req({ authorization: 'Bearer nope' }));
    expect(res.status).toBe(401);
    expect(await cronRows()).toEqual([]);
  });

  it('a failing audit insert never fails the cron (fail-soft, logged)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const real = dbRef.current as { insert: unknown };
    dbRef.current = new Proxy(real as object, {
      get(target, prop, recv) {
        if (prop === 'insert') return () => { throw new Error('insert refused'); };
        return Reflect.get(target, prop, recv);
      },
    });
    const res = await GET(req({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, fired: 2, failed: 1, expired: 4, scrubbed: 7 });
    expect(err).toHaveBeenCalled();
    dbRef.current = real;
    err.mockRestore();
  });
});
