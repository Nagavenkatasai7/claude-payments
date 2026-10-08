import { createRewardRepo } from '@/db/repos/reward-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import type { DbOrTx } from '@/db/client';
import type { PartnerId } from '../types';
import type { CatalogEntry, PartnerRewardSetting, PartnerRewardTerms } from './types';

// B3 rewards v1: the three settings writers. Each one runs in ONE transaction:
// it reads the old value, writes the new one and records ONE audit row with
// both. The callers (server actions) gate, validate with settings.ts and name
// the target: the admin pages any partner, the partner page ONLY the session's
// own tenant (ctx.partnerId), never a form field.

export const REWARDS_AUDIT = {
  catalog: 'rewards.catalog',
  terms: 'rewards.terms',
  partner: 'rewards.partner',
} as const;

export interface RewardsActor {
  username: string;
  /** The staff scope kind (partner pages), from the session, never from input. */
  actorScope?: string;
}

/** Platform admin: one catalog entry (what partners may offer and the limits). */
export async function saveCatalogEntry(db: DbOrTx, actor: RewardsActor, entry: CatalogEntry): Promise<void> {
  await db.transaction(async (tx) => {
    const repo = createRewardRepo(tx);
    const old = (await repo.getCatalog())[entry.kind];
    await repo.upsertCatalog(entry, actor.username);
    await createAuditRepo(tx).record({
      actor: actor.username,
      actorType: 'staff',
      action: REWARDS_AUDIT.catalog,
      subjectId: entry.kind,
      meta: { old, new: entry },
    });
  });
}

/** Platform admin: one partner's platform fee, give-back percentage and monthly budget. */
export async function saveTerms(db: DbOrTx, actor: RewardsActor, partnerId: PartnerId, terms: PartnerRewardTerms): Promise<void> {
  await db.transaction(async (tx) => {
    const repo = createRewardRepo(tx);
    const old = await repo.getTerms(partnerId);
    await repo.upsertTerms(partnerId, terms, actor.username);
    await createAuditRepo(tx).record({
      partnerId,
      actor: actor.username,
      actorType: 'staff',
      action: REWARDS_AUDIT.terms,
      subjectId: partnerId,
      meta: { old, new: terms },
    });
  });
}

/** A partner admin: one of the tenant's own rewards (already checked against the catalog). */
export async function savePartnerReward(db: DbOrTx, actor: RewardsActor, partnerId: PartnerId, setting: PartnerRewardSetting): Promise<void> {
  await db.transaction(async (tx) => {
    const repo = createRewardRepo(tx);
    const old = (await repo.getPartnerSettings(partnerId))[setting.kind] ?? null;
    await repo.upsertPartnerSetting(partnerId, setting, actor.username);
    await createAuditRepo(tx).record({
      partnerId,
      actor: actor.username,
      actorType: 'staff',
      action: REWARDS_AUDIT.partner,
      subjectId: `${partnerId}:${setting.kind}`,
      meta: { old, new: setting, ...(actor.actorScope ? { actorScope: actor.actorScope } : {}) },
    });
  });
}
