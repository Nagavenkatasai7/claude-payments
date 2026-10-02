import { getPartnerStore } from '@/lib/partner-store';
import { sendGateActive } from '@/lib/kyc-gate';
import { optOutSuppresses } from '@/lib/consent-gate';
import { partnerWaContext } from '@/lib/whatsapp-creds';
import { sendVerificationStatus } from '@/lib/whatsapp';
import { logWarn } from '@/lib/log';
import type { Customer } from '@/lib/types';

/**
 * The customer-facing WhatsApp notice after a human KYC REVIEW decision (Persona review queue).
 * Extracted from the legacy reviewKycAction (merge plan 2c) so the /partner decision sends the
 * same notice; the manual override path sends none (unchanged).
 *
 * KYC is partner OPT-IN: the decision and its audit row stand regardless, but the notice only
 * fires when the owning partner's verify-before-send gate is ON (sendGateActive; a missing
 * partner falls back to the default one, as before). Program-Fix 49A: it is nonessential (not
 * sent after STOP) and leaves from the owning partner's own number. Fail-soft: a notify failure
 * never voids the committed review, so this never throws (only the error NAME is logged).
 */
export async function notifyKycReviewDecision(
  customer: Pick<Customer, 'partnerId' | 'fullName' | 'optedOutAt'>,
  phone: string,
  decision: 'approve' | 'reject',
): Promise<void> {
  try {
    const partner =
      (await getPartnerStore().getPartner(customer.partnerId)) ?? (await getPartnerStore().ensureDefaultPartner());
    if (!sendGateActive(partner) || optOutSuppresses(customer, 'nonessential')) return;
    const { waCreds } = await partnerWaContext(customer.partnerId);
    await sendVerificationStatus(phone, decision === 'approve' ? 'verified' : 'failed', customer.fullName, waCreds).catch(() => {});
  } catch (err) {
    logWarn('kyc.review.notify', err instanceof Error ? err.name : 'error', { partnerId: customer.partnerId });
  }
}
