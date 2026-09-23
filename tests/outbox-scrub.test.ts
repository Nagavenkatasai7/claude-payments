import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { OUTBOX_PAYLOAD_RETENTION_DAYS, scrubOldOutboxPayloads } from '@/lib/outbox-retention';

// Program-Fix 37 (ctx-03): a `done` outbox row's payload is a plaintext shadow
// copy of what was sent (message bodies, phones, template names). After
// OUTBOX_PAYLOAD_RETENTION_DAYS it is emptied to {} — the ROW stays (id, kind,
// status, attempts, dedupe_key, timestamps), so dedupe idempotency and every
// escalation ladder keyed on dedupe_key are untouched. Rows are never deleted,
// and any status other than 'done' is never touched (ops Retry needs a dead
// row's payload).

type Db = Awaited<ReturnType<typeof freshDb>>;
let db: Db;

async function insert(
  status: string,
  ageDays: number,
  dedupeKey: string,
  payload: Record<string, unknown> = { to: '15551230000', body: 'hello Asha' },
): Promise<number> {
  const res = await db.execute(sql`
    INSERT INTO outbox (kind, payload, status, dedupe_key, created_at, next_attempt_at)
    VALUES ('whatsapp.text', ${JSON.stringify(payload)}::jsonb, ${status}, ${dedupeKey},
            now() - make_interval(days => ${ageDays}), now())
    RETURNING id`);
  return Number((res as unknown as { rows: Array<{ id: unknown }> }).rows[0].id);
}

async function row(id: number) {
  const res = await db.execute(sql`SELECT kind, status, attempts, dedupe_key, payload FROM outbox WHERE id = ${id}`);
  return (res as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
}

async function count(): Promise<number> {
  const res = await db.execute(sql`SELECT count(*)::int AS n FROM outbox`);
  return Number((res as unknown as { rows: Array<{ n: unknown }> }).rows[0].n);
}

beforeEach(async () => {
  db = await freshDb();
});

describe('outboxRepo.scrubDonePayloads', () => {
  it('empties a done row older than the window, keeping kind, status, attempts and dedupe_key', async () => {
    const id = await insert('done', 8, 'wamid:old');
    const n = await createOutboxRepo(db).scrubDonePayloads(7);
    expect(n).toBe(1);
    const r = await row(id);
    expect(r.payload).toEqual({});
    expect(r.kind).toBe('whatsapp.text');
    expect(r.status).toBe('done');
    expect(r.dedupe_key).toBe('wamid:old');
  });

  it('never touches a done row inside the window, or a pending/failed/processing/dead row of any age', async () => {
    const ids = [
      await insert('done', 6, 'k-done-6'),
      await insert('pending', 30, 'k-pending'),
      await insert('failed', 30, 'k-failed'),
      await insert('processing', 30, 'k-processing'),
      await insert('dead', 30, 'k-dead'),
    ];
    expect(await createOutboxRepo(db).scrubDonePayloads(7)).toBe(0);
    for (const id of ids) {
      expect((await row(id)).payload).toEqual({ to: '15551230000', body: 'hello Asha' });
    }
  });

  it('returns the count, a second call returns 0, and no row is ever deleted', async () => {
    await insert('done', 9, 'a');
    await insert('done', 10, 'b');
    const repo = createOutboxRepo(db);
    expect(await repo.scrubDonePayloads(7)).toBe(2);
    expect(await repo.scrubDonePayloads(7)).toBe(0);
    expect(await count()).toBe(2);
  });

  it('honours the limit', async () => {
    for (let i = 0; i < 5; i++) await insert('done', 8, `lim-${i}`);
    const repo = createOutboxRepo(db);
    expect(await repo.scrubDonePayloads(7, 2)).toBe(2);
    expect(await repo.scrubDonePayloads(7, 2)).toBe(2);
    expect(await repo.scrubDonePayloads(7, 2)).toBe(1);
    expect(await repo.scrubDonePayloads(7, 2)).toBe(0);
  });

  it('dedupe survives the scrub: re-enqueueing the scrubbed row\'s key is still a no-op', async () => {
    await insert('done', 8, 'wamid:redelivered');
    const repo = createOutboxRepo(db);
    expect(await repo.scrubDonePayloads(7)).toBe(1);
    expect(await repo.enqueue('agent.turn', { phone: '15551230000', messageText: 'hi' }, { dedupeKey: 'wamid:redelivered' })).toBe(false);
    expect(await count()).toBe(1);
  });
});

describe('scrubOldOutboxPayloads (the cron loop)', () => {
  it('is a 7-day retention', () => {
    expect(OUTBOX_PAYLOAD_RETENTION_DAYS).toBe(7);
  });

  it('loops in batches until a short batch, and returns the total', async () => {
    for (let i = 0; i < 5; i++) await insert('done', 8, `loop-${i}`);
    await insert('done', 1, 'fresh');
    const total = await scrubOldOutboxPayloads(db, { batch: 2 });
    expect(total).toBe(5);
    expect(await scrubOldOutboxPayloads(db, { batch: 2 })).toBe(0);
  });

  it('stops when its time budget is spent (never loops past the deadline)', async () => {
    for (let i = 0; i < 5; i++) await insert('done', 8, `budget-${i}`);
    let t = 0;
    // Each clock read advances 25 s: the first batch runs, then the 20 s budget is spent.
    const total = await scrubOldOutboxPayloads(db, { batch: 2, budgetMs: 20_000, now: () => (t += 25_000) });
    expect(total).toBe(2);
  });
});
