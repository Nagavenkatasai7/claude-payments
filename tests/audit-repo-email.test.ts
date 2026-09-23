import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { createAuditRepo, getInviteEmailStatus } from '@/db/repos/aux-repos';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import type { Db } from '@/db/client';

// Program-Fix 39: the audit reads behind the ops "Email" card and the partner
// request's "Invite email" line.

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});

async function insertAudit(action: string, daysAgo: number, subjectId: string | null = null, meta: object | null = null) {
  // audit_events is append-only: build the "outside the window" fixture with an
  // explicit `at` on INSERT, never by backdating.
  await db.execute(sql`
    INSERT INTO audit_events (actor, actor_type, action, subject_id, meta, at)
    VALUES ('outbox', 'system', ${action}, ${subjectId}, ${meta ? JSON.stringify(meta) : null}::jsonb,
            now() - make_interval(days => ${daysAgo}))`);
}

describe('auditRepo.countByAction', () => {
  it('countByAction counts only that action inside the window', async () => {
    await insertAudit('email.skipped', 0);
    await insertAudit('email.skipped', 6);
    await insertAudit('email.skipped', 8); // outside a 7-day window
    await insertAudit('email.sent_other', 0); // another action
    await insertAudit('email.skippedX', 0); // a prefix look-alike
    const repo = createAuditRepo(db);
    expect(await repo.countByAction('email.skipped', 7)).toBe(2);
    expect(await repo.countByAction('email.skipped', 30)).toBe(3);
    expect(await repo.countByAction('nope', 7)).toBe(0);
  });
});

describe('getInviteEmailStatus', () => {
  async function markStatus(key: string, status: string) {
    await db.execute(sql`UPDATE outbox SET status = ${status} WHERE dedupe_key = ${key}`);
  }
  async function idOf(key: string): Promise<number> {
    const r = (await db.execute(sql`SELECT id FROM outbox WHERE dedupe_key = ${key}`)) as unknown as { rows: Array<{ id: number | string }> };
    return Number(r.rows[0].id);
  }

  it('no invite row → unknown', async () => {
    expect(await getInviteEmailStatus(db, 'preq_abc')).toBe('unknown');
  });

  it('done with no skip → sent; a skip audit naming that row → skipped', async () => {
    await createOutboxRepo(db).enqueue('email.send', { to: ['a@b.test'], subject: 's', text: 't' }, { dedupeKey: 'partner_app_invite:preq_abc' });
    expect(await getInviteEmailStatus(db, 'preq_abc')).toBe('queued');
    await markStatus('partner_app_invite:preq_abc', 'done');
    expect(await getInviteEmailStatus(db, 'preq_abc')).toBe('sent');
    const id = await idOf('partner_app_invite:preq_abc');
    await insertAudit('email.skipped', 0, 'preq_abc', { reason: 'unconfigured', dedupePrefix: 'partner_app_invite', outboxId: id });
    expect(await getInviteEmailStatus(db, 'preq_abc')).toBe('skipped');
  });

  it('the NEWEST invite row wins (a resend supersedes the original)', async () => {
    const outbox = createOutboxRepo(db);
    await outbox.enqueue('email.send', { to: ['a@b.test'], subject: 's', text: 't' }, { dedupeKey: 'partner_app_invite:preq_abc' });
    await markStatus('partner_app_invite:preq_abc', 'done');
    const first = await idOf('partner_app_invite:preq_abc');
    await insertAudit('email.skipped', 0, 'preq_abc', { reason: 'unconfigured', dedupePrefix: 'partner_app_invite', outboxId: first });
    await outbox.enqueue('email.send', { to: ['a@b.test'], subject: 's', text: 't' }, { dedupeKey: 'partner_app_invite:preq_abc:r0123456789ab' });
    await markStatus('partner_app_invite:preq_abc:r0123456789ab', 'done');
    expect(await getInviteEmailStatus(db, 'preq_abc')).toBe('sent');
  });

  it('another request whose id merely starts the same (or uses LIKE wildcards) never matches', async () => {
    const outbox = createOutboxRepo(db);
    await outbox.enqueue('email.send', { to: ['a@b.test'], subject: 's', text: 't' }, { dedupeKey: 'partner_app_invite:preq_abcX' });
    await outbox.enqueue('email.send', { to: ['a@b.test'], subject: 's', text: 't' }, { dedupeKey: 'partner_app_invite:preq_abc_' });
    expect(await getInviteEmailStatus(db, 'preq_abc')).toBe('unknown');
    expect(await getInviteEmailStatus(db, 'preq_ab_')).toBe('unknown');
  });
});
