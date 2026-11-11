// Program-Fix 14 PR C: the Postgres-backed sanctions lists (migration 0023).
//
// A list version is one DISTINCT published list (source + content hash). The
// daily loader stores a new version and switches the active pointer in ONE
// transaction, so a screen sees either the old list or the new one, never a
// half-loaded one; the partial unique index sanctions_list_versions_one_active
// makes a second active version impossible at the database level. The last
// good version stays active whenever a load fails or is refused.
//
// Public-domain list data only: no customer data is read or written here.

import { and, asc, count, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { sanctionsListEntries, sanctionsListVersions } from '@/db/schema';
import type { Db, DbOrTx } from '@/db/client';
import type { SanctionsList, SanctionsListEntry } from '@/lib/sanctions/list-source';

/**
 * Superseded (inactive) versions whose ENTRIES stay after a switch (look-back +
 * manual rollback). Fix pack 2 (R07): version ROWS are never deleted; an older
 * inactive version loses its entries only once its verified Blob archive is
 * stamped (pruneArchivedEntries, run by list-archive.ts).
 */
export const KEEP_INACTIVE_VERSIONS = 2;
/** A new list with fewer than this share of the active list's entries is refused (truncated/garbled download). */
export const MIN_ENTRY_RATIO = 0.8;
/** Entries per INSERT statement (bounded parameter count). */
const INSERT_BATCH = 500;

export class SanctionsListShrinkError extends Error {
  constructor(readonly previous: number, readonly next: number) {
    super(`sanctions list refused: ${next} entries against ${previous} active`);
    this.name = 'SanctionsListShrinkError';
  }
}

export class SanctionsListStaleError extends Error {
  constructor(readonly active: string, readonly next: string) {
    super(`sanctions list refused: publication ${next} is older than the active ${active}`);
    this.name = 'SanctionsListStaleError';
  }
}

export interface ActiveSanctionsVersion {
  id: number;
  source: string;
  version: string;
  hash: string;
  entryCount: number;
  /**
   * Fix pack 2 (R02): when the loader last confirmed this version current
   * (checked_at; an unchanged load advances it). Optional so hand-built test
   * fakes compile; the repo always sets it.
   */
  checkedAt?: Date;
}

/** A version row whose Blob archive is not stamped yet (archived_at IS NULL). */
export interface ArchiveCandidate {
  id: number;
  source: string;
  version: string;
  hash: string;
  entryCount: number;
}

export interface ArchiveSummary {
  /** Version rows of the source (never deleted). */
  versions: number;
  /** Rows with a verified archive (archived_at set). */
  archived: number;
  /** Rows still waiting for one. */
  pending: number;
  /** Rows that still hold entries. */
  withEntries: number;
}

export type StoreListStatus = 'activated' | 'unchanged';

export interface StoreListResult {
  status: StoreListStatus;
  versionId: number;
  version: string;
  hash: string;
  entryCount: number;
  nameCount: number;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

const lockSource = (h: DbOrTx, source: string) =>
  h.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`sanctions-list:${source}`}))`);

const insertEntryRows = async (h: DbOrTx, versionId: number, entries: SanctionsListEntry[]): Promise<void> => {
  for (let i = 0; i < entries.length; i += INSERT_BATCH) {
    await h.insert(sanctionsListEntries).values(
      entries.slice(i, i + INSERT_BATCH).map((e) => ({
        versionId,
        entryId: e.id,
        type: e.type,
        programs: e.programs,
        names: e.names,
        weakNames: e.weakNames ?? [],
      })),
    );
  }
};

export function createSanctionsListRepo(db: Db) {
  const activeOf = async (h: DbOrTx, source: string): Promise<ActiveSanctionsVersion | null> => {
    const rows = await h
      .select({
        id: sanctionsListVersions.id,
        source: sanctionsListVersions.source,
        version: sanctionsListVersions.version,
        hash: sanctionsListVersions.hash,
        entryCount: sanctionsListVersions.entryCount,
        checkedAt: sanctionsListVersions.checkedAt,
      })
      .from(sanctionsListVersions)
      .where(and(eq(sanctionsListVersions.source, source), eq(sanctionsListVersions.active, true)))
      .limit(1);
    return rows[0] ?? null;
  };

  const entriesOf = async (versionId: number): Promise<SanctionsListEntry[]> => {
    const rows = await db
      .select()
      .from(sanctionsListEntries)
      .where(eq(sanctionsListEntries.versionId, versionId));
    return rows.map((r) => {
      const e: SanctionsListEntry = {
        id: r.entryId,
        names: strings(r.names),
        type: r.type,
        programs: strings(r.programs),
      };
      const weak = strings(r.weakNames);
      if (weak.length > 0) e.weakNames = weak;
      return e;
    });
  };

  return {
    /** The active version of a source, or null when none has been loaded. */
    async activeVersion(source: string): Promise<ActiveSanctionsVersion | null> {
      return activeOf(db, source);
    },

    /** Every entry of one version, as the screener's SanctionsList. */
    async loadList(v: ActiveSanctionsVersion): Promise<SanctionsList> {
      const entries = await entriesOf(v.id);
      // Defence in depth: the store is atomic, but never screen a partial version.
      if (entries.length !== v.entryCount) {
        throw new Error(`sanctions list version ${v.id}: ${entries.length} entries stored, ${v.entryCount} expected`);
      }
      return { source: v.source, version: v.version, hash: v.hash, entries };
    },

    /**
     * Store a parsed list and make it the active version, all in ONE
     * transaction under a per-source advisory lock (the 13:00 and 17:00 cron
     * runs, or a manual re-run, can never interleave):
     *   • the same content as the active version → 'unchanged' (checked_at,
     *     plus a re-insert of the entries when the stored count differs);
     *   • content seen before (a re-publish of an older version) → re-activated;
     *   • otherwise a new version row plus its entries, then the switch.
     * A list that shrank below MIN_ENTRY_RATIO of the active one is refused
     * (SanctionsListShrinkError) and the active version stays. Any throw
     * rolls the whole store back. Fix pack 2 (R07): storeList deletes no
     * version row; a re-activated version whose entries were pruned after
     * its archive gets them re-inserted (same content, same hash).
     * pruneArchivedEntries is the only entry delete.
     */
    async storeList(list: SanctionsList, opts: { minEntries?: number } = {}): Promise<StoreListResult> {
      // Duplicate ids: first wins (never fail a whole load over one repeat).
      const seen = new Set<string>();
      const entries = list.entries.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
      const nameCount = entries.reduce((n, e) => n + (e.names?.length ?? 0) + (e.weakNames?.length ?? 0), 0);

      return db.transaction(async (tx) => {
        await lockSource(tx, list.source);
        const now = new Date();
        const active = await activeOf(tx, list.source);

        if (active && active.hash === list.hash) {
          // Pack 2 review R4 (E5): an active version can have lost its entries
          // (an older build re-activated a pruned row, docs/ROLLBACK.md). Same
          // hash = same content: re-insert the parsed entries when the stored
          // count differs, so loadList's count check passes again.
          const stored = await tx
            .select({ n: count() })
            .from(sanctionsListEntries)
            .where(eq(sanctionsListEntries.versionId, active.id));
          const repair = Number(stored[0]?.n ?? 0) !== entries.length || active.entryCount !== entries.length;
          if (repair) {
            await tx.delete(sanctionsListEntries).where(eq(sanctionsListEntries.versionId, active.id));
            await insertEntryRows(tx, active.id, entries);
          }
          await tx
            .update(sanctionsListVersions)
            .set(repair ? { checkedAt: now, entryCount: entries.length, nameCount } : { checkedAt: now })
            .where(eq(sanctionsListVersions.id, active.id));
          return {
            status: 'unchanged' as const,
            versionId: active.id,
            version: active.version,
            hash: active.hash,
            entryCount: repair ? entries.length : active.entryCount,
            nameCount,
          };
        }

        // The list only moves FORWARD: an older publication (a replayed or
        // stale export) would silently drop designations added since.
        // YYYY-MM-DD compares as a string. A manual rollback is an operator
        // step, never something the cron can do.
        if (active && list.version < active.version) {
          throw new SanctionsListStaleError(active.version, list.version);
        }
        // Integrity floors, applied even with no active version (first load,
        // or after a manual deactivation): an absolute minimum, and the ratio
        // against the NEWEST stored version whatever its active flag.
        if (entries.length < (opts.minEntries ?? 1)) {
          throw new SanctionsListShrinkError(opts.minEntries ?? 1, entries.length);
        }
        const newest = await tx
          .select({ entryCount: sanctionsListVersions.entryCount })
          .from(sanctionsListVersions)
          .where(eq(sanctionsListVersions.source, list.source))
          .orderBy(desc(sanctionsListVersions.id))
          .limit(1);
        const reference = Math.max(active?.entryCount ?? 0, newest[0]?.entryCount ?? 0);
        if (entries.length < reference * MIN_ENTRY_RATIO) {
          throw new SanctionsListShrinkError(reference, entries.length);
        }

        const existing = await tx
          .select({ id: sanctionsListVersions.id, entryCount: sanctionsListVersions.entryCount })
          .from(sanctionsListVersions)
          .where(and(eq(sanctionsListVersions.source, list.source), eq(sanctionsListVersions.hash, list.hash)))
          .limit(1);

        let versionId: number;
        if (existing[0]) {
          versionId = existing[0].id;
          // Fix pack 2 (R07): its entries may have been pruned after the
          // archive. Re-insert the incoming entries (same hash = same
          // content) so loadList's count check passes.
          const stored = await tx
            .select({ n: count() })
            .from(sanctionsListEntries)
            .where(eq(sanctionsListEntries.versionId, versionId));
          if (Number(stored[0]?.n ?? 0) !== existing[0].entryCount) {
            await tx.delete(sanctionsListEntries).where(eq(sanctionsListEntries.versionId, versionId));
            await insertEntryRows(tx, versionId, entries);
          }
        } else {
          const inserted = await tx
            .insert(sanctionsListVersions)
            .values({
              source: list.source,
              version: list.version,
              hash: list.hash,
              entryCount: entries.length,
              nameCount,
              active: false,
              loadedAt: now,
              checkedAt: now,
            })
            .returning({ id: sanctionsListVersions.id });
          versionId = inserted[0].id;
          await insertEntryRows(tx, versionId, entries);
        }

        // The switch: deactivate first (the partial unique index allows only
        // one active row per source), then activate — same transaction.
        if (active) {
          await tx
            .update(sanctionsListVersions)
            .set({ active: false })
            .where(eq(sanctionsListVersions.id, active.id));
        }
        await tx
          .update(sanctionsListVersions)
          .set({ active: true, activatedAt: now, checkedAt: now })
          .where(eq(sanctionsListVersions.id, versionId));

        return {
          status: 'activated' as const,
          versionId,
          version: list.version,
          hash: list.hash,
          entryCount: entries.length,
          nameCount,
        };
      });
    },

    /**
     * Fix pack 5 (R08, P28): "confirm still current" for a curated list (India
     * MHA). Re-stamps checked_at of the ACTIVE version of `source` only, under
     * the same per-source advisory lock as storeList; version, hash and entries
     * are untouched. Returns the confirmed { version, hash }, or null when the
     * source has no active version (nothing written).
     */
    async touchActiveCheckedAt(source: string, now: Date): Promise<{ version: string; hash: string } | null> {
      return db.transaction(async (tx) => {
        await lockSource(tx, source);
        const rows = await tx
          .update(sanctionsListVersions)
          .set({ checkedAt: now })
          .where(and(eq(sanctionsListVersions.source, source), eq(sanctionsListVersions.active, true)))
          .returning({ version: sanctionsListVersions.version, hash: sanctionsListVersions.hash });
        return rows[0] ?? null;
      });
    },

    // ---- Fix pack 2 (R07): the verified Blob archive (src/lib/sanctions/list-archive.ts) ----

    /**
     * Versions of a source with no stamped archive, oldest first. Active ones
     * included. `afterId` (review R4, H3) reads past ids the caller already
     * tried this run, so one that can never archive does not hold the queue.
     */
    async pendingArchive(source: string, limit: number, afterId?: number): Promise<ArchiveCandidate[]> {
      return db
        .select({
          id: sanctionsListVersions.id,
          source: sanctionsListVersions.source,
          version: sanctionsListVersions.version,
          hash: sanctionsListVersions.hash,
          entryCount: sanctionsListVersions.entryCount,
        })
        .from(sanctionsListVersions)
        .where(
          and(
            eq(sanctionsListVersions.source, source),
            isNull(sanctionsListVersions.archivedAt),
            afterId === undefined ? undefined : gt(sanctionsListVersions.id, afterId),
          ),
        )
        .orderBy(asc(sanctionsListVersions.id))
        .limit(limit);
    },

    /**
     * Review round 3 (M7): ONE grouped count of the stored entries of every
     * version of a source with no stamped archive, compared with its
     * entry_count. Returns the ids (oldest first) whose stored count differs:
     * their entries can never hash to the version hash, so the archive skips
     * them without a re-hash. A version created after this read is not listed.
     */
    async pendingCountMismatches(source: string): Promise<number[]> {
      const rows = await db
        .select({ id: sanctionsListVersions.id })
        .from(sanctionsListVersions)
        .leftJoin(sanctionsListEntries, eq(sanctionsListEntries.versionId, sanctionsListVersions.id))
        .where(and(eq(sanctionsListVersions.source, source), isNull(sanctionsListVersions.archivedAt)))
        .groupBy(sanctionsListVersions.id, sanctionsListVersions.entryCount)
        .having(sql`count(${sanctionsListEntries.entryId}) <> ${sanctionsListVersions.entryCount}`)
        .orderBy(asc(sanctionsListVersions.id));
      return rows.map((r) => Number(r.id));
    },

    /** The stored entries of one version (no count check: the archive re-hashes them). */
    entriesOf,

    /**
     * Stamp a verified archive. Only while the row still has THIS hash and no
     * stamp: true when this call stamped it, false otherwise (never twice).
     */
    async markArchived(id: number, hash: string, path: string, sha256: string, at: Date): Promise<boolean> {
      const rows = await db
        .update(sanctionsListVersions)
        .set({ archivePath: path, archiveSha256: sha256, archivedAt: at })
        .where(
          and(
            eq(sanctionsListVersions.id, id),
            eq(sanctionsListVersions.hash, hash),
            isNull(sanctionsListVersions.archivedAt),
          ),
        )
        .returning({ id: sanctionsListVersions.id });
      return rows.length > 0;
    },

    /**
     * Delete the ENTRIES (never the row) of every inactive version ranked
     * beyond the newest KEEP_INACTIVE_VERSIONS (activated_at desc, id desc)
     * that has a stamped archive. Own transaction under the source's
     * advisory lock, so a concurrent storeList (which may re-activate one of
     * them) never interleaves; `active = false` is re-checked under the lock.
     * Returns the number of entry rows deleted.
     */
    async pruneArchivedEntries(source: string): Promise<number> {
      return db.transaction(async (tx) => {
        await lockSource(tx, source);
        const inactive = await tx
          .select({ id: sanctionsListVersions.id, archivedAt: sanctionsListVersions.archivedAt })
          .from(sanctionsListVersions)
          .where(and(eq(sanctionsListVersions.source, source), eq(sanctionsListVersions.active, false)))
          .orderBy(desc(sanctionsListVersions.activatedAt), desc(sanctionsListVersions.id));
        const drop = inactive
          .slice(KEEP_INACTIVE_VERSIONS)
          .filter((r) => r.archivedAt !== null)
          .map((r) => r.id);
        if (drop.length === 0) return 0;
        const n = await tx
          .select({ n: count() })
          .from(sanctionsListEntries)
          .where(inArray(sanctionsListEntries.versionId, drop));
        const total = Number(n[0]?.n ?? 0);
        if (total === 0) return 0;
        await tx.delete(sanctionsListEntries).where(inArray(sanctionsListEntries.versionId, drop));
        return total;
      });
    },

    /** Counts for the compliance page card. */
    async archiveSummary(source: string): Promise<ArchiveSummary> {
      // One row per version (a handful); EXISTS uses the (version_id, entry_id) PK.
      const rows = await db
        .select({
          versions: count(),
          archived: count(sanctionsListVersions.archivedAt),
          withEntries: sql<number>`count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ${sanctionsListEntries} WHERE ${sanctionsListEntries.versionId} = ${sanctionsListVersions.id}))`,
        })
        .from(sanctionsListVersions)
        .where(eq(sanctionsListVersions.source, source));
      const versions = Number(rows[0]?.versions ?? 0);
      const archived = Number(rows[0]?.archived ?? 0);
      return { versions, archived, pending: versions - archived, withEntries: Number(rows[0]?.withEntries ?? 0) };
    },
  };
}
