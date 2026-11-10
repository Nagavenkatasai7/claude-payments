// list-archive — Fix pack 2 (R07): every sanctions list version is kept, in a
// verified archive, before its entries leave the database.
//
// For each version row with no stamped archive (oldest first, at most
// MAX_ARCHIVES_PER_RUN per run):
//   1. its stored entries -> canonicalLines; the sha256 must equal the
//      version hash (a version stored from a list with a repeated uid fails
//      here: the parser hashes the repeat, storeList keeps the first only).
//      A mismatch is never archived and never pruned.
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
// per Eastern day; an unconfigured store raises one per day only while
// something is pending. Alert text carries counts and the source only: no
// names, entry ids, paths or store details. The cron route pokes the worker.

import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Db } from '@/db/client';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createSanctionsListRepo, type ArchiveCandidate } from '@/db/repos/sanctions-list-repo';
import { isBlobConfigured, putPrivateObject, readPrivateObject } from '../blob';
import { logError, logWarn } from '../log';
import { easternDay } from './list-loader';
import { canonicalLines } from './ofac-sdn-loader';

export const SANCTIONS_ARCHIVE_PREFIX = 'sanctions-archive/';
export const MAX_ARCHIVES_PER_RUN = 3;

const DEFAULT_SOURCE = 'ofac-sdn';

export interface ArchiveRunResult {
  status: 'unconfigured' | 'done';
  archived: number;
  failed: number;
  /** Entry rows deleted by the prune. */
  pruned: number;
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
export async function archivePending(db: Db, opts: { now?: Date; source?: string } = {}): Promise<ArchiveRunResult> {
  const now = opts.now ?? new Date();
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
          `sanctions-archive-unconfigured:${day}`,
        );
      }
    } catch (err) {
      logError('sanctions.archive', err instanceof Error ? err.name : 'unknown', { source });
    }
    return { status: 'unconfigured', archived: 0, failed: 0, pruned: 0 };
  }

  const result: ArchiveRunResult = { status: 'done', archived: 0, failed: 0, pruned: 0 };
  try {
    const candidates = await repo.pendingArchive(source, MAX_ARCHIVES_PER_RUN);
    let mismatched = 0;
    for (const v of candidates) {
      let outcome: Outcome;
      try {
        outcome = await archiveOne(repo, v, now);
      } catch (err) {
        logError('sanctions.archive-version', err instanceof Error ? err.name : 'unknown', { source, versionId: v.id });
        outcome = 'unverified';
      }
      if (outcome === 'archived') result.archived += 1;
      else {
        result.failed += 1;
        if (outcome === 'mismatch') mismatched += 1;
        logError('sanctions.archive-version', outcome, { source, versionId: v.id });
      }
    }
    if (result.failed > 0) {
      await alert(
        db,
        `⚠️ SmartRemit ops: the sanctions list archive failed for ${result.failed} ${source} version(s) on ${day}` +
          (mismatched > 0 ? ` (${mismatched} whose stored entries do not hash to the version hash)` : '') +
          `. Those versions keep their entries (nothing unarchived is pruned); the next daily cron retries. ` +
          `Check the sanctions list card on the compliance page and the logs.`,
        `sanctions-archive-failed:${source}:${day}`,
      );
    }
    result.pruned = await repo.pruneArchivedEntries(source);
  } catch (err) {
    logError('sanctions.archive', err instanceof Error ? err.name : 'unknown', { source });
  }
  return result;
}
