// Fix pack 6 truth check TC-T1 — staff record a customer's withdrawal of the E-SIGN consent.
// The consent text (src/lib/legal/esign-consent.ts) tells the customer to withdraw "in Profile if
// your provider offers one, or contact the provider named on your receipt"; this module is the
// provider route: partner staff (/partner/customers/[ref]) and SmartRemit staff
// (/admin-dashboard/customers/[ref]) record it, and the next pay-page payment asks again.
//
// SERVER module (it imports the customer repo and the audit repo): a 'use client' file must never
// import it. No step-up: recording a withdrawal weakens no control, it only makes the next
// pay-page payment ask the customer again.

import type { Db } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { withdrawEsignConsent, type EsignConsentState } from '@/db/repos/customer-repo';
import { auditSubjectId } from '@/lib/customer-ref';
import { esignConsentNeeded } from '@/lib/esign';
import { ESIGN_CONSENT_VERSION } from '@/lib/legal/esign-consent';
import type { PartnerId } from '@/lib/types';

export interface StaffEsignWithdrawal {
  partnerId: PartnerId;
  phone: string;
  /** The staff username (audit `actor`). */
  actor: string;
  /** Which workspace recorded it (the `meta.actorScope` the other staff audit rows carry). */
  actorScope: 'partner' | 'platform';
}

/**
 * ONE transaction: withdrawEsignConsent (tenant-scoped by the owner key) and, only when a consent
 * was on file, ONE `customer.consent.esign` audit row { version, on: false, via: 'staff',
 * actorScope } with the keyed subject (no phone, no name). Nothing on file or already withdrawn:
 * no write, no audit row, { withdrawn: false }. No outbox row (nothing is sent). Throws on a DB
 * error (the caller logs the error name).
 */
export async function recordStaffEsignWithdrawal(
  db: Db,
  w: StaffEsignWithdrawal,
): Promise<{ withdrawn: boolean; version?: string }> {
  return db.transaction(async (tx) => {
    const version = await withdrawEsignConsent(tx, w.partnerId, w.phone, new Date());
    if (!version) return { withdrawn: false };
    await createAuditRepo(tx).record({
      partnerId: w.partnerId,
      actor: w.actor,
      actorType: 'staff',
      action: 'customer.consent.esign',
      subjectId: auditSubjectId(w.partnerId, w.phone),
      meta: { version, on: false, via: 'staff', actorScope: w.actorScope },
    });
    return { withdrawn: true, version };
  });
}

export interface EsignConsentView {
  state: 'none' | 'on' | 'withdrawn';
  version?: string;
  consentedAt?: Date;
  withdrawnAt?: Date;
  /** The version on file is the current consent text. */
  current?: boolean;
}

/**
 * Pure: what the staff pages show. 'none' = nothing ever consented. Otherwise the SAME rule as
 * esignConsentNeeded, applied to the version on file (a withdrawal at or after the consent time is
 * withdrawn), so a consent of an older text is still shown as on file with its version.
 */
export function esignConsentView(row: EsignConsentState | null, currentVersion: string = ESIGN_CONSENT_VERSION): EsignConsentView {
  if (!row || !row.version || !row.consentedAt) return { state: 'none' };
  const withdrawn = esignConsentNeeded(row, row.version);
  return {
    state: withdrawn ? 'withdrawn' : 'on',
    version: row.version,
    consentedAt: row.consentedAt,
    ...(withdrawn && row.withdrawnAt ? { withdrawnAt: row.withdrawnAt } : {}),
    current: row.version === currentVersion,
  };
}
