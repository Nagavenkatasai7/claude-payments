import type { Db } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { screenTransfer } from './compliance';
import { warmSanctionsList } from './providers/sanctions-provider';
import {
  POSSIBLE_MATCH_REASON,
  SCREENING_REASONS,
  SENDER_IDENTITY_MISSING_REASON,
  resolveCorridorRules,
  type ResolvedCorridorRules,
} from './compliance-config';
import { sanctionsAuditEvent } from './sanctions/evidence';
import { listScreenEvidence, uncoveredRoles } from './sanctions/evidence-read';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { createPartnerStore } from './partner-store';
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
//
// Fix pack 2 T3 (R02): on a REAL-MONEY rail (live-gate.ts realMoneyFor: the
// transfer's rail partner is http, env not 'test') the re-screen requires a
// LIVE list: a stale or missing list flags LIST_UNAVAILABLE (released only by
// an automatic re-screen on a fresh list). It must also cover every name the
// transfer was screened under before (uncoveredRoles): a name it cannot
// re-screen (a Partner-API body sender name, never stored) goes to a person
// (SENDER_IDENTITY_MISSING for the sender, POSSIBLE_MATCH for a recipient).
// Both recipient names are screened: the one passed in and the stored
// transfer.recipientName when it differs.

export type RescreenOutcome =
  | { kind: 'cleared'; transfer: Transfer } // unchanged row, evidence recorded
  | { kind: 'flagged'; transfer: Transfer } // compliance flagged → the normal hold
  | { kind: 'blocked' } // sanctions hit: never charged, never instructed
  | { kind: 'moved' }; // a guard failed (row no longer awaiting / already blocked)

/** Where a re-screen runs (T5 names the sanctions.block notice by it). */
export type RescreenStage = 'pay' | 'confirm' | 'resume';

export interface RescreenOpts {
  /** live-gate.ts realMoneyFor(transfer): the re-screen requires a live list and full coverage. */
  realMoney?: boolean;
  stage?: RescreenStage;
}

export async function rescreenBeforePay(
  db: Db,
  transfer: Transfer,
  names: { senderName: string; recipientName: string; alsoRecipientNames?: string[] },
  rules: ResolvedCorridorRules,
  opts: RescreenOpts = {},
): Promise<RescreenOutcome> {
  const realMoney = opts.realMoney === true;
  const now = new Date();
  // Program-Fix 14 PR C: refresh the OFAC list (no-op unless
  // SANCTIONS_LIST=ofac-sdn) — here, OUTSIDE the transaction below, never
  // inside screenTransfer (the mint calls that under its sender lock).
  await warmSanctionsList();
  // Fix pack 2 T3: what this transfer was screened under before, read BEFORE
  // this screen writes its own row (outside the transaction). A read error
  // propagates: nothing moves on it.
  const prior = realMoney ? await listScreenEvidence(db, transfer, now) : [];
  const also = [...(names.alsoRecipientNames ?? [])];
  if (transfer.recipientName && transfer.recipientName !== names.recipientName) also.push(transfer.recipientName);
  const result = await screenTransfer({
    amountUsd: transfer.amountUsd,
    recipientName: names.recipientName,
    senderName: names.senderName,
    // Velocity was decided at mint; only the sanctions decision is used below.
    transfersToday: 0,
    sourceCountry: transfer.sourceCountry ?? 'US',
    rules,
    requireLiveList: realMoney,
    now,
    ...(also.length > 0 ? { alsoRecipientNames: also } : {}),
  });
  const uncovered = realMoney
    ? uncoveredRoles(prior, { senderName: names.senderName, recipientNames: [names.recipientName, ...also] })
    : [];

  const decision = result.evidence?.decision;
  const verdict: 'blocked' | 'flagged' | null =
    result.status === 'blocked'
      ? 'blocked'
      : decision === 'possible_match' || decision === 'list_unavailable' || uncovered.length > 0
        ? 'flagged'
        : null;
  const added = result.reasons.filter((r) => SCREENING_REASONS.includes(r));
  if (verdict === 'flagged') {
    if (uncovered.includes('sender')) added.push(SENDER_IDENTITY_MISSING_REASON);
    if (uncovered.includes('recipient')) added.push(POSSIBLE_MATCH_REASON);
  }
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

/**
 * The names a stored transfer is re-screened under, resolved server-side on
 * `db` (never logged): the sender's legal name on file (OWNER tenant), the
 * decrypted recipient legal name (else the stored recipient name), and the
 * stored recipient name as a further recipient name when it differs. Moved
 * here from stripe-funded-settle.ts (defaultRescreen); T4's sweep reuses it.
 */
export async function resolveRescreenNames(
  db: Db,
  t: Transfer,
): Promise<{ senderName: string; recipientName: string; alsoRecipientNames: string[] }> {
  // getCustomer never calls firstTransferAt (only the upserts do).
  const owner = await createCustomerRepo(db, async () => null).getCustomer(t.partnerId, t.phone);
  const decrypted = await createTransferRepo(db).getTransfer(t.id, { decrypt: true });
  const legal = decrypted && decrypted.partnerId === t.partnerId ? (decrypted.recipientLegalName ?? '').trim() : '';
  const recipientName = legal || t.recipientName;
  return {
    senderName: (owner?.fullName ?? '').trim(),
    recipientName,
    alsoRecipientNames: t.recipientName && t.recipientName !== recipientName ? [t.recipientName] : [],
  };
}

/**
 * Re-screen a stored transfer with the names on file and its OWNER's corridor
 * rules (the pay route's inputs). Used where no request carries the names: the
 * Stripe-funded settle, the Partner-API confirm and the reconcile resume.
 * Every read runs before rescreenBeforePay's transaction.
 */
export async function rescreenOnFile(
  db: Db,
  t: Transfer,
  opts: { realMoney: boolean; stage?: RescreenStage },
): Promise<RescreenOutcome> {
  const names = await resolveRescreenNames(db, t);
  const partners = createPartnerStore(db);
  const partner = (await partners.getPartner(t.partnerId)) ?? (await partners.ensureDefaultPartner());
  return rescreenBeforePay(db, t, names, resolveCorridorRules(partner, t.sourceCountry ?? 'US'), opts);
}
