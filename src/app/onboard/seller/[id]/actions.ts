'use server';

import { headers } from 'next/headers';
import { getStore } from '@/lib/store';
import { getTransactionOtpStore } from '@/lib/transaction-otp';
import { getPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { waCredsFrom } from '@/lib/whatsapp-creds';
import { sendTransactionOtp, type WaCreds } from '@/lib/whatsapp';
import { composeUsdcDestination, validatePayoutFields, validateUsdcAddress } from '@/lib/payout-format';
import { checkIpRateLimit, clientIpFrom } from '@/lib/ip-rate-limit';
import { getRedis } from '@/lib/redis';
import { logError } from '@/lib/log';
import type { Seller } from '@/lib/types';

// Hosted seller-onboarding server actions — the web-finish of the WhatsApp-start
// register_seller flow. The route `id` is the ONLY trusted identity: every action
// re-loads the seller by id and re-self-gates (exists + still PENDING + not held
// for review) before doing anything. The seller proves control of their WhatsApp
// number via a per-transaction OTP (the same transaction-otp seam the pay page
// uses) before we encrypt their payout and flip them to ACTIVE. Body fields are
// never trusted for identity; writes are scoped by the seller's own phone+partner.

export type OnboardResult =
  | { ok: true }
  | { ok: false; error: string; fieldErrors?: Record<string, string>; reason?: 'otp' | 'state' | 'rate' };

/** Eligible to finish onboarding ONLY while pending AND not flagged for review. */
function eligible(seller: Seller): boolean {
  return seller.status === 'pending' && seller.kycReviewState !== 'needs_review';
}

/**
 * Step-up (1): issue + deliver a confirmation code to the seller's WhatsApp,
 * bound to BOTH this onboarding id AND their number. No state change. Returns a
 * bare { ok } — never leaks whether the id exists beyond "can't send".
 */
export async function requestSellerOtpAction(id: string): Promise<{ ok: boolean }> {
  const sellerId = String(id ?? '');
  try {
    const seller = await getStore().getSellerById(sellerId);
    if (!seller || !eligible(seller)) return { ok: false };

    // Per-IP outer ring (fail-open — availability wins over a limiter outage).
    try {
      const ip = clientIpFrom(await headers());
      const r = await checkIpRateLimit(getRedis(), 'seller-onboard-otp', ip, { limit: 10, windowSec: 3600 });
      if (!r.allowed) return { ok: false };
    } catch { /* never block on a limiter error */ }

    // Program-Fix 45: its own per-phone budget (kind 'seller', the seller's partner).
    const issued = await getTransactionOtpStore().issue(sellerId, seller.phone, { kind: 'seller', partnerId: seller.partnerId });
    if (!issued.ok) return { ok: false }; // cooldown, or an issue cap (locked): same bare answer
    // Deliver from the seller's partner WhatsApp number when configured.
    let creds: WaCreds | undefined;
    try {
      creds = waCredsFrom(await getPartnerIntegrationsStore().getIntegrations(seller.partnerId));
    } catch { /* fall back to the shared env number */ }
    try { await sendTransactionOtp(seller.phone, issued.code, creds); } catch { /* generic surface; never log the code */ }
    return { ok: true };
  } catch (err) {
    logError('seller-onboard.request-otp', err, { sellerId });
    return { ok: false };
  }
}

/**
 * Step-up (2) + activate: verify the OTP, re-validate the payout fields
 * authoritatively — per-country BANK fields, or (method 'usdc') the wallet
 * address shape — compose + ENCRYPT the payout destination (repo encrypts),
 * and flip the seller to ACTIVE with the chosen payout method. Self-gated: the
 * seller must exist and still be PENDING (refuses an already-active, suspended,
 * under-review, or unknown seller). Nothing is written until the OTP and the
 * fields both pass. The METHOD is never trusted raw: anything but the literal
 * 'usdc' validates as bank, so a forged method can't skip the bank validation.
 */
export async function activateSellerAction(input: {
  id: string;
  fields: Record<string, string>;
  otp: string;
  /** Payout method chosen on the page. Absent/unknown ⇒ 'bank' (back-compat). */
  method?: 'bank' | 'usdc';
}): Promise<OnboardResult> {
  const id = String(input?.id ?? '');
  try {
    // Per-IP outer ring (fail-open).
    try {
      const ip = clientIpFrom(await headers());
      const r = await checkIpRateLimit(getRedis(), 'seller-onboard', ip, { limit: 20, windowSec: 3600 });
      if (!r.allowed) {
        return { ok: false, error: 'Too many attempts — please wait a minute and try again.', reason: 'rate' };
      }
    } catch { /* never block on a limiter error */ }

    // IDENTITY — the route id is authoritative. Re-load + self-gate.
    const seller = await getStore().getSellerById(id);
    if (!seller || !eligible(seller)) {
      return { ok: false, error: 'This onboarding link is no longer active.', reason: 'state' };
    }

    // OTP step-up bound to (id, seller.phone) — verified BEFORE any write.
    const otpCode = String(input?.otp ?? '').replace(/\D/g, '');
    const otpCheck = await getTransactionOtpStore().verify(id, seller.phone, otpCode);
    if (!otpCheck.ok) {
      return { ok: false, error: 'Enter the confirmation code we sent to your WhatsApp.', reason: 'otp' };
    }

    // Re-validate the payout fields authoritatively server-side (never trust the
    // client): bank ⇒ the SELLER's own country's field rules; usdc ⇒ the wallet
    // address shape, composed to the canonical `USDC|<address>` string here.
    // Strict equality on the literal 'usdc' — any other value validates as bank.
    const method: 'bank' | 'usdc' = input?.method === 'usdc' ? 'usdc' : 'bank';
    const rawFields = input?.fields && typeof input.fields === 'object' ? input.fields : {};
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawFields)) {
      if (typeof v === 'string') fields[k] = v;
    }
    let payoutDestination: string;
    if (method === 'usdc') {
      const wallet = validateUsdcAddress(fields.walletAddress ?? '');
      if (!wallet.ok) {
        return { ok: false, error: 'Please check your wallet address.', fieldErrors: { walletAddress: wallet.error } };
      }
      payoutDestination = composeUsdcDestination(wallet.address);
    } else {
      const validation = validatePayoutFields(seller.country, fields);
      if (!validation.ok) {
        return { ok: false, error: 'Please check your payout bank details.', fieldErrors: validation.errors };
      }
      payoutDestination = validation.payoutDestination;
    }

    // Persist the ENCRYPTED payout + the chosen payout method AND flip ACTIVE in
    // ONE guarded atomic write, scoped by the seller's own phone + partner. The
    // guard re-checks pending + not-needs_review at WRITE time (closes the TOCTOU
    // against a review hold that lands between page load and submit); a null
    // return means the seller was no longer eligible (raced, re-flagged, or gone)
    // → refuse rather than report a false success.
    const activated = await getStore().completeSellerOnboarding(
      seller.phone, seller.partnerId, payoutDestination, method,
    );
    if (!activated) {
      return { ok: false, error: 'This onboarding link is no longer active.', reason: 'state' };
    }
    return { ok: true };
  } catch (err) {
    logError('seller-onboard.activate', err, { sellerId: id });
    return { ok: false, error: 'Something went wrong — please try again.' };
  }
}
