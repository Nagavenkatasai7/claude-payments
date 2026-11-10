// list-hold-rescreen — Fix pack 2 T4 (R02): the automatic re-screen release of
// LIST_UNAVAILABLE holds, and the ONLY path that releases one (no person can:
// dashboard-ops.ts canReleaseHeld / releaseTransfer refuse them).
//
// A transfer is held with LIST_UNAVAILABLE when it was screened on a sanctions
// list that was not live (a real-money rail needs one) or the list could not
// load at all. Every full worker run (reconcileSweep) calls this sweep:
//   • the list's fitness is read lazily, only once a held row exists;
//   • a real-money row (live-gate.ts realMoneyRail on the RAIL partner) waits
//     while the list is not live (skipped, nothing written); while it is not
//     live the query asks for demo rows only (sandbox, or a non-http rail);
//   • each row is re-screened with the names on file (pay-rescreen.ts
//     resolveRescreenNames) and its owner's corridor rules, then
//     settlement.releaseRescreenedHold decides in ONE transaction: released
//     (paid + the rail effect), still held (a person decides), or blocked.
//   • a name screened before that the re-screen cannot screen again (a
//     Partner-API body sender name or a payment link's customerName, never
//     stored) is uncovered (evidence-read.ts uncoveredRoles): never released.
//   • fix pack 2 T6 (R06): a real-money row whose sender has an active
//     screening hold (senderScreeningHoldActive) stays held with
//     SENDER_SCREENING_REASON (a platform clear, then a person, decides).
// Reads, the list warm and decryption stay OUTSIDE the transaction. A row that
// throws is logged (id only) and costs a scan, never a slot. Never throws.
// Pack 2 review F3 (C2): time-boxed (LIST_RESCREEN_BUDGET_MS); no row starts
// once the budget is spent, and the count left is logged and returned.

import type { Db } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { readSenderScreeningFlags } from '@/db/repos/customer-repo';
import { screenTransfer, type ComplianceResult } from './compliance';
import { LIST_UNAVAILABLE_REASON, resolveCorridorRules, senderScreeningHoldActive } from './compliance-config';
import { railPartnerOf, realMoneyRail } from './live-gate';
import { logWarn } from './log';
import { pokeWorker } from './outbox';
import { createPartnerStore } from './partner-store';
import { resolveRescreenNames } from './pay-rescreen';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { sanctionsAuditEvent } from './sanctions/evidence';
import { instructGateRefuses, listScreenEvidence, uncoveredRoles } from './sanctions/evidence-read';
import { enqueueSanctionsBlockNotices } from './sanctions/notices';
import { sanctionsListFitnessNow } from './sanctions/list-health';
import type { ListFitness } from './sanctions/list-policy';
import { releaseRescreenedHold } from './settlement';
import type { Transfer } from './types';

/** Rows decided (released / still held / blocked) per sweep, and the page size. */
export const LIST_RESCREEN_BATCH = 25;
/** At most this many pages are scanned per sweep (skipped rows cost a scan). */
export const MAX_PAGES = 4;

/**
 * Pack 2 review F3 (C2): the sweep's wall-clock budget. It runs inside
 * reconcileSweep, BEFORE the worker drain, on every full run (pokes included),
 * so it never STARTS a row once this much time has passed; the rows it leaves
 * wait for the next run.
 */
export const LIST_RESCREEN_BUDGET_MS = 5_000;

export interface ListHoldSweepResult {
  released: number;
  stillHeld: number;
  blocked: number;
  /** Present only when the budget stopped the sweep: rows of the current page it did not start. */
  deferred?: number;
}

export interface ListHoldSweepOptions {
  /** Wall-clock budget (default LIST_RESCREEN_BUDGET_MS). */
  budgetMs?: number;
  /** Injectable wall clock (default Date.now); `now` stays the screening time. */
  clock?: () => number;
}

type RowOutcome = 'released' | 'still_held' | 'blocked' | 'moved' | 'skipped';

/**
 * Re-screen a HELD transfer with the names on file and its owner's corridor
 * rules (no write): the screen result, and the roles an earlier screen covered
 * that this one does not. Shared by the list-hold sweep and (review F1/A1)
 * releaseTransfer's re-screen of a real-money hold whose screen is not
 * liveFresh. Reads outside any transaction; a read error throws.
 */
export async function screenHeldOnFile(
  db: Db,
  t: Transfer,
  needLive: boolean,
  now: Date,
): Promise<{ result: ComplianceResult; uncovered: Array<'sender' | 'recipient'> }> {
  const names = await resolveRescreenNames(db, t);
  const partners = createPartnerStore(db);
  const owner = (await partners.getPartner(t.partnerId)) ?? (await partners.ensureDefaultPartner());
  const rules = resolveCorridorRules(owner, t.sourceCountry ?? 'US');
  const uncovered = uncoveredRoles(await listScreenEvidence(db, t, now), {
    senderName: names.senderName,
    recipientNames: [names.recipientName, ...names.alsoRecipientNames],
  });
  const result = await screenTransfer({
    amountUsd: t.amountUsd,
    recipientName: names.recipientName,
    senderName: names.senderName,
    // Velocity was decided at mint; amount is re-derived from the row.
    transfersToday: 0,
    sourceCountry: t.sourceCountry ?? 'US',
    rules,
    requireLiveList: needLive,
    now,
    ...(names.alsoRecipientNames.length > 0 ? { alsoRecipientNames: names.alsoRecipientNames } : {}),
  });
  return { result, uncovered };
}

async function rescreenRow(db: Db, t: Transfer, fitness: ListFitness, now: Date): Promise<RowOutcome> {
  const railIntegrations = await createIntegrationsRepo(db).getIntegrations(railPartnerOf(t));
  // The integrations were read: no providerType is the default mock rail (null).
  const needLive = realMoneyRail({ environment: t.environment, railProviderType: railIntegrations.payment.providerType ?? null });
  if (needLive && fitness !== 'live') return 'skipped';

  // Fix pack 2 T6 (R06): on a real-money rail the sender's screening hold
  // (owning tenant) keeps the row held; a read error throws and the caller
  // skips the row. No read otherwise.
  const senderHold = needLive && senderScreeningHoldActive(await readSenderScreeningFlags(db, t.partnerId, t.phone));

  const { result, uncovered } = await screenHeldOnFile(db, t, needLive, now);
  // Still no list to screen on: wait for the next sweep, nothing written.
  if (result.reasons.includes(LIST_UNAVAILABLE_REASON)) return 'skipped';
  const r = await releaseRescreenedHold(db, t.id, {
    result,
    railIntegrations,
    senderHold,
    realMoney: needLive,
    uncovered,
  });
  return r.kind;
}

export type PaidHealOutcome = 'cleared' | 'blocked' | 'review' | 'skipped';

/**
 * Pack 2 review F1 (A1): the heal of a PAID real-money row whose instruct the
 * worker gate refuses (instructGateRefuses: newest evidence with a listFitness
 * that is not liveFresh). Called by the reconcile stuck-paid sweep, only for a
 * row on a real-money rail. Re-screens with the names on file on a LIVE list:
 *   • the list is not live (or the screen still says LIST_UNAVAILABLE) ⇒
 *     'skipped', nothing written (the gate keeps refusing: fail closed);
 *   • a live, clear screen that covers every name screened before ⇒ its
 *     sanctions.screen evidence row ⇒ 'cleared' (the next instruct passes);
 *   • a match ⇒ the evidence row and the sanctions block notices (stage
 *     'resume') in ONE transaction ⇒ 'blocked' (the gate refuses a match);
 *   • anything else (a possible match, an uncovered name) ⇒ NO evidence (a
 *     fresh live row would unlock the gate on an unreviewed result) and one
 *     deduped `instructrescreen:<id>` ops alert, ids only ⇒ 'review'.
 * A newest screen that is a match, or a row already alerted, is not screened
 * again. Reads outside the transaction; a read error throws (nothing written).
 */
export async function healPaidRowScreen(db: Db, t: Transfer, now: Date): Promise<PaidHealOutcome> {
  if (t.status !== 'paid') return 'skipped';
  const newest = (await listScreenEvidence(db, t, now)).at(-1);
  if (!newest || !instructGateRefuses(newest, now) || newest.decision === 'match') return 'skipped';
  const reviewKey = `instructrescreen:${t.id}`;
  if (await createOutboxRepo(db).hasDedupeKey(reviewKey)) return 'skipped';
  if ((await sanctionsListFitnessNow(now)) !== 'live') return 'skipped';
  const { result, uncovered } = await screenHeldOnFile(db, t, true, now);
  if (result.reasons.includes(LIST_UNAVAILABLE_REASON) || !result.evidence) return 'skipped';
  const evidence = result.evidence;
  if (result.status === 'blocked') {
    await db.transaction(async (tx) => {
      await createAuditRepo(tx).record(sanctionsAuditEvent(t.partnerId, t.id, evidence));
      await enqueueSanctionsBlockNotices(tx, {
        partnerId: t.partnerId,
        railPartnerId: railPartnerOf(t),
        subjectId: t.id,
        stage: 'resume',
        environment: t.environment ?? 'live',
        realMoney: true,
        evidence,
      });
    });
    pokeWorker();
    return 'blocked';
  }
  if (evidence.decision === 'clear' && evidence.listFitness === 'live' && uncovered.length === 0) {
    await createAuditRepo(db).record(sanctionsAuditEvent(t.partnerId, t.id, evidence));
    return 'cleared';
  }
  await createOutboxRepo(db).enqueue(
    'ops.alert',
    {
      message:
        `⚠️ SmartRemit ops: transfer ${t.id} (partner ${t.partnerId}) is paid but not instructed: its re-screen on a live list did not clear ` +
        '(a possible match or a name that cannot be screened again). It stays uninstructed; review it on the compliance page and refund it.',
    },
    { dedupeKey: reviewKey },
  );
  return 'review';
}

/**
 * Never throws. Pokes the worker once when a row was released or blocked.
 * Time-boxed (opts.budgetMs): no row is started once the budget is spent.
 */
export async function sweepListUnavailableHolds(db: Db, now: Date, opts: ListHoldSweepOptions = {}): Promise<ListHoldSweepResult> {
  const out: ListHoldSweepResult = { released: 0, stillHeld: 0, blocked: 0 };
  const clock = opts.clock ?? Date.now;
  const started = clock();
  const budgetMs = opts.budgetMs ?? LIST_RESCREEN_BUDGET_MS;
  let deferred = 0;
  const repo = createTransferRepo(db);
  let fitness: ListFitness | null = null;
  let after: { paidAt: string; id: string } | undefined;
  try {
    let pages = 0;
    while (pages < MAX_PAGES) {
      const rows = await repo.listListUnavailableHolds(LIST_RESCREEN_BATCH, {
        demoOnly: fitness !== null && fitness !== 'live',
        ...(after ? { after } : {}),
      });
      if (rows.length === 0) break;
      if (fitness === null) {
        // Lazily: no held row, no list warm (one query per idle sweep).
        fitness = await sanctionsListFitnessNow(now);
        // The first page was read before the fitness was known: re-read it
        // demo-only, so real-money rows waiting on the list cost no slot.
        if (fitness !== 'live') continue;
      }
      pages++;
      for (let i = 0; i < rows.length; i++) {
        const t = rows[i];
        if (clock() - started >= budgetMs) {
          deferred = rows.length - i;
          break;
        }
        let outcome: RowOutcome;
        try {
          outcome = await rescreenRow(db, t, fitness, now);
        } catch (err) {
          logWarn('list-rescreen', err, { transferId: t.id });
          outcome = 'skipped';
        }
        if (outcome === 'released') out.released++;
        else if (outcome === 'still_held') out.stillHeld++;
        else if (outcome === 'blocked') out.blocked++;
        if (out.released + out.stillHeld + out.blocked >= LIST_RESCREEN_BATCH) break;
      }
      if (deferred > 0 || out.released + out.stillHeld + out.blocked >= LIST_RESCREEN_BATCH) break;
      if (rows.length < LIST_RESCREEN_BATCH) break;
      const last = rows[rows.length - 1];
      after = { paidAt: last.paidAt ?? last.createdAt, id: last.id };
    }
  } catch (err) {
    logWarn('list-rescreen', err);
  }
  if (deferred > 0) {
    // Counts only: the rows wait for the next full run.
    logWarn('list-rescreen', 'time budget spent; rows left for the next run', { deferred, budgetMs });
    out.deferred = deferred;
  }
  if (out.released > 0 || out.blocked > 0) pokeWorker();
  return out;
}
