import { describe, it, expect, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { auditEvents, partners } from '@/db/schema';
import { createAuditRepo } from '@/db/repos/aux-repos';
import type { Db } from '@/db/client';

// Program-Fix 28 PR B (compliance-12): audit_events is append-only IN THE
// DATABASE (drizzle/0019). A BEFORE UPDATE OR DELETE row trigger rejects every
// mutation of an existing row, whoever issues it; INSERT is untouched. There is
// deliberately NO TRUNCATE trigger: freshDb() truncates audit_events between
// tests. These run on PGlite migrated from the real ./drizzle chain.

const APPEND_ONLY = /audit_events is append-only/;

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});

/** The error text of a rejected statement, including drizzle's wrapped cause. */
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const cause = (e as { cause?: unknown }).cause;
    return `${String((e as Error).message)} ${cause instanceof Error ? cause.message : String(cause ?? '')}`;
  }
  throw new Error('expected the statement to be rejected, but it succeeded');
}

async function rows() {
  return db.select().from(auditEvents).orderBy(auditEvents.id);
}

async function seedRow(action = 'pii.reveal') {
  await createAuditRepo(db).record({ partnerId: 'default', actor: 'root', actorType: 'staff', action, subjectId: 's1', meta: { k: 1 } });
}

describe('audit_events append-only trigger (Program-Fix 28, migration 0019)', () => {
  it('INSERT still works (repo record and raw SQL with an explicit at)', async () => {
    await seedRow();
    await db.execute(sql`INSERT INTO audit_events (actor, actor_type, action, at) VALUES ('sys', 'system', 'x.y', now() - interval '1 day')`);
    expect((await rows()).map((r) => r.action)).toEqual(['pii.reveal', 'x.y']);
  });

  it('a raw UPDATE is rejected and the row is unchanged', async () => {
    await seedRow();
    const before = await rows();
    expect(await rejection(db.execute(sql`UPDATE audit_events SET actor = 'someone-else'`))).toMatch(APPEND_ONLY);
    expect(await rejection(db.execute(sql`UPDATE audit_events SET at = at - interval '1 minute'`))).toMatch(APPEND_ONLY);
    expect(await rows()).toEqual(before);
  });

  it('a raw DELETE is rejected and the row survives', async () => {
    await seedRow();
    expect(await rejection(db.execute(sql`DELETE FROM audit_events`))).toMatch(APPEND_ONLY);
    expect(await rows()).toHaveLength(1);
  });

  it('drizzle update(auditEvents) / delete(auditEvents) are rejected', async () => {
    await seedRow();
    const before = await rows();
    expect(await rejection(db.update(auditEvents).set({ meta: { k: 2 } }).where(eq(auditEvents.action, 'pii.reveal')))).toMatch(APPEND_ONLY);
    expect(await rejection(db.delete(auditEvents).where(eq(auditEvents.action, 'pii.reveal')))).toMatch(APPEND_ONLY);
    expect(await rows()).toEqual(before);
  });

  it('a rejected mutation inside a transaction rolls back the paired write', async () => {
    await seedRow();
    const err = await rejection(
      db.transaction(async (tx) => {
        await tx.update(partners).set({ name: 'Renamed' }).where(eq(partners.id, 'default'));
        await tx.execute(sql`DELETE FROM audit_events`);
      }),
    );
    expect(err).toMatch(APPEND_ONLY);
    const [p] = await db.select({ name: partners.name }).from(partners).where(eq(partners.id, 'default'));
    expect(p.name).toBe('SmartRemit Default');
    expect(await rows()).toHaveLength(1);
  });

  it('TRUNCATE (the test reset) still works: freshDb() empties the table', async () => {
    await seedRow();
    db = await freshDb();
    expect(await rows()).toHaveLength(0);
  });

  it('the (partner_id, subject_id) index exists', async () => {
    const r = (await db.execute(
      sql`SELECT indexdef FROM pg_indexes WHERE tablename = 'audit_events' AND indexname = 'audit_partner_subject'`,
    )) as unknown as { rows: Array<{ indexdef: string }> };
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].indexdef).toMatch(/\(partner_id, subject_id\)/);
  });
});
