import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { expirePaymentLinks } from '@/lib/stale-money';
import { createPayeeRepo } from '@/db/repos/payee-repo';
import { createPaymentLinkRepo } from '@/db/repos/payment-link-repo';
import { newLinkToken } from '@/lib/payment-links';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';

// Batch B2: the daily expiry job. Only OPEN links past expires_at move to
// 'expired', each with one paylink.expired audit row (ids only); used,
// cancelled and still-valid links are untouched; a second run changes nothing.

const DAY = 86_400_000;
let db: Db;

async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(q)) as unknown as { rows: T[] }).rows;
}

async function link(id: string, partnerId: string, payeeId: string, expiresAt: Date) {
  await createPaymentLinkRepo(db).insertLinks([{
    id, partnerId, payeeId, token: newLinkToken(), reference: `REF-${id}`, customerName: 'Asha Patel',
    customerPhone: '14155550100', amountInr: 1000, purpose: 'education', expiresAt, createdBy: 'pa',
  }]);
}

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'acme');
});

describe('expirePaymentLinks', () => {
  it('expires only open links past their expiry, with one audit row each; idempotent', async () => {
    const repo = createPayeeRepo(db);
    for (const [id, p] of [['pye_d', 'default'], ['pye_a', 'acme']] as const) {
      await repo.insert({
        id, partnerId: p, legalName: 'Sunrise Public School', accountHolder: 'Sunrise School Trust',
        payoutDestination: 'HDFC0001234 50100123456789', last4: '6789', screening: 'clear', createdBy: 'pa',
      });
    }
    const past = new Date(Date.now() - DAY);
    const future = new Date(Date.now() + DAY);
    await link('pl_old', 'default', 'pye_d', past);
    await link('pl_old_acme', 'acme', 'pye_a', past);
    await link('pl_young', 'default', 'pye_d', future);
    await link('pl_used', 'default', 'pye_d', future);
    await link('pl_cancelled', 'default', 'pye_d', past);
    const links = createPaymentLinkRepo(db);
    expect(await links.claimOpen('default', 'pl_used', 'tr_x', new Date())).toBe(true);
    // Force the used link past expiry afterwards: a used link never expires.
    await db.execute(sql`UPDATE payment_links SET expires_at = ${past.toISOString()}::timestamptz WHERE id = 'pl_used'`);
    expect(await links.cancel('default', 'pl_cancelled', 'pa')).toBe(true);

    expect(await expirePaymentLinks(db)).toBe(2);
    const status = await rows<{ id: string; status: string }>(sql`SELECT id, status FROM payment_links ORDER BY id`);
    expect(Object.fromEntries(status.map((r) => [r.id, r.status]))).toEqual({
      pl_cancelled: 'cancelled', pl_old: 'expired', pl_old_acme: 'expired', pl_used: 'used', pl_young: 'open',
    });
    const audits = await rows<{ partner_id: string; subject_id: string; actor_type: string }>(
      sql`SELECT partner_id, subject_id, actor_type FROM audit_events WHERE action = 'paylink.expired' ORDER BY subject_id`,
    );
    expect(audits).toEqual([
      { partner_id: 'default', subject_id: 'pl_old', actor_type: 'system' },
      { partner_id: 'acme', subject_id: 'pl_old_acme', actor_type: 'system' },
    ]);

    expect(await expirePaymentLinks(db)).toBe(0);
    expect(await rows(sql`SELECT 1 FROM audit_events WHERE action = 'paylink.expired'`)).toHaveLength(2);
  });
});
