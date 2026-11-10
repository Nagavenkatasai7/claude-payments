// Fix pack 4 (C12, R18): the pre-verify gate context of the pay and link
// routes. It answers, before a code is sent or checked, whether this payment
// needs the disclosure acknowledgement and an approved provider block
// (disclosureMandatory), and whether the account-holder field counts as real
// money (realMoneyForField, read by T15's rule).
//
// It is an EARLY answer only. The authoritative gates still run later on the
// row being paid: pay-process's R18 gate (C9 step 6) and settleOrHold. So this
// read never throws: an unresolvable owner or anything unexpected gives the
// SAFE context (not mandatory), and the later gates decide.
//
// Reads: the owner (never for the default tenant: owner null, not a failure)
// through createPartnerRepo, and the RAIL partner's payment provider type
// (never for a sandbox 'test' transfer). An owner read error leaves the
// disclosure null, which refuses only when the payment is mandatory, i.e. on a
// real-money rail. A failed rail-type read counts as real money for the
// account-holder field only, and never for the default tenant (critic M3: the
// live gate refuses the default owner on every real-money rail).

import type { DbOrTx } from '@/db/client';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { DEFAULT_PARTNER_ID } from './defaults';
import { isLiveCertified, readRailProviderType, realMoneyRail } from './live-gate';
import { logWarn } from './log';
import { resolvePartnerDisclosure, type ResolvedDisclosure } from './partner-config';
import { disclosureMandatory } from './pay-disclosure-gate';
import type { Partner, PartnerId } from './types';

export interface PayGateContext {
  owner: Partner | null;
  ownerReadFailed: boolean;
  railProviderType: string | null | undefined;
  disclosure: ResolvedDisclosure | null;
  ownerCertified: boolean;
  realMoneyKnown: boolean;
  realMoneyForField: boolean;
  mandatory: boolean;
}

/** Any unexpected error, or an owner the route could not resolve: not mandatory; the authoritative gates still run. */
export const SAFE_PAY_GATE_CONTEXT: PayGateContext = Object.freeze({
  owner: null,
  ownerReadFailed: true,
  railProviderType: undefined,
  disclosure: null,
  ownerCertified: false,
  realMoneyKnown: false,
  realMoneyForField: false,
  mandatory: false,
}) as PayGateContext;

export async function readPayGateContext(
  db: DbOrTx,
  i: { ownerId: PartnerId; railPartnerId: PartnerId; environment: 'live' | 'test' | undefined; transferType: 'b2c' | 'b2b' },
): Promise<PayGateContext> {
  try {
    let owner: Partner | null = null;
    let ownerReadFailed = false;
    if (i.ownerId !== DEFAULT_PARTNER_ID) {
      try {
        owner = await createPartnerRepo(db).getPartner(i.ownerId);
      } catch (err) {
        // The error NAME only: a driver error can carry the connection string.
        logWarn('pay.gate-owner-read', err instanceof Error ? err.name : 'error', {
          partnerId: i.ownerId,
          railPartnerId: i.railPartnerId,
        });
        owner = null;
        ownerReadFailed = true;
      }
    }
    // Never throws: no row -> null (the mock rail), a failed read -> undefined.
    const railProviderType = i.environment === 'test' ? null : await readRailProviderType(db, i.railPartnerId);
    const disclosure = ownerReadFailed ? null : resolvePartnerDisclosure(owner);
    const ownerCertified = isLiveCertified(owner);
    const realMoney = realMoneyRail({ environment: i.environment, railProviderType });
    const realMoneyKnown = railProviderType !== undefined && realMoney;
    const realMoneyForField = i.ownerId !== DEFAULT_PARTNER_ID && realMoney;
    const mandatory = disclosureMandatory({ ownerCertified, realMoney: realMoneyKnown, transferType: i.transferType });
    return { owner, ownerReadFailed, railProviderType, disclosure, ownerCertified, realMoneyKnown, realMoneyForField, mandatory };
  } catch (err) {
    logWarn('pay.gate-context', err instanceof Error ? err.name : 'error', { partnerId: i.ownerId });
    return { ...SAFE_PAY_GATE_CONTEXT };
  }
}
