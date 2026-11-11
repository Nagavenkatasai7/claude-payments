// list-archive — Fix pack 2 (R07): every sanctions list version is kept, in a
// verified archive, before its entries leave the database.
//
// For each version row with no stamped archive (oldest first, at most
// MAX_ARCHIVES_PER_RUN per run):
//   1. its stored entries -> canonicalLines; the sha256 must equal the
//      version hash (a version stored from a list with a repeated uid fails
//      here: the parser hashes the repeat, storeList keeps the first only).
//      A mismatch is never archived and never pruned, and it does not hold
//      the queue: the run reads past it (review R4, H3) and raises its own
//      daily alert that a person must act. Before any re-hash, ONE grouped
//      count per pending version (review round 3, M7): a version whose
//      stored entry count differs from its entry_count is a mismatch with no
//      re-hash, so the real candidates get the run's budget. A version with
//      the right count but a wrong hash (e.g. a repeated uid) is re-hashed on
//      each run.
//   2. gzip -> putPrivateObject(archivePathOf(v)) in the PRIVATE partner-docs
//      store (no suffix, no overwrite);
//   3. ALWAYS read it back, gunzip, and require sha256 == hash. A put that
//      throws (the object already exists after a crashed run) goes straight to
//      this read-back: a verified object is the heal;
//   4. markArchived stamps path + sha256(stored bytes) on the row (only while
//      the row still has that hash and no stamp).
// Then pruneArchivedEntries deletes the ENTRIES (never the row) of archived
// inactive versions beyond KEEP_INACTIVE_VERSIONS. Re-activating a pruned
// version re-inserts its entries (storeList).
//
// SPINE EXCEPTION (documented): the Blob put is an external effect made
// OUTSIDE the outbox. It is safe because it is idempotent: the path is
// content-addressed (<source>/<version>-<hash>), the row is stamped only
// after a verified read-back, and the next run heals a crash anywhere in
// between (the stamp is missing, the put finds the object, the read-back
// verifies it). Nothing here runs inside a DB transaction.
//
// Fail soft: never throws. A failed version raises ONE ops.alert per source
// per Eastern day (a mismatch its own one); an unconfigured store raises one per day only while
// something is pending. Alert text carries counts and the source only: no
// names, entry ids, paths or store details. The cron route pokes the worker.

import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Db } from '@/db/client';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createSanctionsListRepo, type ArchiveCandidate } from '@/db/repos/sanctions-list-repo';
import { isBlobConfigured, OBJECT_TIMEOUT_MS, putPrivateObject, readPrivateObject } from '../blob';
import { logError, logWarn } from '../log';
import { easternDay } from './list-loader';
import { canonicalLines } from './ofac-sdn-loader';

export const SANCTIONS_ARCHIVE_PREFIX = 'sanctions-archive/';
export const MAX_ARCHIVES_PER_RUN = 3;
/**
 * Pack 2 review F3 (C3): the run's total wall-clock budget. A version is not
 * STARTED unless 2 x OBJECT_TIMEOUT_MS (its put and its read-back) is still
 * left, so the Blob calls end inside the budget; the rest wait for the next run.
 */
export const ARCHIVE_BUDGET_MS = 150_000;
/**
 * Pack 5 review LC2: in lists mode the cron raises one deduped alert per source
 * per Eastern day when that source's oldest unarchived version is older than
 * this many days (the per-source archive loop shares one budget, ofac-sdn first).
 */
export const ARCHIVE_LAG_ALERT_DAYS = 3;

const DEFAULT_SOURCE = 'ofac-sdn';

export interface ArchiveRunResult {
  status: 'unconfigured' | 'done';
  archived: number;
  failed: number;
  /** Entry rows deleted by the prune. */
  pruned: number;
  /** Present only when the budget stopped the run: candidates it did not start. */
  deferred?: number;
}

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** sanctions-archive/<source>/<version>-<hash>.jsonl.gz (content-addressed). */
export function archivePathOf(v: Pick<ArchiveCandidate, 'source' | 'version' | 'hash'>): string {
  return `${SANCTIONS_ARCHIVE_PREFIX}${v.source}/${v.version}-${v.hash}.jsonl.gz`;
}

/**
 * The gunzipped canonical lines of an archived version, or null when the path
 * is not an archive path, the object is missing, or it is not gzip. A store
 * transport error throws.
 */
export async function readArchivedVersion(path: string): Promise<string | null> {
  if (!path.startsWith(SANCTIONS_ARCHIVE_PREFIX)) return null;
  const stored = await readPrivateObject(path);
  if (!stored) return null;
  try {
    return gunzipSync(stored).toString('utf8');
  } catch {
    return null;
  }
}

type Outcome = 'archived' | 'mismatch' | 'unverified';

async function archiveOne(repo: ReturnType<typeof createSanctionsListRepo>, v: ArchiveCandidate, now: Date): Promise<Outcome> {
  const lines = canonicalLines(await repo.entriesOf(v.id));
  if (sha256(lines) !== v.hash) return 'mismatch';
  const path = archivePathOf(v);
  try {
    await putPrivateObject(path, gzipSync(Buffer.from(lines, 'utf8')), 'application/gzip');
  } catch (err) {
    // Already there (a crashed earlier run) or a transient failure: the read-back decides.
    logWarn('sanctions.archive-put', err instanceof Error ? err.name : 'unknown', { source: v.source, versionId: v.id });
  }
  const stored = await readPrivateObject(path);
  if (!stored) return 'unverified';
  let text: string;
  try {
    text = gunzipSync(stored).toString('utf8');
  } catch {
    return 'unverified';
  }
  if (sha256(text) !== v.hash) return 'unverified';
  await repo.markArchived(v.id, v.hash, path, sha256(stored), now);
  return 'archived';
}

async function alert(db: Db, message: string, dedupeKey: string): Promise<void> {
  try {
    await createOutboxRepo(db).enqueue('ops.alert', { message }, { dedupeKey });
  } catch (err) {
    logError('sanctions.archive-alert', err instanceof Error ? err.name : 'unknown');
  }
}

/** Archive pending versions, then prune archived entries. Never throws. */
export async function archivePending(
  db: Db,
  opts: { now?: Date; source?: string; budgetMs?: number; clock?: () => number } = {},
): Promise<ArchiveRunResult> {
  const now = opts.now ?? new Date();
  const clock = opts.clock ?? Date.now;
  const started = clock();
  const budgetMs = opts.budgetMs ?? ARCHIVE_BUDGET_MS;
  const source = opts.source ?? DEFAULT_SOURCE;
  const day = easternDay(now.getTime());
  const repo = createSanctionsListRepo(db);

  if (!isBlobConfigured()) {
    try {
      const pending = await repo.pendingArchive(source, 1);
      if (pending.length > 0) {
        await alert(
          db,
          `⚠️ SmartRemit ops: the sanctions list archive cannot run: the private partner-docs Blob store is not ` +
            `configured. ${source} list versions are kept in the database (none is pruned) until it is.`,
          // Pack 5 review LC3: a source other than ofac-sdn carries its own key, so each
          // pending source is named once a day; the ofac-sdn key is the 72ecdde one.
          source === DEFAULT_SOURCE ? `sanctions-archive-unconfigured:${day}` : `sanctions-archive-unconfigured:${source}:${day}`,
        );
      }
    } catch (err) {
      logError('sanctions.archive', err instanceof Error ? err.name : 'unknown', { source });
    }
    return { status: 'unconfigured', archived: 0, failed: 0, pruned: 0 };
  }

  const result: ArchiveRunResult = { status: 'done', archived: 0, failed: 0, pruned: 0 };
  try {
    // Pack 2 review R4 (H3): a 'mismatch' version can never archive, and a
    // person must act on it. It does not count toward MAX_ARCHIVES_PER_RUN:
    // the run reads past it (afterId), so up to that many OTHER versions are
    // still attempted. The time budget bounds the whole loop.
    //
    // Review round 3 (M7): first ONE grouped count per pending version. A
    // version whose stored entry count differs from its entry_count cannot
    // hash to its version hash: it is a mismatch WITHOUT a re-hash, read past
    // at no cost (no budget, no attempt), and counted after the real
    // candidates. A version with the right count but a wrong hash (e.g. a
    // repeated uid) is still found by the re-hash below, on every run.
    const countMismatched = new Set(await repo.pendingCountMismatches(source));
    let mismatched = 0;
    let attempted = 0;
    let afterId: number | undefined;
    scan: while (attempted < MAX_ARCHIVES_PER_RUN) {
      const candidates = await repo.pendingArchive(source, MAX_ARCHIVES_PER_RUN - attempted, afterId);
      if (candidates.length === 0) break;
      for (let i = 0; i < candidates.length; i++) {
        const v = candidates[i];
        if (countMismatched.has(v.id)) {
          afterId = v.id;
          continue;
        }
        if (budgetMs - (clock() - started) < 2 * OBJECT_TIMEOUT_MS) {
          result.deferred = candidates.slice(i).filter((c) => !countMismatched.has(c.id)).length;
          logWarn('sanctions.archive', 'time budget spent; versions left for the next run', { source, deferred: result.deferred });
          break scan;
        }
        afterId = v.id;
        let outcome: Outcome;
        try {
          outcome = await archiveOne(repo, v, now);
        } catch (err) {
          logError('sanctions.archive-version', err instanceof Error ? err.name : 'unknown', { source, versionId: v.id });
          outcome = 'unverified';
        }
        if (outcome !== 'mismatch') attempted += 1;
        if (outcome === 'archived') result.archived += 1;
        else {
          result.failed += 1;
          if (outcome === 'mismatch') mismatched += 1;
          logError('sanctions.archive-version', outcome, { source, versionId: v.id });
        }
      }
    }
    for (const id of countMismatched) {
      result.failed += 1;
      mismatched += 1;
      logError('sanctions.archive-version', 'mismatch', { source, versionId: id, check: 'entry-count' });
    }
    const unverified = result.failed - mismatched;
    if (unverified > 0) {
      await alert(
        db,
        `⚠️ SmartRemit ops: the sanctions list archive failed for ${unverified} ${source} version(s) on ${day}. ` +
          `Those versions keep their entries (nothing unarchived is pruned); the next daily cron retries. ` +
          `Check the sanctions list card on the compliance page and the logs.`,
        `sanctions-archive-failed:${source}:${day}`,
      );
    }
    if (mismatched > 0) {
      await alert(
        db,
        `⚠️ SmartRemit ops: ${mismatched} ${source} version(s) cannot be archived on ${day}: their stored entries ` +
          `do not hash to the version hash. A person must act: the next run will not repair them. ` +
          `They keep their entries (never pruned) and later versions are still archived. ` +
          `Check the sanctions list card on the compliance page and the logs.`,
        `sanctions-archive-mismatch:${source}:${day}`,
      );
    }
    result.pruned = await repo.pruneArchivedEntries(source);
  } catch (err) {
    logError('sanctions.archive', err instanceof Error ? err.name : 'unknown', { source });
  }
  return result;
}

/**
 * Pack 5 review LC2 (lists mode only, called by the cron after the archive
 * loop): ONE ops.alert per source per Eastern day when the oldest version of
 * `source` with no stamped archive is older than ARCHIVE_LAG_ALERT_DAYS. Text:
 * the source id, the age in whole days and the pending count, nothing else.
 * True when the lag is over the limit (an alert was enqueued or deduped).
 * Never throws.
 */
export async function alertArchiveLag(db: Db, source: string, now: Date = new Date()): Promise<boolean> {
  try {
    const { pending, oldestLoadedAt } = await createSanctionsListRepo(db).pendingArchiveAge(source);
    if (pending === 0 || oldestLoadedAt === null) return false;
    const ageMs = now.getTime() - oldestLoadedAt.getTime();
    if (ageMs <= ARCHIVE_LAG_ALERT_DAYS * 86_400_000) return false;
    const ageDays = Math.floor(ageMs / 86_400_000);
    const day = easternDay(now.getTime());
    await createOutboxRepo(db).enqueue(
      'ops.alert',
      {
        message:
          `⚠️ SmartRemit ops: the sanctions list archive is behind for ${source}: the oldest unarchived version is ${ageDays} day(s) old ` +
          `and ${pending} version(s) wait. They keep their entries (nothing unarchived is pruned). ` +
          `Check the sanctions lists page and the logs.`,
      },
      { dedupeKey: `sanctions-archive-lag:${source}:${day}` },
    );
    return true;
  } catch (err) {
    logError('sanctions.archive-lag', err instanceof Error ? err.name : 'unknown', { source });
    return false;
  }
}
