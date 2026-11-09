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

import type { Db } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { readSenderScreeningFlags } from '@/db/repos/customer-repo';
import { screenTransfer } from './compliance';
import { LIST_UNAVAILABLE_REASON, resolveCorridorRules, senderScreeningHoldActive } from './compliance-config';
import { railPartnerOf, realMoneyRail } from './live-gate';
import { logWarn } from './log';
import { pokeWorker } from './outbox';
import { createPartnerStore } from './partner-store';
import { resolveRescreenNames } from './pay-rescreen';
import { listScreenEvidence, uncoveredRoles } from './sanctions/evidence-read';
import { sanctionsListFitnessNow } from './sanctions/list-health';
import type { ListFitness } from './sanctions/list-policy';
import { releaseRescreenedHold } from './settlement';
import type { Transfer } from './types';

/** Rows decided (released / still held / blocked) per sweep, and the page size. */
export const LIST_RESCREEN_BATCH = 25;
/** At most this many pages are scanned per sweep (skipped rows cost a scan). */
export const MAX_PAGES = 4;

export interface ListHoldSweepResult {
  released: number;
  stillHeld: number;
  blocked: number;
}

type RowOutcome = 'released' | 'still_held' | 'blocked' | 'moved' | 'skipped';

async function rescreenRow(db: Db, t: Transfer, fitness: ListFitness, now: Date): Promise<RowOutcome> {
  const railIntegrations = await createIntegrationsRepo(db).getIntegrations(railPartnerOf(t));
  // The integrations were read: no providerType is the default mock rail (null).
  const needLive = realMoneyRail({ environment: t.environment, railProviderType: railIntegrations.payment.providerType ?? null });
  if (needLive && fitness !== 'live') return 'skipped';

  // Fix pack 2 T6 (R06): on a real-money rail the sender's screening hold
  // (owning tenant) keeps the row held; a read error throws and the caller
  // skips the row. No read otherwise.
  const senderHold = needLive && senderScreeningHoldActive(await readSenderScreeningFlags(db, t.partnerId, t.phone));

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

/** Never throws. Pokes the worker once when a row was released or blocked. */
export async function sweepListUnavailableHolds(db: Db, now: Date): Promise<ListHoldSweepResult> {
  const out: ListHoldSweepResult = { released: 0, stillHeld: 0, blocked: 0 };
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
      for (const t of rows) {
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
      if (out.released + out.stillHeld + out.blocked >= LIST_RESCREEN_BATCH) break;
      if (rows.length < LIST_RESCREEN_BATCH) break;
      const last = rows[rows.length - 1];
      after = { paidAt: last.paidAt ?? last.createdAt, id: last.id };
    }
  } catch (err) {
    logWarn('list-rescreen', err);
  }
  if (out.released > 0 || out.blocked > 0) pokeWorker();
  return out;
}
