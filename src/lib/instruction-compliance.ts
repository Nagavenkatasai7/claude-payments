import type { DbOrTx } from '@/db/client';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import {
  buildComplianceBlock,
  type ComplianceBlock,
  type ComplianceScreeningRef,
} from '@/lib/providers/http-payment-provider';
import { SANCTIONS_AUDIT_ACTION } from '@/lib/sanctions/evidence';
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

/** The fix 14 evidence row is written in the mint transaction; ±10 min of createdAt bounds the indexed read. */
const EVIDENCE_WINDOW_MS = 10 * 60 * 1000;

/** The latest sanctions.screen evidence for this transfer, as a name-free reference; null when none. */
async function screeningRef(db: DbOrTx, transfer: Transfer): Promise<ComplianceScreeningRef | null> {
  const created = new Date(transfer.createdAt).getTime();
  if (!Number.isFinite(created)) return null;
  const rows = await createAuditRepo(db).listBySubject(
    transfer.partnerId,
    transfer.id,
    new Date(created - EVIDENCE_WINDOW_MS),
    new Date(created + EVIDENCE_WINDOW_MS),
  );
  const row = rows.filter((r) => r.action === SANCTIONS_AUDIT_ACTION).at(-1);
  if (!row) return null;
  // meta is jsonb: whitelist the four reference fields, each type-checked.
  // The per-party input hashes and scores are never copied onto the wire.
  const { listSource, listVersion, decision, screenedAt } = row.meta;
  if (
    typeof listSource !== 'string' ||
    typeof listVersion !== 'string' ||
    typeof decision !== 'string' ||
    typeof screenedAt !== 'string'
  ) {
    return null;
  }
  return { listSource, listVersion, decision, screenedAt };
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
    const screening = await screeningRef(db, transfer);
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
