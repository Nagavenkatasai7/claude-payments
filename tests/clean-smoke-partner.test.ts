import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import { cleanSmokePartners, SMOKE_PARTNER_NAME } from '../scripts/clean-smoke-partner';
import { createStaffRepo } from '@/db/repos/staff-repo';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';
import { createConversationLogRepo } from '@/db/repos/conversation-log-repo';

// Program-Fix 45 P5: the staff ledger's partner_id FK means the smoke
// partner's staff row (copied in on read) must go before the partner, and the
// whole clean-up is ONE transaction (a refusal part-way commits nothing).

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});

const smokeStaff = (partnerId: string): Staff => ({
  username: 'smoke-staff',
  name: 'Smoke Staff',
  role: 'admin',
  permissions: { canCancel: false, canResend: false, canAssign: false },
  passwordHash: 'h',
  createdAt: '2026-09-01T00:00:00.000Z',
  partnerId,
});

async function count(q: string): Promise<number> {
  const res = (await db.execute(sql.raw(q))) as unknown as { rows: Array<{ n: number }> };
  return Number(res.rows[0].n);
}

describe('clean-smoke-partner', () => {
  it('removes the smoke partner together with its staff ledger row', async () => {
    await seedPartner(db, 'p_smoke', SMOKE_PARTNER_NAME);
    await createStaffRepo(db).upsert(smokeStaff('p_smoke'));
    await cleanSmokePartners(db, () => {});
    expect(await count(`SELECT count(*)::int AS n FROM partners WHERE id = 'p_smoke'`)).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM staff WHERE partner_id = 'p_smoke'`)).toBe(0);
  });

  it('is one transaction: a refusal part-way leaves every row in place', async () => {
    await seedPartner(db, 'p_smoke', SMOKE_PARTNER_NAME);
    await createStaffRepo(db).upsert(smokeStaff('p_smoke'));
    // A child table the script does not clear (tickets) makes the partner DELETE fail.
    await db.execute(
      sql.raw(
        `INSERT INTO tickets (id, partner_id, subject) VALUES ('t_smoke', 'p_smoke', 's')`,
      ),
    );
    await expect(cleanSmokePartners(db, () => {})).rejects.toThrow();
    expect(await count(`SELECT count(*)::int AS n FROM partners WHERE id = 'p_smoke'`)).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM staff WHERE partner_id = 'p_smoke'`)).toBe(1);
  });

  it('SKIPS a smoke partner that has conversation log rows (a permanent audit log is never deleted)', async () => {
    await seedPartner(db, 'p_smoke', SMOKE_PARTNER_NAME);
    await createConversationLogRepo(db).append({ partnerId: 'p_smoke', phone: '15551230000', channel: 'wa', direction: 'in', text: 'hi' });
    const lines: string[] = [];
    await cleanSmokePartners(db, (l) => lines.push(l));
    expect(await count(`SELECT count(*)::int AS n FROM partners WHERE id = 'p_smoke'`)).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM conversation_messages WHERE partner_id = 'p_smoke'`)).toBe(1);
    expect(lines.join('\n')).toMatch(/skip p_smoke .*1 conversation messages/);
  });

  it('never touches a partner with a different name', async () => {
    await seedPartner(db, 'p_real', 'Real Partner');
    await createStaffRepo(db).upsert(smokeStaff('p_real'));
    await cleanSmokePartners(db, () => {});
    expect(await count(`SELECT count(*)::int AS n FROM staff WHERE partner_id = 'p_real'`)).toBe(1);
  });
});
