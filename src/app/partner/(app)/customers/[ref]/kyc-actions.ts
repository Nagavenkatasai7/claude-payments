'use server';

import { revalidatePath } from 'next/cache';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { PARTNER_ADMIN } from '@/lib/partner-access';
import { getDb } from '@/db/client';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { getKycCaseStore } from '@/lib/kyc-case-store';
import { getPartnerStore } from '@/lib/partner-store';
import { openCustomerRef } from '@/lib/customer-ref';
import { notifyKycReviewDecision } from '@/lib/kyc-notify';
import { partnerKycDecision } from '@/lib/partner-reviews';
import { scopeOf } from '@/lib/staff-scope';
import { requireStaffReason, STAFF_REASON_MIN } from '@/lib/send-limits';
import { isReasonValid } from '@/lib/ui/confirm-reason';
import { isPartnerNoteShaped } from '@/lib/partner-transfers';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import type { ActionResult } from '../../../action-result';

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

/**
 * Approve or reject one of THIS tenant's customers' KYC from /partner (merge plan 2c, owner D3).
 * A compliance write, in order:
 *  1. the partner-site host guard, then the PARTNER_ADMIN gate (outside any try);
 *  2. the sealed ref is opened and re-scoped to the SESSION tenant (any posted partner field is
 *     never read); a missing, foreign or junk ref is the same not-found result;
 *  3. the decision is approve | reject; the typed reason is at least STAFF_REASON_MIN characters
 *     with no phone/account-length number (it lands in append-only audit meta);
 *  4. D3 (partnerKycDecision): the owner's KYC mode is 'delegated' AND the customer has no PEP /
 *     watchlist hit; a no-op manual decision is refused. One generic refusal for every case, so
 *     an 'ours'-mode partner and a screening hit read the same (nothing is tipped off);
 *  5. the ONE durable writer, kyc-case-store.review: one transaction locks the row, RE-CHECKS the
 *     screening flags on the locked row (allowScreeningHold:false), writes the decision and its
 *     audit row (actor = username, meta.actorScope from the session). A flag raised after step 4
 *     still refuses, with nothing written;
 *  6. a queue (Persona review) decision sends the same gated, fail-soft notice as the legacy
 *     reviewKycAction (lib/kyc-notify.ts); a manual override sends none.
 * Known residuals: the kycMode check is read-then-write (as the hold release); two concurrent
 * submits of the same decision can both commit (each audited), as in the legacy action.
 */
export async function decideKycAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ADMIN);
  const notFound: ActionResult = { ok: false, error: t('partner.customers.notFound') };
  const notAllowed: ActionResult = { ok: false, error: t('partner.kyc.notAllowed') };

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

  const owner = await getPartnerStore().getPartner(ctx.partnerId);
  const rule = partnerKycDecision(owner, customer, decision);
  if (!rule.ok) return notAllowed;

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
    if (err instanceof Error && err.message === 'You do not have permission to perform this action.') return notAllowed;
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
