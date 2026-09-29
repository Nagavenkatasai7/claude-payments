'use server';

import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { scopeOf } from '@/lib/staff-scope';
import { getDb, type DbOrTx } from '@/db/client';
import { auditEvents, partners } from '@/db/schema';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { requestGoLive } from '@/db/repos/partner-go-live-repo';
import { loadOnboardingFacts } from '@/db/repos/partner-onboarding-facts';
import { ATTESTED_TEMPLATES, mayRequestGoLive } from '@/lib/partner-onboarding';
import { pokeWorker } from '@/lib/outbox';
import { t, type MessageKey } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import { PARTNER_ROUTES } from '../../routes';
import type { ActionResult } from '../../action-result';

// /partner/onboarding actions (UI redesign M3-20, SPEC §3.1). Each one: the site-host guard, then
// the admin gate (+ MFA enrolment), both outside any try. The tenant is ALWAYS ctx.partnerId: no
// form field names a partner, and neither action takes a target id. Both serialise per tenant on
// the partners row (SELECT … FOR UPDATE: drizzle pg-core/query-builders/select.d.ts:586, the same
// lock as api-keys/actions.ts lockTenant), so a double submit writes once.
//
// attestTemplatesAction: step 2. There is no template-status tracking in the codebase (plan O9):
// the partner admin ATTESTS that both the `authentication` and `transfer_delivered` templates are
// approved; SmartRemit verifies at go-live approval (M3-21). Audit partner.templates.attest.
//
// requestGoLiveAction: step 7. The checklist is RE-COMPUTED here from stored facts inside the
// transaction (never trusted from the page). Steps 1–6 must be done. Then, in ONE transaction:
// requestGoLive (idempotent; keeps the first request), audit partner.go_live.request, and an
// ops.alert outbox row deduped per tenant per UTC day. An already requested or approved partner
// gets { ok: true } with nothing written. A partner can NEVER approve: approval is the platform's
// (approveGoLive, M3-21); nothing here un-approves either (PR 427 review LOW: add a lock if that ever changes).

const PAGE = PARTNER_ROUTES.onboarding.href;

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

class Refusal extends Error {
  constructor(readonly key: MessageKey) {
    super('refused');
    this.name = 'Refusal';
  }
}
const refused = (key: MessageKey): ActionResult => ({ ok: false, error: t(key) });

async function lockTenant(tx: DbOrTx, partnerId: string): Promise<void> {
  await tx.select({ id: partners.id }).from(partners).where(eq(partners.id, partnerId)).for('update');
}

export async function attestTemplatesAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.onboarding.policy);
  // Both boxes must be ticked (a checkbox posts 'on'); anything else is refused before any write.
  if (!ATTESTED_TEMPLATES.every((name) => formData.get(name) === 'on')) return refused('partner.onboarding.attest.invalid');
  try {
    await getDb().transaction(async (tx) => {
      await lockTenant(tx, ctx.partnerId);
      const prior = await tx
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(and(eq(auditEvents.partnerId, ctx.partnerId), eq(auditEvents.subjectId, ctx.partnerId), eq(auditEvents.action, 'partner.templates.attest')))
        .limit(1);
      if (prior.length > 0) return; // already attested: an idempotent no-op, no second row
      await createAuditRepo(tx).record({
        partnerId: ctx.partnerId,
        actor: ctx.username,
        actorType: 'staff',
        action: 'partner.templates.attest',
        subjectId: ctx.partnerId,
        meta: { templates: [...ATTESTED_TEMPLATES], actorScope: scopeOf(ctx.staff).kind },
      });
    });
  } catch (err) {
    logWarn('partner.onboarding.attest', errName(err), { partnerId: ctx.partnerId });
    return refused('partner.onboarding.failed');
  }
  revalidatePath(PAGE);
  return { ok: true };
}

export async function requestGoLiveAction(_formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.onboarding.policy);
  const now = new Date();
  let requested: boolean;
  try {
    requested = await getDb().transaction(async (tx) => {
      await lockTenant(tx, ctx.partnerId);
      const facts = await loadOnboardingFacts(tx, ctx.partnerId, { now });
      if (facts.goLiveRequested || facts.goLiveApproved) return false; // idempotent: keep the first request
      if (!mayRequestGoLive(facts)) throw new Refusal('partner.onboarding.incomplete');
      await requestGoLive(tx, ctx.partnerId, ctx.username, now);
      await createAuditRepo(tx).record({
        partnerId: ctx.partnerId,
        actor: ctx.username,
        actorType: 'staff',
        action: 'partner.go_live.request',
        subjectId: ctx.partnerId,
        meta: { actorScope: scopeOf(ctx.staff).kind },
      });
      await createOutboxRepo(tx).enqueue(
        'ops.alert',
        { message: `Partner ${ctx.partnerId} requested go-live` },
        { dedupeKey: `golive:${ctx.partnerId}:${now.toISOString().slice(0, 10)}` },
      );
      return true;
    });
  } catch (err) {
    if (err instanceof Refusal) return refused(err.key);
    logWarn('partner.onboarding.request', errName(err), { partnerId: ctx.partnerId });
    return refused('partner.onboarding.failed');
  }
  if (requested) pokeWorker(); // post-response (after()); the per-minute cron drains it regardless
  revalidatePath(PAGE);
  return { ok: true };
}
