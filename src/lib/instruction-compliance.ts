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
import type { TravelRuleRequirement } from '@/lib/travel-rule';
import { ComplianceBlockUnavailableError, InstructPermanentError, isTransientInstructError } from './instruct-errors';
import { railPartnerOf } from './live-gate';

// Fix pack 5 T4 (P7): defined in instruct-errors.ts (no import cycle once T5
// makes this file throw InstructPermanentError), re-exported here.
export { ComplianceBlockUnavailableError } from './instruct-errors';

// Program-Fix 31 PR B (rail-10): the DB side of the settlement instruction's
// additive `compliance` block. The worker calls this once per settlement.instruct
// and spreads the result after every legacy key; the pure shape lives in
// buildComplianceBlock (http-payment-provider.ts).
//
// FAIL CLOSED (fix pack 5, P10): no instruction leaves without this block. A
// transient read failure (P7 allow-list) throws ComplianceBlockUnavailableError
// (retried, instructblock: alert from attempt 3); any other failure throws
// InstructPermanentError('compliance_block') (dead-lettered at once; ops Retry /
// partner Replay after the fix). The routed rule (originator null, C3) is not a
// failure. The warn carries the transfer id and the error NAME only.
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
 * the wire; only the per-role party COUNTS are (fix pack 5 T5, `names_screened`). A read error
 * throws into loadComplianceBlock's fail-closed catch.
 */
async function screeningRef(db: DbOrTx, transfer: Transfer, now: Date): Promise<ComplianceScreeningRef | null> {
  const newest = (await listScreenEvidence(db, transfer, now)).at(-1);
  if (!newest) return null;
  return {
    listSource: newest.listSource,
    listVersion: newest.listVersion,
    decision: newest.decision,
    screenedAt: newest.screenedAt,
    namesScreened: {
      sender: newest.parties.filter((p) => p.role === 'sender').length,
      recipient: newest.parties.filter((p) => p.role === 'recipient').length,
    },
    // Fix pack 5 T29 (P26): lists mode only; never the hashes or check times.
    ...(newest.lists ? { lists: newest.lists.map(({ source, version, fitness }) => ({ source, version, fitness })) } : {}),
  };
}

export async function loadComplianceBlock(
  db: DbOrTx,
  transfer: Transfer,
  now: Date = new Date(),
  opts: { travelRule?: TravelRuleRequirement | null } = {},
): Promise<ComplianceBlock> {
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
      travelRule: opts.travelRule ?? null,
    });
  } catch (err) {
    // The error text is never logged: a decrypt or driver error can carry PII.
    logWarn('instruct.compliance_block', err instanceof Error ? err.name : 'error', { transferId: transfer.id });
    if (isTransientInstructError(err)) {
      throw new ComplianceBlockUnavailableError(transfer.id, railPartnerOf(transfer), { cause: err });
    }
    throw new InstructPermanentError(transfer.id, 'compliance_block', { cause: err });
  }
}
