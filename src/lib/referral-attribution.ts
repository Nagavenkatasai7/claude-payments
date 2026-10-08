import type { DbOrTx } from '@/db/client';
import { createReferralRepo, type ReferralChannel } from '@/db/repos/referral-repo';
import { findReferralCodeInText, normalizeReferralCode } from './referrals';
import { logWarn } from './log';
import type { PartnerId } from './types';

// referral-attribution — Batch B4. The two best-effort seams that link a customer to a
// referral partner: a code in an inbound WhatsApp message (whatsapp-inbound.ts) and the
// portal's referral cookie at sign-in (portal/login/actions.ts). BEST EFFORT: an error is
// logged (tenant and channel only, never the phone or the code) and never thrown, so a
// referral can never block a message or a sign-in. The rules (first referral wins, active
// codes only, no customer with a delivered transfer) live in referralRepo.recordAttribution.

export async function recordReferral(
  db: DbOrTx,
  input: { partnerId: PartnerId; phone: string; code: unknown; channel: ReferralChannel },
): Promise<boolean> {
  const code = normalizeReferralCode(input.code);
  if (!code) return false;
  try {
    return await createReferralRepo(db).recordAttribution({ partnerId: input.partnerId, phone: input.phone, code, channel: input.channel });
  } catch (err) {
    logWarn('referral.attribution', err, { partnerId: input.partnerId, channel: input.channel });
    return false;
  }
}

/**
 * "Referred by <name>" for a customer page: the referral partner's name for (tenant, phone), or
 * null. Keyed by the caller's tenant (a partner page passes its SESSION tenant). A read error only
 * logs (tenant id only) and shows nothing: a referral line never breaks a customer page.
 */
export async function referredByName(db: () => DbOrTx, partnerId: PartnerId, phone: string): Promise<string | null> {
  try {
    return (await createReferralRepo(db()).getAttribution(partnerId, phone))?.referralPartnerName ?? null;
  } catch (err) {
    logWarn('referral.referred_by', err, { partnerId });
    return null;
  }
}

/** The WhatsApp seam: only a text that carries a code costs a database call. */
export async function recordWhatsAppReferral(db: DbOrTx, partnerId: PartnerId, phone: string, text: string): Promise<boolean> {
  const code = findReferralCodeInText(text);
  if (!code) return false;
  return recordReferral(db, { partnerId, phone, code, channel: 'whatsapp' });
}
