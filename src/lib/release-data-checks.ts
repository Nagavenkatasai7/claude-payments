import type { DbOrTx } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import type { PartnerIntegrations } from '@/lib/partner-integrations';
import type { Transfer } from '@/lib/types';
import { realMoneyRail } from '@/lib/live-gate';
import { originatorInfoMissing } from '@/lib/originator-info';

// release-data-checks — Fix pack 7 T8a (O2): the two "data on file" checks of
// a release, moved UNCHANGED out of settlement.ts so the review seam
// (hold-review-tx.ts, which never imports settlement) can compute P4's
// `dataOnFile` with the same functions. Both are async reads that need the
// RAIL partner's integrations (settlementPartnerId ?? partnerId).

/**
 * Fix pack 4 (R03, C19, critic P4): true when a release would send a
 * real-money consumer row to the rail with no account-holder (legal) name on
 * file, WHETHER OR NOT the row carries RECIPIENT_IDENTITY_MISSING (a row held
 * before deploy, or while its rail was not yet real money). Partner-API and
 * payment-link rows are exempt in the SQL; a B2B row is never missing. No
 * reason tag and no lock: a legal name is only ever written while
 * awaiting_payment, so an in_review row cannot gain one under the release.
 * Not real money: no query. A NULL test only (no decrypt); logs nothing.
 */
export async function identityMissingForRelease(
  tx: DbOrTx,
  t: Pick<Transfer, 'id' | 'partnerId' | 'environment'>,
  railIntegrations: PartnerIntegrations,
): Promise<boolean> {
  if (!realMoneyRail({ environment: t.environment, railProviderType: railIntegrations.payment.providerType ?? null })) return false;
  return createTransferRepo(tx).recipientIdentityMissing(t.id, t.partnerId);
}

/**
 * Fix pack 5 (R38, P22): true when a release would send a real-money row whose
 * travel-rule originator data is not on file (or a ROUTED row, whose data
 * cannot be sent) to the rail, WHETHER OR NOT the row carries
 * ORIGINATOR_INFO_MISSING (a row held before deploy). B2B and Partner-API rows
 * are exempt (originatorInfoMissing's SQL). Not real money: no read. A read
 * error throws (the transaction rolls back, nothing released). NULL tests only
 * (no decrypt); logs nothing.
 */
export async function originatorMissingForRelease(
  tx: DbOrTx,
  t: Pick<Transfer, 'id' | 'partnerId' | 'phone' | 'settlementPartnerId' | 'destinationCountry' | 'amountUsd' | 'environment'>,
  railIntegrations: PartnerIntegrations,
): Promise<boolean> {
  if (!realMoneyRail({ environment: t.environment, railProviderType: railIntegrations.payment.providerType ?? null })) return false;
  return originatorInfoMissing(tx, t);
}
