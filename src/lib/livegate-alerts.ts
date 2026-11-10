// livegate-alerts — Fix pack 3: the ops alerts the live certification gate
// raises for a paid row it refuses. Ids and the refusal code only (never a
// phone, name, amount, destination or secret).
//
//   • livegate:<id> — the settlement.instruct handler (outbox-worker.ts) deferred
//     the instruct uncharged. While that instruct row is live the worker owns
//     the row, and the stuck-paid sweeps stay quiet.
//   • livegate:stuck:<id> — pack 3 review I1: a stuck paid row the gate refuses
//     that has NO live instruction (its instruct already finished, e.g. the rail
//     became an uncertified http rail after it). Neither sweep re-instructs it
//     (real money never moves for an uncertified partner) and the worker never
//     runs again for it, so reconcileSweep and escalateStuckPaid raise this one
//     alert instead. Its own key, so an older livegate:<id> for the same
//     transfer cannot swallow it; ops.alert dedupe keys are unique for ever.

import type { DbOrTx } from '@/db/client';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import type { LiveRefusalCode } from './live-gate';
import type { PartnerId } from './types';

/** The worker's livegate:<id> alert text (wording pinned by tests/instruct-live-gate.test.ts). */
export function instructLivegateMessage(transferId: string, railPartnerId: PartnerId): string {
  return (
    `transfer ${transferId} (rail ${railPartnerId}) is paid but was not instructed: the rail partner is not certified for live money. ` +
    'It waits; certify the partner or cancel and refund it.'
  );
}

export function stuckLivegateDedupeKey(transferId: string): string {
  return `livegate:stuck:${transferId}`;
}

export function stuckLivegateMessage(transferId: string, code: LiveRefusalCode): string {
  // One literal, so the spec's quoted text (sanctions-spec-truth) is found in src as written.
  return `transfer ${transferId} is paid with no delivery confirmation and no instruction waiting, and the live gate refuses it (${code}), so it is not re-instructed. Check with the rail partner whether it received an earlier instruction, then certify the rail partner (the stuck-paid sweep then re-instructs it once) or cancel and refund it.`;
}

/**
 * Pack 3 review I1: called by both stuck-paid sweeps after liveRefusalFor
 * refused the row. Raises ONE livegate:stuck:<id> alert when no
 * settlement.instruct row for the transfer is live; a row the worker still
 * holds stays quiet. A failed read throws, as every other read in the sweeps
 * does. Returns true when a fresh alert was queued.
 */
export async function alertStuckLivegate(db: DbOrTx, transferId: string, code: LiveRefusalCode): Promise<boolean> {
  const outbox = createOutboxRepo(db);
  if (await outbox.hasLiveInstruction(transferId)) return false;
  return outbox.enqueue(
    'ops.alert',
    { message: stuckLivegateMessage(transferId, code) },
    { dedupeKey: stuckLivegateDedupeKey(transferId) },
  );
}
