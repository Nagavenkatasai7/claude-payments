import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { createRewardRepo } from '@/db/repos/reward-repo';
import { saveCatalogEntry, savePartnerReward, saveTerms, REWARDS_AUDIT } from '@/lib/rewards/admin';
import { DEFAULT_CATALOG, DEFAULT_TERMS } from '@/lib/rewards/settings';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';

// B3 rewards v1: the three settings writers. Each writes the row and ONE
// audit row in the same transaction; the partner writer only ever touches
// the tenant it is given (the action passes the session's ctx.partnerId).

async function audits(db: Db) {
  const r = await db.execute(sql`SELECT partner_id, actor, action, subject_id, meta FROM audit_events WHERE action LIKE 'rewards.%' ORDER BY id`);
  return (r as unknown as { rows: Array<{ partner_id: string | null; actor: string; action: string; subject_id: string | null; meta: Record<string, unknown> }> }).rows;
}

describe('rewards settings writers', () => {
  it('saveCatalogEntry writes the catalog row and one audit row with the old and new values', async () => {
    const db = await freshDb();
    const next = { ...DEFAULT_CATALOG.nth_transfer, available: true, nthMin: 4 };
    await saveCatalogEntry(db, { username: 'root' }, next);
    expect((await createRewardRepo(db).getCatalog()).nth_transfer).toEqual(next);
    const [a] = await audits(db);
    expect(a).toMatchObject({ partner_id: null, actor: 'root', action: REWARDS_AUDIT.catalog, subject_id: 'nth_transfer' });
    expect(a.meta).toMatchObject({ old: { available: false, nthMin: 3 }, new: { available: true, nthMin: 4 } });
  });

  it('saveTerms writes one partner’s terms and audits under that partner', async () => {
    const db = await freshDb();
    await seedPartner(db, 'acme');
    await saveTerms(db, { username: 'root' }, 'acme', { platformFeeUsd: 0.5, giveBackPct: 40, monthlyBudgetUsd: 300 });
    expect(await createRewardRepo(db).getTerms('acme')).toEqual({ platformFeeUsd: 0.5, giveBackPct: 40, monthlyBudgetUsd: 300 });
    expect(await createRewardRepo(db).getTerms('default')).toEqual(DEFAULT_TERMS);
    const [a] = await audits(db);
    expect(a).toMatchObject({ partner_id: 'acme', action: REWARDS_AUDIT.terms, subject_id: 'acme' });
    expect(a.meta).toMatchObject({ old: DEFAULT_TERMS, new: { monthlyBudgetUsd: 300 } });
  });

  it('savePartnerReward changes only the given tenant (partner A never writes partner B)', async () => {
    const db = await freshDb();
    await seedPartner(db, 'acme');
    await seedPartner(db, 'beta');
    await savePartnerReward(db, { username: 'acme-admin', actorScope: 'partner' }, 'acme', { kind: 'nth_transfer', enabled: true, nth: 5 });
    const repo = createRewardRepo(db);
    expect((await repo.getPartnerSettings('acme')).nth_transfer).toMatchObject({ enabled: true, nth: 5 });
    expect(await repo.getPartnerSettings('beta')).toEqual({ nth_transfer: undefined, festival: undefined });
    const [a] = await audits(db);
    expect(a).toMatchObject({ partner_id: 'acme', actor: 'acme-admin', action: REWARDS_AUDIT.partner, subject_id: 'acme:nth_transfer' });
    expect(a.meta).toMatchObject({ actorScope: 'partner', old: null, new: { enabled: true, nth: 5 } });
  });
});
