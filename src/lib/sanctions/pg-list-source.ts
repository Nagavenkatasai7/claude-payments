// Program-Fix 14 PR C: the Postgres-backed sanctions list source used when
// SANCTIONS_LIST=ofac-sdn. It serves the ACTIVE version the daily loader
// (list-loader.ts) stored in sanctions_list_versions / sanctions_list_entries.
//
// Two entry points, on purpose:
//   • load() is the screen's hot path and runs INSIDE the mint transaction
//     (transfer-create.ts mintLocked). Once a version is cached it never
//     touches the database, so the mint never holds a second pool connection
//     (db/client.ts sizes the pool on that invariant). Only a cold process
//     with nothing cached queries here.
//   • warm() is the refresh. transfer-create calls it BEFORE taking the sender
//     lock; it re-checks the active pointer at most once per TTL and reloads
//     the entries only when the active version changed. It never throws.
//
// Fail closed: no active version (nothing loaded yet, or deactivated by hand)
// ⇒ load() rejects ⇒ the screener raises SanctionsListUnavailableError ⇒
// screenTransfer returns `flagged` with evidence decision 'list_unavailable'.
// A database error during a REFRESH keeps serving the last loaded version (a
// real, previously active list); a database error on a COLD load rejects.

import { logWarn } from '../log';
import type { ActiveSanctionsVersion } from '@/db/repos/sanctions-list-repo';
import type { SanctionsList, SanctionsListSource } from './list-source';

export class NoActiveSanctionsListError extends Error {
  constructor(source: string) {
    super(`no active ${source} list version is loaded`);
    this.name = 'NoActiveSanctionsListError';
  }
}

/** The two repo reads this source needs (createSanctionsListRepo satisfies it). */
export interface SanctionsListReader {
  activeVersion(source: string): Promise<ActiveSanctionsVersion | null>;
  loadList(v: ActiveSanctionsVersion): Promise<SanctionsList>;
}

/** How often warm() re-checks the active pointer. */
export const LIST_REFRESH_TTL_MS = 5 * 60_000;
/** After warm() finds no active version, load() fails closed without a query for this long. */
export const WARM_MISS_WINDOW_MS = 60_000;

export class PostgresSanctionsListSource implements SanctionsListSource {
  private cached: { list: SanctionsList; hash: string; checkedAt: number } | null = null;
  private inflight: Promise<SanctionsList | null> | null = null;
  private warmMissAt: number | null = null;
  private readonly source: string;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly reader: () => SanctionsListReader,
    opts: { source?: string; ttlMs?: number; now?: () => number } = {},
  ) {
    this.source = opts.source ?? 'ofac-sdn';
    this.ttlMs = opts.ttlMs ?? LIST_REFRESH_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Re-read the active pointer (and the entries if it moved). Single flight. */
  private refresh(): Promise<SanctionsList | null> {
    if (!this.inflight) {
      this.inflight = (async () => {
        const repo = this.reader();
        const active = await repo.activeVersion(this.source);
        if (!active) {
          this.cached = null;
          return null;
        }
        if (this.cached && this.cached.hash === active.hash) {
          this.cached.checkedAt = this.now();
          return this.cached.list;
        }
        const list = await repo.loadList(active);
        this.cached = { list, hash: active.hash, checkedAt: this.now() };
        return list;
      })().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  async load(): Promise<SanctionsList> {
    if (this.cached) return this.cached.list;
    // warm() (run just before the mint's sender lock) already found no active
    // version: fail closed at once instead of querying from inside the mint
    // transaction (which would hold a second pool connection).
    if (this.warmMissAt !== null && this.now() - this.warmMissAt < WARM_MISS_WINDOW_MS) {
      throw new NoActiveSanctionsListError(this.source);
    }
    const list = await this.refresh();
    if (!list) throw new NoActiveSanctionsListError(this.source);
    return list;
  }

  async warm(): Promise<void> {
    // A miss has no TTL: while nothing is loaded every warm() re-checks, so a
    // newly loaded list is picked up by the very next mint.
    if (this.cached && this.now() - this.cached.checkedAt < this.ttlMs) return;
    try {
      const list = await this.refresh();
      this.warmMissAt = list ? null : this.now();
    } catch (err) {
      // Keep serving the last loaded version (if any). With none, the screen
      // that follows fails closed at once (no retry from inside the mint tx).
      if (!this.cached) this.warmMissAt = this.now();
      logWarn('sanctions.list-refresh', err instanceof Error ? err.name : 'unknown', { source: this.source });
    }
  }
}
