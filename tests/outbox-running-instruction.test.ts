import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { createOutboxRepo, ROW_DEADLINE_ERROR_PREFIX } from '@/db/repos/outbox-repo';
import { RowDeadlineError } from '@/lib/outbox-worker';
import type { Db } from '@/db/client';

// Truth check F10 (F1, decision B): hasRunningInstruction counts a
// settlement.instruct row that RUNS ('processing') and one ABANDONED at its row
// deadline that is still parked (failed / dead with the deadline error and a
// next_attempt_at in the future): its handler may still record and POST.

let db: Db;
const T = 'ri_t1';

let seq = 0;
async function instruct(transferId: string, set: { status: string; lastError?: string | null; nextAtSec?: number }): Promise<void> {
  const key = `instruct:${transferId}:${++seq}`;
  await createOutboxRepo(db).enqueue('settlement.instruct', { transferId }, { dedupeKey: key });
  await db.execute(sql`
    UPDATE outbox SET status = ${set.status}, last_error = ${set.lastError ?? null},
      next_attempt_at = now() + make_interval(secs => ${set.nextAtSec ?? 0})
    WHERE dedupe_key = ${key}`);
}

beforeEach(async () => {
  db = await freshDb();
});

describe('outboxRepo.hasRunningInstruction (truth check F10)', () => {
  const deadline = new RowDeadlineError(40_000).message;

  it('the deadline error text starts with the shared prefix', () => {
    expect(ROW_DEADLINE_ERROR_PREFIX).toBe('outbox row deadline exceeded');
    expect(deadline).toBe('outbox row deadline exceeded (40000ms)');
    expect(deadline.startsWith(ROW_DEADLINE_ERROR_PREFIX)).toBe(true);
  });

  it("'processing' -> true", async () => {
    await instruct(T, { status: 'processing' });
    expect(await createOutboxRepo(db).hasRunningInstruction(T)).toBe(true);
  });

  it("'failed' with the deadline error and next_attempt_at in the future -> true", async () => {
    await instruct(T, { status: 'failed', lastError: deadline, nextAtSec: 300 });
    expect(await createOutboxRepo(db).hasRunningInstruction(T)).toBe(true);
  });

  it("'failed' with the deadline error and next_attempt_at in the past -> false", async () => {
    await instruct(T, { status: 'failed', lastError: deadline, nextAtSec: -5 });
    expect(await createOutboxRepo(db).hasRunningInstruction(T)).toBe(false);
  });

  it("'failed' with another error -> false", async () => {
    await instruct(T, { status: 'failed', lastError: 'Settlement instruction rejected (500)', nextAtSec: 300 });
    expect(await createOutboxRepo(db).hasRunningInstruction(T)).toBe(false);
  });

  it("'dead' with the deadline error and a future next_attempt_at -> true", async () => {
    await instruct(T, { status: 'dead', lastError: deadline, nextAtSec: 300 });
    expect(await createOutboxRepo(db).hasRunningInstruction(T)).toBe(true);
  });

  it("'pending' / 'done' -> false; another transfer's row -> false", async () => {
    await instruct(T, { status: 'pending', nextAtSec: 300 });
    await instruct(T, { status: 'done', lastError: deadline, nextAtSec: 300 });
    await instruct('ri_other', { status: 'processing' });
    await instruct('ri_other', { status: 'failed', lastError: deadline, nextAtSec: 300 });
    expect(await createOutboxRepo(db).hasRunningInstruction(T)).toBe(false);
  });
});
