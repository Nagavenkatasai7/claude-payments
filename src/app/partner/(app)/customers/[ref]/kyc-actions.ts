'use server';

import { revalidatePath } from 'next/cache';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { PARTNER_ADMIN, PARTNER_OPS } from '@/lib/partner-access';
import { getDb } from '@/db/client';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { getKycCaseStore } from '@/lib/kyc-case-store';
import { getPartnerStore } from '@/lib/partner-store';
import { openCustomerRef } from '@/lib/customer-ref';
import { notifyKycReviewDecision } from '@/lib/kyc-notify';
import { partnerKycFlag, partnerKycOffer } from '@/lib/partner-reviews';
import { isScreeningCustomerHold } from '@/lib/compliance-config';
import { scopeOf } from '@/lib/staff-scope';
import { requireStaffReason, STAFF_REASON_MIN } from '@/lib/send-limits';
import { isReasonValid } from '@/lib/ui/confirm-reason';
import { isPartnerNoteShaped } from '@/lib/partner-transfers';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import { getAuthStore } from '@/lib/auth-store';
import { staffMfaEnrolled } from '@/lib/staff-mfa-store';
import { isQualifiedComplianceUser, partnerDecidesKyc } from '@/lib/partner-decision-scope';
import { parseKycExtraMeta, type KycExtraMetaCode } from '@/lib/partner-kyc-decision';
import { KycScreeningChangedError } from '@/lib/sender-screening';
import { readSenderScreeningFlags } from '@/db/repos/customer-repo';
import { gatePartnerStepUp } from '@/lib/partner-step-up-gate';
import type { StepUpRequired } from '@/lib/staff-step-up-result';
import type { Partner, Staff } from '@/lib/types';
import type { PartnerCtx } from '@/lib/partner-access';
import type { ActionResult } from '../../../action-result';

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

const EXTRA_META_KEY: Readonly<Record<KycExtraMetaCode, 'partner.kyc.dispositionRequired' | 'partner.kyc.eddNoteInvalid'>> = Object.freeze({
  disposition: 'partner.kyc.dispositionRequired',
  edd_required: 'partner.kyc.dispositionRequired',
  note_long: 'partner.kyc.eddNoteInvalid',
  note_number: 'partner.kyc.eddNoteInvalid',
});

/** The locked-row screening re-check's refusal text (kyc-case-store review, allowScreeningHold false). */
const PERMISSION_TEXT = 'You do not have permission to perform this action.';

/**
 * Approve or reject one of THIS tenant's customers' KYC from /partner (merge plan 2c, owner D3;
 * fix pack 7 T26, P24). A compliance write, in order:
 *  1. the partner-site host guard, then the PARTNER_OPS gate (outside any try);
 *  2. the owner row: a read that throws or returns null is the generic notAllowed (never "not
 *     certified", which would reopen the other branch);
 *  3. an owner that does NOT decide KYC (partnerDecidesKyc false: every partner until pack 9) takes
 *     today's path unchanged (legacyDecide): the PARTNER_ADMIN gate, then the same steps, texts,
 *     refusal on any screening flag, review options and audit rows as before pack 7;
 *  4. a partner that decides KYC (certified for live money, signed posture kycDecider 'partner',
 *     kycMode 'delegated'): a FRESH staff read, a listed active admin/agent of this tenant
 *     (isQualifiedComplianceUser), else notCompliance; then two-step enrolled (fails closed), else
 *     mfaRequired (a user who is not listed never learns about the MFA rule);
 *  5. the sealed ref, re-scoped to the SESSION tenant (404 copy); the decision; the reason (today's
 *     three rules and texts);
 *  6. the screening flags as stored (readSenderScreeningFlags: the watchlist stamp included). A
 *     watchlist hit, an uncovered watchlist stamp or a stamp no boolean explains is SmartRemit's
 *     (partnerKycFlag 'platform' -> platformDecides, one fixed log tag, no customer data);
 *  7. the offer (partnerKycOffer with the qualified viewer: no-op decisions refused);
 *  8. the closed extra fields (parseKycExtraMeta: a PEP-only decision needs a disposition, an
 *     acceptance needs the EDD tick, a bounded number-free note);
 *  9. a PEP-only decision carries the flag time the page showed; missing or no longer the stored
 *     one -> changed;
 * 10. the forced step-up 'kyc.decide' (always asks), after every validation so a bad form never
 *     spends a code;
 * 11. kyc-case-store.review: one transaction locks the row, re-checks the PEP-only flag at the
 *     posted time (KycScreeningChangedError -> changed), clears the PEP hold on an approve
 *     (clearPepInTx, same transaction), writes the decision and its audit row (actorScope
 *     'partner', the disposition and EDD keys);
 * 12. a queue (Persona review) decision sends the gated, fail-soft notice (lib/kyc-notify.ts).
 * Known residuals: the owner read is read-then-write (as the hold release); two concurrent submits
 * of the same decision can both commit (each audited), as in the legacy action.
 */
export async function decideKycAction(formData: FormData): Promise<ActionResult | StepUpRequired> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_OPS);
  const notAllowed: ActionResult = { ok: false, error: t('partner.kyc.notAllowed') };

  let owner: Partner | null;
  try {
    owner = await getPartnerStore().getPartner(ctx.partnerId);
  } catch {
    owner = null;
  }
  if (!owner) return notAllowed;

  if (!partnerDecidesKyc(owner)) {
    const adminCtx = await requirePartnerStaff(PARTNER_ADMIN);
    return legacyDecide(adminCtx, owner, formData);
  }
  return partnerDecides(ctx, owner, formData);
}

/** The PEP-only flag time the page posted, as epoch ms; null when missing or unreadable. */
function postedFlagMs(raw: FormDataEntryValue | null): number | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const ms = Date.parse(raw.trim());
  return Number.isFinite(ms) ? ms : null;
}

async function partnerDecides(ctx: PartnerCtx, owner: Partner, formData: FormData): Promise<ActionResult | StepUpRequired> {
  const fail = (key: Parameters<typeof t>[0]): ActionResult => ({ ok: false, error: t(key) });
  const notFound = fail('partner.customers.notFound');
  const notAllowed = fail('partner.kyc.notAllowed');

  // 4. A fresh staff read (a session may outlive a role change), then MFA (fails closed).
  let staff: Staff | null;
  try {
    staff = await getAuthStore().getStaff(ctx.username);
  } catch {
    return fail('partner.kyc.notCompliance');
  }
  const fact = staff
    ? { username: staff.username, partnerId: staff.partnerId ?? null, role: staff.role, active: staff.status !== 'suspended' }
    : null;
  if (!fact || fact.username !== ctx.username || !isQualifiedComplianceUser(owner, fact, true)) return fail('partner.kyc.notCompliance');
  const mfa = await staffMfaEnrolled(ctx.username);
  if (!isQualifiedComplianceUser(owner, fact, mfa)) return fail('partner.kyc.mfaRequired');

  // 5. The ref (session tenant), the decision, the reason: today's rules and texts.
  const ref = formData.get('ref');
  if (typeof ref !== 'string' || ref === '') return notFound;
  const opened = openCustomerRef(ref);
  if (!opened || opened.partnerId !== ctx.partnerId) return notFound;
  const customer = await getCustomerStore(getStore()).getCustomer(ctx.partnerId, opened.phone);
  if (!customer || customer.partnerId !== ctx.partnerId) return notFound;

  const decision = formData.get('decision');
  if (decision !== 'approve' && decision !== 'reject') return fail('partner.kyc.invalidDecision');
  const rawReason = formData.get('reason');
  let reason: string;
  try {
    if (!isReasonValid(rawReason, STAFF_REASON_MIN)) throw new Error('short');
    reason = requireStaffReason(rawReason);
  } catch {
    return fail('partner.kyc.reasonTooShort');
  }
  if (!isPartnerNoteShaped(reason)) return fail('partner.kyc.reasonHasNumber');

  // 6. The flags as stored (a Customer row does not carry the watchlist stamp: T9 note).
  let flags;
  try {
    flags = await readSenderScreeningFlags(getDb(), ctx.partnerId, customer.senderPhone);
  } catch (err) {
    logWarn('partner.kyc.decide', errName(err), { partnerId: ctx.partnerId });
    return fail('partner.common.failed');
  }
  const screened = { ...customer, ...(flags ?? {}) };
  const flag = partnerKycFlag(screened);
  if (flag === 'platform') {
    logWarn('partner.kyc.decide', 'platform', { partnerId: ctx.partnerId });
    return fail('partner.kyc.platformDecides');
  }

  // 7. The offer for a qualified viewer (no-op decisions refused).
  const rule = partnerKycOffer(owner, screened, decision, { qualified: true });
  if (!rule.ok) return notAllowed;

  // 8. The closed extra fields.
  const parsed = parseKycExtraMeta(formData, decision, flag === 'pep');
  if (!parsed.ok) return fail(EXTRA_META_KEY[parsed.code]);

  // 9. A PEP-only decision is about the flag the page showed.
  const reviewedFlaggedAt = formData.get('screeningFlaggedAt');
  if (flag === 'pep') {
    const posted = postedFlagMs(reviewedFlaggedAt);
    const stored = flags?.screeningFlaggedAt ? flags.screeningFlaggedAt.getTime() : null;
    if (posted === null || stored === null || posted !== stored) return fail('partner.kyc.changed');
  }

  // 10. The forced step-up, after every validation.
  const stepUp = await gatePartnerStepUp(ctx, formData, 'kyc.decide', { always: true });
  if (stepUp) return stepUp;

  // 11. The ONE durable writer.
  const reviewer = ctx.staff.name && ctx.staff.name !== ctx.username ? `${ctx.staff.name} (${ctx.username})` : ctx.username;
  let updated;
  try {
    updated = await getKycCaseStore(getStore()).review(ctx.partnerId, customer.senderPhone, decision, reviewer, reason, {
      db: getDb(),
      store: getStore(),
      actor: ctx.username,
      slug: rule.slug,
      source: rule.source,
      allowScreeningHold: flag === 'pep',
      pepClearable: true,
      actorScope: 'partner',
      extraMeta: parsed.meta,
      ...(flag === 'pep' && typeof reviewedFlaggedAt === 'string' ? { pepClear: { reviewedFlaggedAt } } : {}),
    });
  } catch (err) {
    if (err instanceof KycScreeningChangedError) return fail('partner.kyc.changed');
    if (err instanceof Error && err.message === PERMISSION_TEXT) {
      logWarn('partner.kyc.decide', 'referred', { partnerId: ctx.partnerId });
      return fail('partner.kyc.referred');
    }
    logWarn('partner.kyc.decide', errName(err), { partnerId: ctx.partnerId });
    return fail('partner.common.failed');
  }
  if (!updated) return notFound; // raced a delete: nothing written

  if (rule.source === 'persona_review') await notifyKycReviewDecision(customer, customer.senderPhone, decision);
  revalidatePath('/partner/customers');
  revalidatePath('/partner/customers/[ref]', 'page');
  revalidatePath('/partner/reviews');
  return { ok: true };
}

/** Today's path (pre pack 7), for every owner that does not decide KYC; the owner was read once above. */
async function legacyDecide(ctx: PartnerCtx, owner: Partner, formData: FormData): Promise<ActionResult> {
  const notFound: ActionResult = { ok: false, error: t('partner.customers.notFound') };
  const notAllowed: ActionResult = { ok: false, error: t('partner.kyc.notAllowed') };
  // A screening hit: one fixed result and one fixed log tag (no customer data), nothing written.
  const referred = (): ActionResult => {
    logWarn('partner.kyc.decide', 'referred', { partnerId: ctx.partnerId });
    return { ok: false, error: t('partner.kyc.referred') };
  };

  const ref = formData.get('ref');
  if (typeof ref !== 'string' || ref === '') return notFound;
  const opened = openCustomerRef(ref);
  if (!opened || opened.partnerId !== ctx.partnerId) return notFound;
  const customer = await getCustomerStore(getStore()).getCustomer(ctx.partnerId, opened.phone);
  if (!customer || customer.partnerId !== ctx.partnerId) return notFound;

  const decision = formData.get('decision');
  if (decision !== 'approve' && decision !== 'reject') return { ok: false, error: t('partner.kyc.invalidDecision') };

  const rawReason = formData.get('reason');
  let reason: string;
  try {
    if (!isReasonValid(rawReason, STAFF_REASON_MIN)) throw new Error('short');
    reason = requireStaffReason(rawReason);
  } catch {
    return { ok: false, error: t('partner.kyc.reasonTooShort') };
  }
  if (!isPartnerNoteShaped(reason)) return { ok: false, error: t('partner.kyc.reasonHasNumber') };

  const rule = partnerKycOffer(owner, customer, decision);
  if (!rule.ok) return notAllowed;
  if (isScreeningCustomerHold(customer)) return referred();

  const reviewer = ctx.staff.name && ctx.staff.name !== ctx.username ? `${ctx.staff.name} (${ctx.username})` : ctx.username;
  let updated;
  try {
    updated = await getKycCaseStore(getStore()).review(ctx.partnerId, customer.senderPhone, decision, reviewer, reason, {
      db: getDb(),
      store: getStore(),
      actor: ctx.username,
      slug: rule.slug,
      source: rule.source,
      allowScreeningHold: false,
      actorScope: scopeOf(ctx.staff).kind,
    });
  } catch (err) {
    // The locked-row screening re-check refused: nothing was written.
    if (err instanceof Error && err.message === PERMISSION_TEXT) return referred();
    logWarn('partner.kyc.decide', errName(err), { partnerId: ctx.partnerId });
    return { ok: false, error: t('partner.common.failed') };
  }
  if (!updated) return notFound; // raced a delete: nothing written

  if (rule.source === 'persona_review') await notifyKycReviewDecision(customer, customer.senderPhone, decision);
  revalidatePath('/partner/customers');
  revalidatePath('/partner/customers/[ref]', 'page');
  revalidatePath('/partner/reviews');
  return { ok: true };
}
