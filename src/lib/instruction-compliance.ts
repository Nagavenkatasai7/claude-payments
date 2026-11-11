import type { DbOrTx } from '@/db/client';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import {
  buildComplianceBlock,
  type ComplianceBlock,
  type ComplianceScreeningRef,
} from '@/lib/providers/http-payment-provider';
import { listScreenEvidence } from '@/lib/sanctions/evidence-read';
import { sendGateActive } from '@/lib/kyc-gate';
import { logWarn } from '@/lib/log';
import type { Transfer } from '@/lib/types';

// Program-Fix 31 PR B (rail-10): the DB side of the settlement instruction's
// additive `compliance` block. The worker calls this once per settlement.instruct
// and spreads the result after every legacy key; the pure shape lives in
// buildComplianceBlock (http-payment-provider.ts).
//
// FAIL OPEN: nothing here may stop a paid transfer from being instructed. A
// failed customer / partner read (or a throw in the builder) degrades to a
// block with originator null and a warn carrying the transfer id only; if even
// that throws, the key is omitted (the block is optional for the rail, docs §3).
//
// TENANT: the customer and the partner are read under the OWNER partnerId
// (customers are keyed (partner_id, phone)), never the routed rail partner's.

/**
 * Fix pack 4 (C20): the newest sanctions.screen row, the same one the instruct gate judges
 * (outbox-worker.ts, listScreenEvidence(...).at(-1)), as a name-free reference; null when none.
 * Its own query on the action, window [createdAt - 10 min, now + 1 min), so a pay-time or list
 * re-screen hours after the mint is the reference and no other audit row can crowd it out.
 * Malformed rows are skipped (the previous valid row is the reference). parseEvidence already
 * type-checked the four fields; the per-party input hashes and scores are never copied onto
 * the wire. A read error throws into loadComplianceBlock's fail-open catch.
 */
async function screeningRef(db: DbOrTx, transfer: Transfer, now: Date): Promise<ComplianceScreeningRef | null> {
  const newest = (await listScreenEvidence(db, transfer, now)).at(-1);
  if (!newest) return null;
  return {
    listSource: newest.listSource,
    listVersion: newest.listVersion,
    decision: newest.decision,
    screenedAt: newest.screenedAt,
  };
}

export async function loadComplianceBlock(
  db: DbOrTx,
  transfer: Transfer,
  now: Date = new Date(),
): Promise<ComplianceBlock | undefined> {
  try {
    const transfers = createTransferRepo(db);
    const customer = await createCustomerRepo(db, (p, ph) => transfers.firstTransferAt(p, ph)).getCustomer(
      transfer.partnerId,
      transfer.phone,
    );
    const partner = await createPartnerRepo(db).getPartner(transfer.partnerId);
    const screening = await screeningRef(db, transfer, now);
    return buildComplianceBlock(transfer, customer, now, {
      kycGateActive: sendGateActive(partner),
      screening,
    });
  } catch {
    // The error text is never logged: a decrypt or driver error can carry PII.
    logWarn('instruct.compliance_block', 'compliance block degraded; originator omitted', {
      transferId: transfer.id,
    });
    try {
      return buildComplianceBlock(transfer, null, now, { omitOriginator: true });
    } catch {
      return undefined;
    }
  }
}
