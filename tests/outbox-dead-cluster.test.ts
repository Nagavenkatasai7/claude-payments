import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { errorPrefix } from '@/lib/ops-diagnosis-ai';
import { freshDb } from './helpers-db';
import type { Db } from '@/db/client';

// U5 — the DETERMINISTIC half of the ops-diagnosis copilot: getDead resolves a
// single dead row, and countDeadByErrorPrefix clusters siblings by last_error
// prefix in SQL (the model never counts). Real Postgres via PGlite.

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});

/** Insert an outbox row and force it to 'dead' with a given last_error. */
async function seedDead(kind: string, lastError: string): Promise<number> {
  const r = await db.execute(sql`
    INSERT INTO outbox (kind, payload, status, attempts, last_error, next_attempt_at)
    VALUES (${kind}, ${JSON.stringify({})}::jsonb, 'dead', 8, ${lastError}, now())
    RETURNING id
  `);
  return Number((r as unknown as { rows: Array<{ id: number }> }).rows[0].id);
}

describe('outbox getDead / countDeadByErrorPrefix — deterministic clustering', () => {
  it('getDead returns only dead rows', async () => {
    const repo = createOutboxRepo(db);
    const deadId = await seedDead('settlement.instruct', 'boom');
    // a non-dead (pending) row must not resolve via getDead
    const pending = await db.execute(sql`
      INSERT INTO outbox (kind, payload, status) VALUES ('ops.alert', '{}'::jsonb, 'pending') RETURNING id
    `);
    const pendingId = Number((pending as unknown as { rows: Array<{ id: number }> }).rows[0].id);

    expect((await repo.getDead(deadId))?.id).toBe(deadId);
    expect(await repo.getDead(pendingId)).toBeNull();
    expect(await repo.getDead(999999)).toBeNull();
  });

  it('counts sibling dead rows sharing the normalized error prefix, excluding the subject', async () => {
    const repo = createOutboxRepo(db);
    // Three rows that failed the same way — a shared leading chunk, then a
    // varying trailing host. errorPrefix keeps the shared chunk; the trailing
    // host differs and is dropped, so they cluster (case-insensitively).
    const shared = 'Ollama request failed (502): upstream rail unreachable — ';
    const subject = await seedDead('settlement.instruct', `${shared}partner-a.example`);
    await seedDead('settlement.instruct', `${shared}partner-b.example`);
    await seedDead('rail.callback', `${shared.toUpperCase()}partner-c.example`);
    // and one unrelated failure that must NOT cluster.
    await seedDead('whatsapp.text', 'Meta template rejected: PARAGRAPH format');

    // Prefix scoped to the shared portion only (the varying host is past it).
    // Derived from `shared` alone so it ends exactly at the shared boundary.
    const prefix = errorPrefix(shared, 200);
    // 2 siblings (the subject itself is excluded), the unrelated row is not counted.
    expect(await repo.countDeadByErrorPrefix(prefix, subject)).toBe(2);
  });

  it('an empty prefix counts nothing (defensive — no last_error)', async () => {
    const repo = createOutboxRepo(db);
    const subject = await seedDead('ops.alert', '');
    await seedDead('ops.alert', 'something else');
    expect(await repo.countDeadByErrorPrefix(errorPrefix(''), subject)).toBe(0);
  });

  it('LIKE metacharacters in the prefix are escaped (no wildcard injection)', async () => {
    const repo = createOutboxRepo(db);
    const subject = await seedDead('ops.alert', '100% disk full at /var');
    await seedDead('ops.alert', '100% disk full at /tmp');
    await seedDead('ops.alert', '100X disk full elsewhere'); // would match if % were a wildcard
    const prefix = errorPrefix('100% disk full');
    expect(await repo.countDeadByErrorPrefix(prefix, subject)).toBe(1);
  });
});
