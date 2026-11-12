import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import { cleanSmokePartners, SMOKE_PARTNER_NAME } from '../scripts/clean-smoke-partner';
import { createStaffRepo } from '@/db/repos/staff-repo';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';
import { createConversationLogRepo } from '@/db/repos/conversation-log-repo';
import { RAIL_OUT, createRailMessageRepo } from '@/db/repos/rail-message-repo';
import { createHoldReviewRepo } from '@/db/repos/hold-review-repo';
import { seedPartnerTransfer } from './helpers-partner-app';
import { partnerGoLive, partnerPortalSettings, partnerReportJobs, partnerSites, partnerSlugTombstones, partnerWebhookDeliveries } from '@/db/schema';

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

  it('removes the partner-app children added by 0026-0028 (after /migrate-prod every partner has a go-live row)', async () => {
    await seedPartner(db, 'p_smoke', SMOKE_PARTNER_NAME);
    await db.insert(partnerGoLive).values({ partnerId: 'p_smoke' }).onConflictDoNothing();
    await db.insert(partnerSites).values({ partnerId: 'p_smoke' }).onConflictDoNothing();
    await db.insert(partnerPortalSettings).values({ partnerId: 'p_smoke' }).onConflictDoNothing();
    await db.insert(partnerSlugTombstones).values({ slug: 'smoke-old', partnerId: 'p_smoke', releasedBy: 'test' });
    await db.insert(partnerReportJobs).values({ id: '00000000-0000-4000-8000-000000000001', partnerId: 'p_smoke', kind: 'settlements', params: {}, requestedBy: 'test' });
    await db.insert(partnerWebhookDeliveries).values({ partnerId: 'p_smoke', kind: 'ping', attempt: 1, outcome: 'ok' });
    await cleanSmokePartners(db, () => {});
    expect(await count(`SELECT count(*)::int AS n FROM partners WHERE id = 'p_smoke'`)).toBe(0);
    for (const t of ['partner_go_live', 'partner_sites', 'partner_portal_settings', 'partner_slug_tombstones', 'partner_report_jobs', 'partner_webhook_deliveries']) {
      expect(await count(`SELECT count(*)::int AS n FROM ${t} WHERE partner_id = 'p_smoke'`), t).toBe(0);
    }
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

  it('SKIPS a smoke partner that OWNS rail_messages rows, and keeps them', async () => {
    await seedPartner(db, 'p_smoke', SMOKE_PARTNER_NAME);
    await createRailMessageRepo(db).append({
      partnerId: 'p_smoke', railPartnerId: 'p_smoke', transferId: 't_smoke', direction: RAIL_OUT, kind: 'settle', body: '{}', signatureHeader: null,
    });
    const lines: string[] = [];
    await cleanSmokePartners(db, (l) => lines.push(l));
    expect(await count(`SELECT count(*)::int AS n FROM partners WHERE id = 'p_smoke'`)).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM rail_messages WHERE partner_id = 'p_smoke'`)).toBe(1);
    expect(lines.join('\n')).toMatch(/skip p_smoke .*1 rail messages/);
  });

  it('SKIPS a smoke partner that is only the RAIL partner of a row (routed, zero transfers)', async () => {
    await seedPartner(db, 'pa');
    await seedPartner(db, 'p_smoke', SMOKE_PARTNER_NAME);
    await createRailMessageRepo(db).append({
      partnerId: 'pa', railPartnerId: 'p_smoke', transferId: 't_routed', direction: RAIL_OUT, kind: 'settle', body: '{}', signatureHeader: null,
    });
    const lines: string[] = [];
    await cleanSmokePartners(db, (l) => lines.push(l));
    expect(await count(`SELECT count(*)::int AS n FROM partners WHERE id = 'p_smoke'`)).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM rail_messages WHERE rail_partner_id = 'p_smoke'`)).toBe(1);
    expect(lines.join('\n')).toMatch(/skip p_smoke .*1 rail messages/);
  });

  it('SKIPS a smoke partner that has hold_reviews rows, and keeps them', async () => {
    // Fix pack 7 T4 (P1, D3): the append-only hold decision record is never deleted.
    await seedPartner(db, 'pa');
    await seedPartner(db, 'p_smoke', SMOKE_PARTNER_NAME);
    await seedPartnerTransfer(db, { id: 'tq', partnerId: 'pa' });
    await createHoldReviewRepo(db).insert({
      transferId: 'tq', partnerId: 'p_smoke', holdClass: 'kyc', reasonsFp: 'v1|kyc|x', step: 1, final: true,
      disposition: 'documents_verified', reason: 'Documents checked and fine', evidence: {}, actor: 'co-a', actorScope: 'partner',
    });
    const lines: string[] = [];
    await cleanSmokePartners(db, (l) => lines.push(l));
    expect(await count(`SELECT count(*)::int AS n FROM partners WHERE id = 'p_smoke'`)).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM hold_reviews WHERE partner_id = 'p_smoke'`)).toBe(1);
    expect(lines.join('\n')).toMatch(/skip p_smoke .*1 hold reviews/);
  });

  it('never touches a partner with a different name', async () => {
    await seedPartner(db, 'p_real', 'Real Partner');
    await createStaffRepo(db).upsert(smokeStaff('p_real'));
    await cleanSmokePartners(db, () => {});
    expect(await count(`SELECT count(*)::int AS n FROM staff WHERE partner_id = 'p_real'`)).toBe(1);
  });
});
