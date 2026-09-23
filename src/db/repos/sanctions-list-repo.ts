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

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { sanctionsListEntries, sanctionsListVersions } from '@/db/schema';
import type { Db, DbOrTx } from '@/db/client';
import type { SanctionsList, SanctionsListEntry } from '@/lib/sanctions/list-source';

/** Superseded versions kept after a switch (look-back + manual rollback); older ones are pruned. */
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

export function createSanctionsListRepo(db: Db) {
  const activeOf = async (h: DbOrTx, source: string): Promise<ActiveSanctionsVersion | null> => {
    const rows = await h
      .select({
        id: sanctionsListVersions.id,
        source: sanctionsListVersions.source,
        version: sanctionsListVersions.version,
        hash: sanctionsListVersions.hash,
        entryCount: sanctionsListVersions.entryCount,
      })
      .from(sanctionsListVersions)
      .where(and(eq(sanctionsListVersions.source, source), eq(sanctionsListVersions.active, true)))
      .limit(1);
    return rows[0] ?? null;
  };

  return {
    /** The active version of a source, or null when none has been loaded. */
    async activeVersion(source: string): Promise<ActiveSanctionsVersion | null> {
      return activeOf(db, source);
    },

    /** Every entry of one version, as the screener's SanctionsList. */
    async loadList(v: ActiveSanctionsVersion): Promise<SanctionsList> {
      const rows = await db
        .select()
        .from(sanctionsListEntries)
        .where(eq(sanctionsListEntries.versionId, v.id));
      const entries: SanctionsListEntry[] = rows.map((r) => {
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
     *   • the same content as the active version → 'unchanged' (checked_at only);
     *   • content seen before (a re-publish of an older version) → re-activated;
     *   • otherwise a new version row plus its entries, then the switch.
     * A list that shrank below MIN_ENTRY_RATIO of the active one is refused
     * (SanctionsListShrinkError) and the active version stays. Any throw
     * rolls the whole store back. Superseded versions beyond
     * KEEP_INACTIVE_VERSIONS are pruned (their entries cascade).
     */
    async storeList(list: SanctionsList, opts: { minEntries?: number } = {}): Promise<StoreListResult> {
      // Duplicate ids: first wins (never fail a whole load over one repeat).
      const seen = new Set<string>();
      const entries = list.entries.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
      const nameCount = entries.reduce((n, e) => n + (e.names?.length ?? 0) + (e.weakNames?.length ?? 0), 0);

      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`sanctions-list:${list.source}`}))`);
        const now = new Date();
        const active = await activeOf(tx, list.source);

        if (active && active.hash === list.hash) {
          await tx
            .update(sanctionsListVersions)
            .set({ checkedAt: now })
            .where(eq(sanctionsListVersions.id, active.id));
          return {
            status: 'unchanged' as const,
            versionId: active.id,
            version: active.version,
            hash: active.hash,
            entryCount: active.entryCount,
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
          .select({ id: sanctionsListVersions.id })
          .from(sanctionsListVersions)
          .where(and(eq(sanctionsListVersions.source, list.source), eq(sanctionsListVersions.hash, list.hash)))
          .limit(1);

        let versionId: number;
        if (existing[0]) {
          versionId = existing[0].id;
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
          for (let i = 0; i < entries.length; i += INSERT_BATCH) {
            await tx.insert(sanctionsListEntries).values(
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

        // Prune: keep the active version plus the newest KEEP_INACTIVE_VERSIONS.
        const inactive = await tx
          .select({ id: sanctionsListVersions.id })
          .from(sanctionsListVersions)
          .where(and(eq(sanctionsListVersions.source, list.source), eq(sanctionsListVersions.active, false)))
          .orderBy(desc(sanctionsListVersions.activatedAt), desc(sanctionsListVersions.id));
        const drop = inactive.slice(KEEP_INACTIVE_VERSIONS).map((r) => r.id);
        if (drop.length > 0) {
          await tx.delete(sanctionsListVersions).where(inArray(sanctionsListVersions.id, drop));
        }

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
  };
}
