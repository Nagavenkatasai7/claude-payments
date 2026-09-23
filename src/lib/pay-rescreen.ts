import type { Db } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { screenTransfer } from './compliance';
import { warmSanctionsList } from './providers/sanctions-provider';
import { SCREENING_REASONS, type ResolvedCorridorRules } from './compliance-config';
import { sanctionsAuditEvent } from './sanctions/evidence';
import type { Transfer } from './types';

// Program-Fix 14 follow-up: paying an EXISTING transfer (a scheduled transfer
// awaiting payment, a re-opened link) re-screens both parties right before
// any charge. The mint screened them once, but time passes between mint and
// payment (lists change, a scheduled mint had no sender name to screen), so
// the pay page must not pay on a stale verdict.
//
// The verdict comes from the SANCTIONS decision only. Amount and velocity
// reasons were decided at mint and are not re-derived here (a cleared row is
// never re-flagged for them):
//   match                           → blocked
//   possible match / list unavailable → flagged (screening reasons only)
//   clear                           → no status write
// Every screen writes its PII-free sanctions.screen evidence row in the SAME
// transaction as the verdict. Names are passed in decrypted by the caller and
// never logged or stored (the evidence carries input hashes only).

export type RescreenOutcome =
  | { kind: 'cleared'; transfer: Transfer } // unchanged row, evidence recorded
  | { kind: 'flagged'; transfer: Transfer } // compliance flagged → the normal hold
  | { kind: 'blocked' } // sanctions hit: never charged, never instructed
  | { kind: 'moved' }; // a guard failed (row no longer awaiting / already blocked)

export async function rescreenBeforePay(
  db: Db,
  transfer: Transfer,
  names: { senderName: string; recipientName: string },
  rules: ResolvedCorridorRules,
): Promise<RescreenOutcome> {
  // Program-Fix 14 PR C: refresh the OFAC list (no-op unless
  // SANCTIONS_LIST=ofac-sdn) — here, OUTSIDE the transaction below, never
  // inside screenTransfer (the mint calls that under its sender lock).
  await warmSanctionsList();
  const result = await screenTransfer({
    amountUsd: transfer.amountUsd,
    recipientName: names.recipientName,
    senderName: names.senderName,
    // Velocity was decided at mint; only the sanctions decision is used below.
    transfersToday: 0,
    sourceCountry: transfer.sourceCountry ?? 'US',
    rules,
  });

  const decision = result.evidence?.decision;
  const verdict: 'blocked' | 'flagged' | null =
    result.status === 'blocked'
      ? 'blocked'
      : decision === 'possible_match' || decision === 'list_unavailable'
        ? 'flagged'
        : null;
  const added = result.reasons.filter((r) => SCREENING_REASONS.includes(r));
  const reasons = [...new Set([...(transfer.complianceReasons ?? []), ...added])];

  return db.transaction(async (tx): Promise<RescreenOutcome> => {
    let updated: Transfer | null = transfer;
    if (verdict) {
      updated = await createTransferRepo(tx).applyRescreenIfAwaiting(
        transfer.id,
        transfer.partnerId,
        verdict,
        reasons,
      );
      if (!updated) return { kind: 'moved' }; // nothing written, not even evidence
    }
    if (result.evidence) {
      await createAuditRepo(tx).record(sanctionsAuditEvent(transfer.partnerId, transfer.id, result.evidence));
    }
    if (verdict === 'blocked') return { kind: 'blocked' };
    if (verdict === 'flagged') return { kind: 'flagged', transfer: updated };
    return { kind: 'cleared', transfer };
  });
}
