import type { Db, DbOrTx } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { DELIVERY_DELAY_MS } from '@/lib/providers/payment-provider';
import { buildStage1Message } from '@/lib/payment';
import { processingTemplate } from '@/lib/whatsapp-templates';
import type { PartnerIntegrations } from '@/lib/partner-integrations';
import type { PartnerId, Transfer } from '@/lib/types';
import { railPartnerOf, realMoneyRail } from '@/lib/live-gate';
import { enqueueSanctionsBlockNotices } from '@/lib/sanctions/notices';
import { listScreenEvidence, liveFresh } from '@/lib/sanctions/evidence-read';
import {
  LIST_UNAVAILABLE_REASON,
  POSSIBLE_MATCH_REASON,
  SENDER_IDENTITY_MISSING_REASON,
  SENDER_SCREENING_REASON,
  isRescreenOnlyHold,
  senderScreeningHoldActive,
} from '@/lib/compliance-config';
import { readSenderScreeningFlags } from '@/db/repos/customer-repo';
import type { ComplianceResult } from '@/lib/compliance';
import { sanctionsAuditEvent } from '@/lib/sanctions/evidence';

// settlement — THE transactional "money was paid" entry point (Stage 2c).
//
// One Postgres transaction commits, together:
//   • the awaiting_payment → paid status flip (atomic claim — a double submit
//     or crash-replay flips nothing and is a clean no-op),
//   • the customer's stage-1 "payment received" message (outbox, deduped;
//     the payload names the OWNING partnerId only — the worker resolves that
//     partner's WhatsApp creds at drain time, so no token is ever at rest here),
//   • the settlement effect for the partner's rail:
//       http/simulator → a SIGNED settlement.instruct row (the worker POSTs it
//                        with retries; delivery arrives via the partner's
//                        signed callback — fully webhook-driven),
//       mock          → a DELAYED mock.settle row (the sandbox 2-min lag).
//
// This closes the worst crash window the audit found: previously the customer
// could be told "payment received" while the rail was never instructed (or
// vice-versa). Now the state flip and every effect are one atomic unit, and
// each effect is dedupe-keyed so retries can never double-send.
// COMPLIANCE: only 'cleared' money reaches a rail — see beginSettlement / beginHold / settleOrHold below — and a staff RELEASE (releaseHold) is the one other path to the rail, audited, never a bare status flip.
//
// NON-CUSTODIAL: SmartRemit never holds funds — `paid` mirrors the charge the
// PARTNER captured on their rail; the instruction tells their rail to pay out.

/**
 * Program-Fix 28 (compliance-03/-08): WHO made a staff money decision, and why.
 * `actor` is the session's stable staff username (never a form field); `reason`
 * is the optional, bounded staff note (null when none was typed). Passed as an
 * OPTIONAL trailing argument: a caller without it keeps the exact pre-fix
 * semantics and writes no audit row.
 */
export interface StaffAuditCtx {
  actor: string;
  reason?: string | null;
  /** Recorded in the meta when given (the /partner actions derive it from the session). */
  actorScope?: 'platform' | 'partner';
}

/**
 * Write the ONE audit_events row for a staff transfer/refund decision, on the
 * TRANSACTION handle, after the guarded claim. If this insert throws, the whole
 * transaction (the money move and its outbox effect) rolls back: no decision
 * without its durable record (the fix-16b rule).
 */
export async function recordStaffTransferAudit(
  tx: DbOrTx,
  audit: StaffAuditCtx,
  action: string,
  transfer: Pick<Transfer, 'id' | 'partnerId'>,
  meta: Record<string, unknown>,
): Promise<void> {
  await createAuditRepo(tx).record({
    partnerId: transfer.partnerId,
    actor: audit.actor,
    actorType: 'staff',
    action,
    subjectId: transfer.id,
    meta: { ...meta, reason: audit.reason ?? null, ...(audit.actorScope ? { actorScope: audit.actorScope } : {}) },
  });
}

/**
 * Program-Fix 44 P2: the one "is this a sandbox transfer?" rule (absent ⇒ live).
 * A customer-facing outbox payload for a sandbox transfer carries
 * `sandbox: true` (inlined at each enqueue so the payload-secrets static check
 * can read it); the worker completes such a row WITHOUT sending. Live payloads
 * never carry the key, so they are byte-identical to before.
 */
export function isSandbox(t: Pick<Transfer, 'environment'>): boolean {
  return t.environment === 'test';
}

export type SettlementResult =
  | { kind: 'started'; webhookDriven: boolean }
  | { kind: 'already' } // not awaiting_payment anymore — idempotent no-op
  | { kind: 'refused'; complianceStatus: 'flagged' | 'blocked' }; // NOT cleared — never instructed

export type HoldResult =
  | { kind: 'held' } // awaiting_payment → in_review committed (+ held stage-1 row)
  | { kind: 'already' }; // not awaiting_payment anymore — idempotent no-op

/**
 * The union every settlement CALLER must handle exhaustively (switch on
 * `kind` — TypeScript refuses a missing arm). There is deliberately no arm a
 * caller can mistake for success: 'held' is a compliance hold (in_review,
 * staff release is the only way forward), 'refused' is a blocked transfer that
 * moved nothing. A caller that reaches 'refused' after charging must surface
 * it (ops alert / 4xx) — never swallow it.
 */
export type SettleOrHoldResult =
  | { kind: 'started'; webhookDriven: boolean }
  | { kind: 'held' }
  | { kind: 'already' }
  | { kind: 'refused'; complianceStatus: 'blocked' };

export type ReleaseResult =
  | { kind: 'released'; webhookDriven: boolean } // in_review → paid committed + the rail effect enqueued
  | { kind: 'already' }; // not in_review anymore — idempotent no-op, never resurrects

/**
 * The ONE rail-effect enqueue, shared by beginSettlement (cleared money) and
 * releaseHold (staff-released money) so the two can never drift: a webhook-
 * driven rail gets the signed instruction (`instruct:<id>`), the mock rail gets
 * the delayed simulated settlement (`mocksettle:<id>`) plus the deterministic
 * write-once providerRef. Both keys are forever; a replay enqueues nothing.
 *
 * Program-Fix 44 P2 — THE SANDBOX CHOKEPOINT: a 'test' transfer ALWAYS takes
 * the mock branch, whatever the rail partner's providerType says. `paid` is
 * the RETURNING row of the ledger claim (never the caller's object), so a
 * stale or hand-built live-shaped Transfer cannot route a sandbox row to a
 * real rail.
 */
async function enqueueRailEffect(
  tx: Parameters<Parameters<Db['transaction']>[0]>[0],
  paid: Transfer,
  integrations: PartnerIntegrations,
): Promise<{ webhookDriven: boolean }> {
  const providerType = integrations.payment.providerType;
  const webhookDriven =
    !isSandbox(paid) && (providerType === 'http' || providerType === 'simulator');
  const outbox = createOutboxRepo(tx);
  if (webhookDriven) {
    await outbox.enqueue('settlement.instruct', { transferId: paid.id }, { dedupeKey: `instruct:${paid.id}` });
  } else {
    await outbox.enqueue(
      'mock.settle',
      { transferId: paid.id, partnerId: paid.partnerId },
      { delayMs: DELIVERY_DELAY_MS, dedupeKey: `mocksettle:${paid.id}` },
    );
    // Parity with the old mock provider's deterministic ref (write-once).
    await createTransferRepo(tx).setProviderRef(paid.id, `mock-${paid.id}`);
  }
  return { webhookDriven };
}

/**
 * COMPLIANCE GATE: only 'cleared' money reaches a rail. The gate is the
 * ledger claim itself (markPaidIfAwaiting requires compliance_status =
 * 'cleared' in its WHERE), so a caller holding a stale Transfer object cannot
 * bypass it; when the claim returns null we re-read INSIDE the same
 * transaction to distinguish "already past awaiting_payment" (replay, no-op)
 * from "not cleared" (refused). Callers should normally go through
 * settleOrHold(); this stays exported for the reconcile sweep's cleared path
 * and for tests.
 */
export async function beginSettlement(
  db: Db,
  transfer: Transfer,
  integrations: PartnerIntegrations,
): Promise<SettlementResult> {
  return db.transaction(async (tx): Promise<SettlementResult> => {
    const repo = createTransferRepo(tx);
    const paid = await repo.markPaidIfAwaiting(transfer.id);
    if (!paid) {
      // Classify from the LEDGER, inside the same transaction. A cleared +
      // awaiting row here is unreachable (the UPDATE would have matched), so
      // it maps to the harmless no-op rather than a spurious refusal.
      const row = await repo.getTransfer(transfer.id);
      if (!row || row.status !== 'awaiting_payment' || row.complianceStatus === 'cleared') {
        return { kind: 'already' };
      }
      return { kind: 'refused', complianceStatus: row.complianceStatus };
    }

    // Brand vs rail: the customer-facing message rides the OWNING partner's
    // WhatsApp number (paid.partnerId, already in hand — no read added to this
    // transaction); the rail is decided from `integrations` below. Only the id
    // is persisted (fix 11 / F49): the worker resolves the creds at DRAIN time.
    await createOutboxRepo(tx).enqueue(
      'whatsapp.text',
      // Program-Fix 49A: essential (a settlement stage message survives STOP).
      { to: paid.phone, body: buildStage1Message(paid), partnerId: paid.partnerId, category: 'essential', ...(isSandbox(paid) ? { sandbox: true } : {}) },
      { dedupeKey: `stage1:${paid.id}` },
    );
    const { webhookDriven } = await enqueueRailEffect(tx, paid, integrations);
    return { kind: 'started', webhookDriven };
  });
}

/**
 * THE transactional compliance HOLD (Phase 1 Task 3). One Postgres
 * transaction commits, together:
 *   • the awaiting_payment → in_review status flip (atomic claim —
 *     markInReviewIfAwaiting; a replay / crash-retry flips nothing),
 *   • paid_at (the customer WAS charged; the >24h stale-review sweep keys on it),
 *   • the customer's held "payment received — under review" message as a
 *     durable outbox row (dedupe stage1:<id> — the SAME key the paid path
 *     uses, so a transfer gets exactly one stage-1 message however it got here).
 * NO rail effect is enqueued HERE: the rail is told only when staff RELEASE
 * the transfer — releaseHold below — which is itself a settlement (in_review →
 * paid + the same rail effect). A released transfer keeps complianceStatus
 * 'flagged' forever: the release is the audited compliance decision, the
 * ledger evidence is never rewritten, and NO compliance predicate may ever be
 * added to markPaidIfInReview / releaseHold.
 *
 * Replaces the pay route's old completePaymentStage1 + re-read + saveTransfer
 * + direct sendText sequence, which had an observable intermediate 'paid'
 * state and a non-durable message.
 *
 * Fix pack 2 T9 (R02): `addReasons` (non-empty) first records, in the SAME
 * transaction, compliance 'flagged' with the LEDGER's reasons plus these
 * (de-duplicated) — applyRescreenIfAwaiting, which never touches a blocked or
 * no-longer-awaiting row; such a row is 'already' and nothing is written.
 * Without it the hold never rewrites compliance (unchanged).
 */
export async function beginHold(
  db: Db,
  transfer: Transfer,
  opts: { addReasons?: string[] } = {},
): Promise<HoldResult> {
  const addReasons = opts.addReasons ?? [];
  return db.transaction(async (tx): Promise<HoldResult> => {
    const repo = createTransferRepo(tx);
    if (addReasons.length > 0) {
      // The ledger row's reasons (row-locked), never the caller's copy.
      const current = await repo.getTransferForUpdate(transfer.id, { partnerId: transfer.partnerId });
      if (!current) return { kind: 'already' };
      const reasons = [...new Set([...(current.complianceReasons ?? []), ...addReasons])];
      const flagged = await repo.applyRescreenIfAwaiting(transfer.id, transfer.partnerId, 'flagged', reasons);
      if (!flagged) return { kind: 'already' };
    }
    const held = await repo.markInReviewIfAwaiting(transfer.id);
    if (!held) return { kind: 'already' };
    // `held` is the masked RETURNING row; buildStage1Message never names the
    // destination, so no payout field can reach the outbox payload. Same shape
    // as the paid stage-1: the OWNING partnerId, never creds (fix 11 / F49).
    await createOutboxRepo(tx).enqueue(
      'whatsapp.text',
      // 2026-10-03: `template` lets the worker reach a sender outside the
      // 24-hour window; `body` stays the free-form fallback (and is all an older
      // worker build reads). R30: the template is transfer_processing, the fixed
      // hold text; until Meta approves it the worker sends `body` (132001 fallback).
      { to: held.phone, body: buildStage1Message(held, { held: true }), template: processingTemplate(held), partnerId: held.partnerId, category: 'essential', ...(isSandbox(held) ? { sandbox: true } : {}) },
      { dedupeKey: `stage1:${held.id}` },
    );
    return { kind: 'held' };
  });
}

/**
 * The ONE decision function for "money was captured (or the partner pulls
 * it) — what happens now?". Every settlement call site (pay route, B2B pay
 * route, partner-API confirm, reconcile funding-resume sweep) goes through
 * here so the compliance branching exists in exactly one place:
 *   blocked → refused (nothing moves; callers already 4xx/422 before charging)
 *   cleared → beginSettlement (and if the LEDGER disagrees — re-screened to
 *             flagged since the caller's read — fall through to the hold)
 *   flagged → beginHold
 *
 * Fix pack 2 T9 (R02), the settle-time live-list backstop: on a REAL-MONEY
 * rail (`integrations` is the rail partner's: providerType 'http', and the
 * transfer is not a sandbox one — live-gate.ts realMoneyRail), a transfer
 * whose NEWEST sanctions.screen evidence is not live and fresh
 * (evidence-read.ts liveFresh) is HELD with LIST_UNAVAILABLE added — on the
 * cleared AND the flagged branch — so a rail switched to http after a
 * mock-list screen never settles on it. The evidence is read on the root
 * handle before any transaction; a read error throws (nothing settles). A
 * blocked transfer is refused first. Not real money: unchanged, zero reads.
 * This only ever ADDS a hold: sanctions screening is never skipped.
 */
export async function settleOrHold(
  db: Db,
  transfer: Transfer,
  integrations: PartnerIntegrations,
): Promise<SettleOrHoldResult> {
  if (transfer.complianceStatus === 'blocked') {
    return { kind: 'refused', complianceStatus: 'blocked' };
  }
  // The integrations were read: no payment providerType is the default mock
  // rail (null), never a failed read (undefined would count as real money).
  const realMoney = realMoneyRail({
    environment: transfer.environment,
    railProviderType: integrations.payment.providerType ?? null,
  });
  if (realMoney) {
    const add: string[] = [];
    const now = new Date();
    const newest = (await listScreenEvidence(db, transfer, now)).at(-1);
    if (!liveFresh(newest, now)) add.push(LIST_UNAVAILABLE_REASON);
    // Fix pack 2 T6 (R06): the SENDER's screening hold (owning tenant, root
    // handle, before any transaction), on both branches: a row already flagged
    // LARGE / VELOCITY / EDD / AML gains the reason too, so the platform
    // reviewer sees it. A read error throws (nothing paid).
    if (senderScreeningHoldActive(await readSenderScreeningFlags(db, transfer.partnerId, transfer.phone))) {
      add.push(SENDER_SCREENING_REASON);
    }
    if (add.length > 0) return beginHold(db, transfer, { addReasons: add });
  }
  if (transfer.complianceStatus === 'cleared') {
    const settled = await beginSettlement(db, transfer, integrations);
    if (settled.kind !== 'refused') return settled;
    if (settled.complianceStatus === 'blocked') return { kind: 'refused', complianceStatus: 'blocked' };
    // Ledger says flagged: hold it.
  }
  return beginHold(db, transfer);
}

/**
 * THE staff RELEASE of a held transfer (Phase 1 Task 3). A release is a
 * SETTLEMENT, not a status flip: one Postgres transaction commits, together,
 *   • the in_review → paid claim (markPaidIfInReview — NO compliance predicate:
 *     the admin-gated, audited release action IS the compliance decision, and
 *     complianceStatus stays 'flagged' as evidence),
 *   • the SAME rail effect beginSettlement enqueues (instruct:<id> for a
 *     webhook-driven rail; the delayed mocksettle:<id> + mock providerRef for
 *     the mock rail) — so the partner rail is actually told to pay out (and to
 *     debit a B2B ach_pull/bank_pull buyer), exactly as for cleared money.
 * No stage-1 message here (stage1:<id> was sent by the hold). The delivered
 * message then arrives through the ordinary paid → delivered path (rail
 * callback / mock.settle handler). Null claim ⇒ 'already': never held, already
 * released, or rejected — nothing moves, nothing is enqueued.
 * Callers hand this the RAIL partner's integrations (settlementPartnerId ??
 * partnerId), the same rule as every other settlement caller.
 * M3-10 follow-up: `partnerRelease` is passed ONLY for a PARTNER-scoped
 * release; the claim then also requires, in the same UPDATE, that the row is
 * in that tenant and its sender's customer row exists there with no PEP /
 * watchlist hit (markPaidIfInReview). A refused claim is 'already': nothing
 * moves, nothing is audited or enqueued. Platform staff pass nothing.
 */
export async function releaseHold(
  db: Db,
  transfer: Transfer,
  integrations: PartnerIntegrations,
  audit?: StaffAuditCtx,
  partnerRelease?: { partnerId: PartnerId },
): Promise<ReleaseResult> {
  return db.transaction(async (tx): Promise<ReleaseResult> => {
    const paid = await createTransferRepo(tx).markPaidIfInReview(transfer.id, partnerRelease);
    if (!paid) return { kind: 'already' }; // nothing moved ⇒ nothing audited
    // Program-Fix 28: the staff decision's durable row, keyed on the OWNING
    // partner, in THIS transaction (a failed insert rolls the release back).
    if (audit) {
      await recordStaffTransferAudit(tx, audit, 'transfer.release', paid, {
        previousStatus: 'in_review',
        newStatus: paid.status,
      });
    }
    const { webhookDriven } = await enqueueRailEffect(tx, paid, integrations);
    return { kind: 'released', webhookDriven };
  });
}

export type StaffRescreenReleaseResult =
  | { kind: 'released'; webhookDriven: boolean } // in_review → paid + the rail effect, after a live, fresh, clear re-screen
  | { kind: 'held' } // the re-screen did not clear: still in_review, reasons updated (LIST_UNAVAILABLE when the list is not live)
  | { kind: 'blocked' } // a match: blocked, notices enqueued, never paid out
  | { kind: 'already' }; // not in_review anymore (or now blocked / rescreen-only): nothing written

/**
 * Pack 2 review F1 (A1): a STAFF release of a real-money hold whose newest
 * screen is not liveFresh. The caller (dashboard-ops releaseTransfer)
 * re-screened the row on file OUTSIDE this transaction (`result`, requiring a
 * live list) and worked out the uncovered roles. ONE transaction, the row
 * locked (FOR UPDATE, tenant-pinned for a partner release):
 *   1. no longer in_review, blocked, or rescreen-only ⇒ 'already', nothing written;
 *   2. the re-screen's sanctions.screen evidence row;
 *   3. a match ⇒ blocked (the screen's reasons added) + the sanctions block
 *      notices (stage 'hold_rescreen') ⇒ 'blocked';
 *   4. not a live, clear, fully covered screen, or a reason the row did not
 *      carry (LIST_UNAVAILABLE, a possible match, an uncovered name) ⇒
 *      'flagged' with them and a staff `transfer.rescreen` audit row ⇒ 'held'
 *      (with LIST_UNAVAILABLE the automatic sweep owns the row);
 *   5. otherwise the claim and rail effect releaseHold commits (the same
 *      markPaidIfInReview, with `partnerRelease`), audited as the staff
 *      transfer.release ⇒ 'released'. A refused claim ⇒ 'already' (the
 *      screen's evidence stays: it is a true record).
 * Audit meta carries ids and reason strings only, never a name.
 */
export async function releaseHoldAfterRescreen(
  db: Db,
  transferId: string,
  input: {
    result: ComplianceResult;
    uncovered: Array<'sender' | 'recipient'>;
    railIntegrations: PartnerIntegrations;
    audit: StaffAuditCtx;
    partnerRelease?: { partnerId: PartnerId };
  },
): Promise<StaffRescreenReleaseResult> {
  const { result, uncovered, audit, partnerRelease } = input;
  return db.transaction(async (tx): Promise<StaffRescreenReleaseResult> => {
    const repo = createTransferRepo(tx);
    const t = await repo.getTransferForUpdate(transferId, partnerRelease ? { partnerId: partnerRelease.partnerId } : {});
    if (!t || t.status !== 'in_review' || t.complianceStatus === 'blocked' || isRescreenOnlyHold(t)) return { kind: 'already' };
    const previousReasons = t.complianceReasons ?? [];
    if (result.evidence) await createAuditRepo(tx).record(sanctionsAuditEvent(t.partnerId, t.id, result.evidence));

    if (result.status === 'blocked') {
      const reasons = [...new Set([...previousReasons, ...result.reasons])];
      const blocked = await repo.applyListRescreenInReview(t.id, t.partnerId, { complianceStatus: 'blocked', reasons });
      if (!blocked) throw new Error('release re-screen: the locked row refused the block');
      await enqueueSanctionsBlockNotices(tx, {
        partnerId: t.partnerId,
        railPartnerId: railPartnerOf(t),
        subjectId: t.id,
        stage: 'hold_rescreen',
        environment: t.environment ?? 'live',
        realMoney: true,
        evidence: result.evidence,
      });
      return { kind: 'blocked' };
    }

    const newReasons = [
      ...new Set([
        ...previousReasons,
        ...result.reasons,
        ...(uncovered.includes('sender') ? [SENDER_IDENTITY_MISSING_REASON] : []),
        ...(uncovered.includes('recipient') ? [POSSIBLE_MATCH_REASON] : []),
      ]),
    ];
    const ev = result.evidence;
    const clear =
      ev?.decision === 'clear' &&
      ev.listFitness === 'live' &&
      liveFresh(ev, new Date()) &&
      uncovered.length === 0 &&
      newReasons.every((r) => previousReasons.includes(r));
    if (!clear) {
      const flagged = await repo.applyListRescreenInReview(t.id, t.partnerId, { complianceStatus: 'flagged', reasons: newReasons });
      if (!flagged) throw new Error('release re-screen: the locked row refused the update');
      await recordStaffTransferAudit(tx, audit, 'transfer.rescreen', t, {
        previousReasons,
        newReasons,
        decision: ev?.decision ?? null,
        uncovered: [...uncovered],
        trigger: 'release',
      });
      return { kind: 'held' };
    }

    const paid = await repo.markPaidIfInReview(t.id, partnerRelease);
    if (!paid) return { kind: 'already' };
    await recordStaffTransferAudit(tx, audit, 'transfer.release', paid, {
      previousStatus: 'in_review',
      newStatus: paid.status,
    });
    const { webhookDriven } = await enqueueRailEffect(tx, paid, input.railIntegrations);
    return { kind: 'released', webhookDriven };
  });
}

/** The actor of every automatic list re-screen decision (audit_events.actor). */
export const LIST_RESCREEN_ACTOR = 'system:list-rescreen';

export type RescreenReleaseResult = { kind: 'released' | 'still_held' | 'blocked' | 'moved' };

/**
 * Fix pack 2 T4 (R02): THE automatic release of a LIST_UNAVAILABLE hold — the
 * only path that may release one (no person can: dashboard-ops). The caller
 * (list-hold-rescreen.ts) re-screened the row OUTSIDE this transaction
 * (`result`, on a live list when `realMoney`) and worked out which names
 * screened before it could not screen again (`uncovered`). ONE transaction:
 *   1. the row, locked (FOR UPDATE). No longer in_review, blocked, or without
 *      LIST_UNAVAILABLE ⇒ 'moved', nothing written (a reject or a second
 *      sweep got there first).
 *   2. the re-screen's sanctions.screen evidence row.
 *   3. a match ⇒ compliance 'blocked' (LIST_UNAVAILABLE replaced by the
 *      screen's reasons), status stays in_review (charged: Reject cancels and
 *      refunds; markPaidIfInReview refuses blocked) + one deduped ops alert.
 *   4. any reason left — the row's other reasons, the screen's (a possible
 *      match, LARGE re-derived), a sender hold, an uncovered name ⇒ 'flagged'
 *      with them (LIST_UNAVAILABLE dropped, so the row leaves the sweep) and a
 *      `transfer.rescreen` audit row: a person decides.
 *   5. none ⇒ the same claim and rail effect a staff release commits
 *      (markPaidIfInReview + enqueueRailEffect), audited as a SYSTEM
 *      transfer.release. The reasons are not rewritten (the evidence stays).
 * Audit meta and the alert carry ids and reason strings only, never a name.
 */
export async function releaseRescreenedHold(
  db: Db,
  transferId: string,
  input: {
    result: ComplianceResult;
    railIntegrations: PartnerIntegrations;
    senderHold: boolean;
    realMoney: boolean;
    uncovered: Array<'sender' | 'recipient'>;
  },
): Promise<RescreenReleaseResult> {
  const { result, uncovered } = input;
  return db.transaction(async (tx): Promise<RescreenReleaseResult> => {
    const repo = createTransferRepo(tx);
    const t = await repo.getTransferForUpdate(transferId);
    const previousReasons = t?.complianceReasons ?? [];
    if (!t || t.status !== 'in_review' || t.complianceStatus === 'blocked' || !previousReasons.includes(LIST_UNAVAILABLE_REASON)) {
      return { kind: 'moved' };
    }
    const audit = createAuditRepo(tx);
    if (result.evidence) await audit.record(sanctionsAuditEvent(t.partnerId, t.id, result.evidence));
    const kept = previousReasons.filter((r) => r !== LIST_UNAVAILABLE_REASON);

    if (result.status === 'blocked') {
      const reasons = [...new Set([...kept, ...result.reasons])];
      const blocked = await repo.applyListRescreenInReview(t.id, t.partnerId, { complianceStatus: 'blocked', reasons });
      if (!blocked) throw new Error('list re-screen: the locked row refused the block');
      await createOutboxRepo(tx).enqueue(
        'ops.alert',
        {
          message:
            `⚠️ SmartRemit ops: transfer ${t.id} (partner ${t.partnerId}) was held because the sanctions list was not live; ` +
            'the automatic re-screen on a fresh list found a sanctions match. It is charged, blocked by the re-screen, not paid out; reject and refund it.',
        },
        { dedupeKey: `listrescreenblock:${t.id}` },
      );
      // Fix pack 2 T5 (R04): the sanctions.block audit and notices, in this
      // transaction (the sweep pokes after a block).
      await enqueueSanctionsBlockNotices(tx, {
        partnerId: t.partnerId,
        railPartnerId: railPartnerOf(t),
        subjectId: t.id,
        stage: 'hold_rescreen',
        environment: t.environment ?? 'live',
        realMoney: input.realMoney,
        evidence: result.evidence,
      });
      return { kind: 'blocked' };
    }

    const newReasons = [
      ...new Set([
        ...kept,
        ...result.reasons,
        ...(input.senderHold ? [SENDER_SCREENING_REASON] : []),
        ...(uncovered.includes('sender') ? [SENDER_IDENTITY_MISSING_REASON] : []),
        ...(uncovered.includes('recipient') ? [POSSIBLE_MATCH_REASON] : []),
      ]),
    ];
    if (newReasons.length > 0) {
      const flagged = await repo.applyListRescreenInReview(t.id, t.partnerId, { complianceStatus: 'flagged', reasons: newReasons });
      if (!flagged) throw new Error('list re-screen: the locked row refused the update');
      await audit.record({
        partnerId: t.partnerId,
        actor: LIST_RESCREEN_ACTOR,
        actorType: 'system',
        action: 'transfer.rescreen',
        subjectId: t.id,
        meta: { previousReasons, newReasons, decision: result.evidence?.decision ?? null, uncovered: [...uncovered] },
      });
      return { kind: 'still_held' };
    }

    const paid = await repo.markPaidIfInReview(t.id);
    // The row is locked and in_review, so only the funding gate (a debit not
    // succeeded) refuses the claim: roll the evidence back, the sweep logs it.
    if (!paid) throw new Error('list re-screen: the release claim was refused (funding not succeeded)');
    await audit.record({
      partnerId: paid.partnerId,
      actor: LIST_RESCREEN_ACTOR,
      actorType: 'system',
      action: 'transfer.release',
      subjectId: paid.id,
      meta: { previousStatus: 'in_review', newStatus: paid.status, trigger: 'list_rescreen' },
    });
    await enqueueRailEffect(tx, paid, input.railIntegrations);
    return { kind: 'released' };
  });
}
