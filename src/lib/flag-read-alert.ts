import type { DbOrTx } from '@/db/client';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import type { FlagKey } from './flags';
import { logWarn } from './log';
import { pokeWorker } from './outbox';

// flag-read-alert (fix pack 3 T7, contract 10): a failed switch-table read
// (flags.ts readFlag, so every isFlagOn too) raises ONE ops alert per key and
// hour, `flagread:<key>:<YYYY-MM-DDTHH>`. Best effort: a Neon outage that broke
// the flag read usually breaks this enqueue too (follow-up: a Redis marker).
// Never throws. Imports only the FlagKey TYPE from flags.ts (flags.ts imports
// this file at runtime; no cycle).

// One try per key per hour per instance, set BEFORE the enqueue, so a failing
// table does not turn every read into an outbox write. The outbox dedupe key
// holds the line across instances.
const tried = new Map<FlagKey, string>();

/** Test-only: forget which keys this instance already tried this hour. */
export function resetFlagReadAlertMemoForTests(): void {
  tried.clear();
}

export async function noteFlagReadFailure(db: DbOrTx, key: FlagKey, now: number): Promise<void> {
  try {
    const hour = new Date(now).toISOString().slice(0, 13);
    if (tried.get(key) === hour) return;
    tried.set(key, hour);
    await createOutboxRepo(db).enqueue(
      'ops.alert',
      {
        message: `SmartRemit ops: the switch table could not be read (${key}). It reads as off; settlement on real-money rails waits.`,
      },
      { dedupeKey: `flagread:${key}:${hour}` },
    );
    pokeWorker(); // marks the alert due (the cron's Neon gate skips unmarked work)
  } catch (err) {
    logWarn('flags.read-alert', 'flagread alert enqueue failed', { key, error: err instanceof Error ? err.name : 'error' });
  }
}
