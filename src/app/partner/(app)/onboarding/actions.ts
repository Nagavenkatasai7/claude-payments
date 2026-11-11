'use server';

import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import { scopeOf } from '@/lib/staff-scope';
import { getDb, type DbOrTx } from '@/db/client';
import { auditEvents, partners } from '@/db/schema';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { requestGoLive } from '@/db/repos/partner-go-live-repo';
import { loadOnboardingFacts } from '@/db/repos/partner-onboarding-facts';
import { ATTESTED_TEMPLATES, mayRequestGoLive } from '@/lib/partner-onboarding';
import { pokeWorker } from '@/lib/outbox';
import { staffMfaEnrolled } from '@/lib/staff-mfa-store';
import { gatePartnerStepUp } from '@/lib/partner-step-up-gate';
import type { StepUpRequired } from '@/lib/staff-step-up-result';
import { writePosture, type LiveWriteResult } from '@/lib/live-controls-write';
import type { KycDecider, PostureRecord } from '@/lib/live-controls';
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
//
// signPostureAction (fix pack 3 T9, R27, contract 12): the partner admin signs the compliance
// posture (a card after the steps list, NOT an eighth step). Order: site host, admin gate, the
// actor's own staff MFA (before the step-up: factorFor would fall back to the password), the parse,
// the 'posture.sign' step-up, then ONE transaction: writePosture (key write under the partner row
// lock + audit + ops alert + partner email). A signed posture forces verify-before-send.

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

const KYC_DECIDERS: readonly KycDecider[] = ['partner', 'smartremit_procedures'];
const HOLD_DECIDERS: readonly PostureRecord['holdDecider'][] = ['partner', 'smartremit_delegated'];
const POSTURE_REFUSAL: Record<Exclude<LiveWriteResult, { ok: true }>['code'], MessageKey> = {
  kyc_decider_mismatch: 'partner.live.posture.mismatch',
  bad_input: 'partner.live.posture.invalid',
  not_found: 'partner.onboarding.failed',
  not_ready: 'partner.onboarding.failed',
  not_certified: 'partner.onboarding.failed',
  psp_unavailable: 'partner.onboarding.failed', // fix pack 5 T17: writeFundingMode only (platform), never from here
};

export async function signPostureAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult | StepUpRequired> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.onboarding.policy);
  // Pack 3 review Q1 (H1): SmartRemit's own default tenant never signs a posture (it would force
  // verify-before-send on all default traffic); refused before the MFA check and the step-up.
  if (ctx.partnerId === DEFAULT_PARTNER_ID) return refused('partner.onboarding.failed');
  if (!(await staffMfaEnrolled(ctx.username))) return refused('partner.live.posture.needMfa');
  const kyc = formData.get('kycDecider');
  const hold = formData.get('holdDecider');
  const kycDecider = KYC_DECIDERS.find((d) => d === kyc);
  const holdDecider = HOLD_DECIDERS.find((d) => d === hold);
  if (!kycDecider || !holdDecider) return refused('partner.live.posture.invalid');
  const fourEyesNonSanctions = formData.get('fourEyesNonSanctions') === 'on';
  const stepUp = await gatePartnerStepUp(ctx, formData, 'posture.sign');
  if (stepUp) return stepUp;
  let r: LiveWriteResult;
  try {
    r = await getDb().transaction((tx) =>
      writePosture(tx, ctx.partnerId, { username: ctx.username, scope: 'partner' }, { kycDecider, holdDecider, fourEyesNonSanctions }),
    );
  } catch (err) {
    logWarn('partner.onboarding.posture', errName(err), { partnerId: ctx.partnerId });
    return refused('partner.onboarding.failed');
  }
  if (!r.ok) return refused(POSTURE_REFUSAL[r.code]);
  pokeWorker(); // post-response (after()): the ops alert and the partner email
  revalidatePath(PAGE);
  return { ok: true };
}
