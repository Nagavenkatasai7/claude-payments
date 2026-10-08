'use server';

import { revalidatePath } from 'next/cache';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { getDb } from '@/db/client';
import { getPartnerStore } from '@/lib/partner-store';
import { createRewardRepo } from '@/db/repos/reward-repo';
import { scopeOf } from '@/lib/staff-scope';
import { savePartnerReward } from '@/lib/rewards/admin';
import { parsePartnerRewardForm } from '@/lib/rewards/settings';
import { isFundedRewardKind } from '@/lib/rewards/types';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import type { ActionResult } from '../../action-result';
import { PARTNER_ROUTES } from '../../routes';

// /partner/rewards server action (B3 rewards v1). The shared /partner action shape:
//  - refuseOnSiteHost() first, then the admin gate, both outside any try;
//  - the target is ALWAYS the session's tenant (ctx.partnerId): no form field names a partner, and
//    any id / partnerId / partner field is never read;
//  - the values are checked against the admin catalog's CURRENT limits (settings.ts); the engine
//    checks them again at every quote and mint, so a later tightened limit applies at once;
//  - the money terms (platform fee, give-back, budget) are platform-admin only and never read here;
//  - ONE audit row in the same transaction (rewards/admin.ts), meta.actorScope from the session;
//  - errors are fixed copy: never an exception message, never the input echoed back.

const POLICY = PARTNER_ROUTES.rewards.policy;
const PAGE = PARTNER_ROUTES.rewards.href;

export async function savePartnerRewardAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(POLICY);
  const kind = formData.get('kind');
  if (!isFundedRewardKind(kind)) return { ok: false, error: t('partner.rewards.unknown') };
  try {
    if ((await getPartnerStore().getPartner(ctx.partnerId)) === null) return { ok: false, error: t('partner.rewards.failed') };
    const db = getDb();
    const catalog = await createRewardRepo(db).getCatalog();
    const parsed = parsePartnerRewardForm(kind, formData, catalog[kind]);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    await savePartnerReward(db, { username: ctx.username, actorScope: scopeOf(ctx.staff).kind }, ctx.partnerId, parsed.value);
  } catch (err) {
    logWarn('partner.rewards.save', err instanceof Error ? err.name : 'error', { partnerId: ctx.partnerId });
    return { ok: false, error: t('partner.rewards.failed') };
  }
  revalidatePath(PAGE);
  return { ok: true };
}
