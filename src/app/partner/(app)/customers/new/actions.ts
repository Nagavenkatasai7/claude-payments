'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { getDb } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { getStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { getPartnerStore } from '@/lib/partner-store';
import { resolveKycMode } from '@/lib/partner-config';
import { auditSubjectId } from '@/lib/customer-ref';
import { freshManualCustomer, parseManualCustomer } from '@/lib/partner-customer-create';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import { getAuthStore } from '@/lib/auth-store';
import { staffMfaEnrolled } from '@/lib/staff-mfa-store';
import { isQualifiedComplianceUser, partnerDecidesKyc } from '@/lib/partner-decision-scope';
import { gatePartnerStepUp } from '@/lib/partner-step-up-gate';
import type { StepUpRequired } from '@/lib/staff-step-up-result';
import type { Partner, Staff } from '@/lib/types';
import { partnerCustomerPath } from '../../../customer-link';
import { PARTNER_ROUTES } from '../../../routes';
import type { ActionResult } from '../../../action-result';

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

/**
 * Create one customer by hand at THIS tenant (lost-features p2 A5). A compliance write, in order:
 *  1. the partner-site host guard, then the PARTNER_ADMIN gate (outside any try);
 *  2. the tenant is the session's (any posted tenant field is never read); the owner is re-read
 *     here, so the countries and the KYC mode are the server's, not the form's;
 *  3. parseManualCustomer: phone, a country the partner serves, an optional name, and the status:
 *     `not_started`, or `verified` only in delegated KYC mode with a reason (never grandfathered);
 *  4. ONE transaction: insert-if-absent on (tenant, phone), then the `customer.create` audit row,
 *     plus `kyc.manual_override.create` for verified. An existing customer is never overwritten
 *     (fixed copy, nothing written); a failed audit insert rolls the customer row back;
 *  5. redirect to the sealed ref, outside any try (the phone never reaches the URL).
 * Fix pack 7 T26 (R12, P22): for a partner that DECIDES KYC (partnerDecidesKyc) a `verified`
 * status is a KYC decision: after step 3 and before any write, it needs a qualified compliance
 * user (fresh staff read, two-step enrolled, isQualifiedComplianceUser; anyone else gets the
 * existing verifiedNotAllowed copy) and the forced step-up 'kyc.decide'. Every other partner and
 * every `not_started` create are unchanged.
 * The customer gets no message and no consent is implied. Sanctions screening runs on every
 * transfer they make, as for any customer.
 */
export async function createCustomerAction(formData: FormData): Promise<ActionResult | StepUpRequired> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.customersNew.policy);
  const failed: ActionResult = { ok: false, error: t('partner.common.failed') };

  let owner;
  try {
    owner = await getPartnerStore().getPartner(ctx.partnerId);
  } catch (err) {
    logWarn('partner.customers.create', errName(err), { partnerId: ctx.partnerId });
    return failed;
  }
  if (!owner) return failed;

  const parsed = parseManualCustomer(formData, { countries: owner.countries, kycMode: resolveKycMode(owner).mode });
  if (!parsed.ok) return { ok: false, error: t(parsed.errorKey) };
  if (parsed.kycStatus === 'verified' && partnerDecidesKyc(owner)) {
    if (!(await qualifiedToVerify(owner, ctx.username))) return { ok: false, error: t('partner.customers.create.verifiedNotAllowed') };
    const stepUp = await gatePartnerStepUp(ctx, formData, 'kyc.decide', { always: true });
    if (stepUp) return stepUp;
  }

  const now = new Date().toISOString();
  const reviewer = ctx.staff.name && ctx.staff.name !== ctx.username ? `${ctx.staff.name} (${ctx.username})` : ctx.username;
  const row = freshManualCustomer(parsed, ctx.partnerId, now, reviewer);
  const subjectId = auditSubjectId(ctx.partnerId, parsed.phone);

  let created: boolean;
  try {
    created = await getDb().transaction(async (tx) => {
      if (!(await createCustomerStore(tx, getStore()).insertCustomerIfAbsent(row))) return false;
      const audit = createAuditRepo(tx);
      await audit.record({
        partnerId: ctx.partnerId,
        actor: ctx.username,
        actorType: 'staff',
        action: 'customer.create',
        subjectId,
        meta: { kycStatus: parsed.kycStatus, senderCountry: parsed.senderCountry, source: 'manual', actorScope: 'partner' },
      });
      if (parsed.kycStatus === 'verified') {
        await audit.record({
          partnerId: ctx.partnerId,
          actor: ctx.username,
          actorType: 'staff',
          action: 'kyc.manual_override.create',
          subjectId,
          meta: { previousStatus: null, newStatus: 'verified', reason: parsed.reason, source: 'manual', reviewerName: reviewer, actorScope: 'partner' },
        });
      }
      return true;
    });
  } catch (err) {
    logWarn('partner.customers.create', errName(err), { partnerId: ctx.partnerId });
    return failed;
  }
  if (!created) return { ok: false, error: t('partner.customers.create.exists') };

  revalidatePath('/partner/customers');
  redirect(partnerCustomerPath(ctx.partnerId, parsed.phone));
}

/** Fix pack 7 T26 (R12): a fresh staff read, then two-step; every failure is "not qualified". */
async function qualifiedToVerify(owner: Partner, username: string): Promise<boolean> {
  let staff: Staff | null;
  try {
    staff = await getAuthStore().getStaff(username);
  } catch {
    return false;
  }
  if (!staff || staff.username !== username) return false;
  const fact = { username: staff.username, partnerId: staff.partnerId ?? null, role: staff.role, active: staff.status !== 'suspended' };
  return isQualifiedComplianceUser(owner, fact, await staffMfaEnrolled(username));
}
