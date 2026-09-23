// Program-Fix 14 PR C: the daily OFAC SDN list loader.
//
// Runs from /api/cron (13:00 UTC and the 17:00 UTC catch-up) ONLY when
// SANCTIONS_LOADER_ENABLED is set — OFF by default, and unset in production
// until the owner flips it. Loading a list never decides WHETHER screening runs
// (it always runs); it only refreshes the list SANCTIONS_LIST=ofac-sdn reads.
//
//   fetch SDN.XML (User-Agent, timeout, size cap) → parse → storeList (one
//   transaction: new version + entries, atomic switch of the active version)
//
// FAILS SOFT: any failure (network, parse, a sharply shrunk list, the store)
// keeps the last good version active, writes an audit row, and raises ONE ops
// alert per source per Eastern day through the outbox. It never throws to the
// cron. (The SCREENER is the part that fails closed: no loaded version ⇒
// every transfer goes to review. See pg-list-source.ts.)
//
// Audit rows ('sanctions.list.load', actor 'system:sanctions') carry the
// source, version, hash, counts and status only — public list metadata, no
// names and no customer data.

import type { Db } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createSanctionsListRepo, SanctionsListShrinkError, SanctionsListStaleError } from '@/db/repos/sanctions-list-repo';
import { logError } from '../log';
import { SANCTIONS_AUDIT_ACTOR } from './evidence';
import { fetchOfacSdn } from './ofac-sdn-loader';
import type { SanctionsList } from './list-source';

export const SANCTIONS_LOAD_AUDIT_ACTION = 'sanctions.list.load';

export type LoadFailureReason = 'fetch' | 'parse' | 'shrink' | 'stale' | 'store';

/** The live SDN list has ~18,000 entries (2026); anything under this is not the whole list. */
export const OFAC_SDN_MIN_ENTRIES = 5000;

export type LoadResult =
  | { status: 'activated' | 'unchanged'; version: string; hash: string; entryCount: number; nameCount: number }
  | { status: 'failed'; reason: LoadFailureReason };

export interface LoadDeps {
  db: Db;
  fetchImpl?: typeof fetch;
  now?: number;
  /** Absolute entry floor (default OFAC_SDN_MIN_ENTRIES; tests with the 5-entry fixture lower it). */
  minEntries?: number;
  /** Test seam: replaces the outbox enqueue of the failure alert. */
  enqueueAlert?: (message: string, dedupeKey: string) => Promise<void>;
}

const SOURCE = 'ofac-sdn';

/** YYYY-MM-DD in America/New_York — the same day boundary the cron alerts use. */
function easternDay(now: number): string {
  return new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

const REASON_TEXT: Record<LoadFailureReason, string> = {
  fetch: 'the download from the Treasury Sanctions List Service failed',
  parse: 'the downloaded file did not parse as the SDN list',
  shrink: 'the downloaded list has too few entries (against the minimum or the last stored version) and was refused',
  stale: 'the downloaded list is an OLDER publication than the active one and was refused',
  store: 'saving the list to the database failed',
};

export async function runOfacSdnLoad(deps: LoadDeps): Promise<LoadResult> {
  const now = deps.now ?? Date.now();
  const audit = createAuditRepo(deps.db);
  let stage: LoadFailureReason = 'fetch';
  let result: LoadResult;
  try {
    // Fetch, then parse separately so a bad document is told apart from a
    // network failure. fetchOfacSdn parses too; parse errors surface as 'parse'.
    let list: SanctionsList;
    try {
      list = await fetchOfacSdn(deps.fetchImpl ?? fetch);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('OFAC SDN:')) stage = 'parse';
      throw err;
    }
    stage = 'store';
    const res = await createSanctionsListRepo(deps.db).storeList(list, {
      minEntries: deps.minEntries ?? OFAC_SDN_MIN_ENTRIES,
    });
    result = {
      status: res.status,
      version: res.version,
      hash: res.hash,
      entryCount: res.entryCount,
      nameCount: res.nameCount,
    };
  } catch (err) {
    const reason: LoadFailureReason =
      err instanceof SanctionsListShrinkError ? 'shrink' : err instanceof SanctionsListStaleError ? 'stale' : stage;
    logError('sanctions.list-load', err instanceof Error ? `${err.name}: ${err.message}` : 'unknown', {
      source: SOURCE,
      reason,
    });
    await recordAudit(audit, { source: SOURCE, status: 'failed', reason });
    const day = easternDay(now);
    const message =
      `⚠️ SmartRemit ops: the OFAC SDN list load failed on ${day} (${REASON_TEXT[reason]}). ` +
      `Screening keeps using the last good loaded version (if SANCTIONS_LIST=ofac-sdn and none was ever loaded, ` +
      `every transfer goes to manual review). The 17:00 UTC cron run retries automatically; check the ` +
      `'${SANCTIONS_LOAD_AUDIT_ACTION}' audit rows for the cause.`;
    const dedupeKey = `sanctions-list-load-failed:${SOURCE}:${day}`;
    try {
      if (deps.enqueueAlert) await deps.enqueueAlert(message, dedupeKey);
      else await createOutboxRepo(deps.db).enqueue('ops.alert', { message }, { dedupeKey });
    } catch (alertErr) {
      logError('sanctions.list-load-alert', alertErr instanceof Error ? alertErr.name : 'unknown', { source: SOURCE });
    }
    return { status: 'failed', reason };
  }
  // Outside the try: the list is stored; nothing after this can turn it into a failure.
  await recordAudit(audit, { source: SOURCE, ...result });
  return result;
}

async function recordAudit(audit: ReturnType<typeof createAuditRepo>, meta: Record<string, unknown>): Promise<void> {
  try {
    await audit.record({
      actor: SANCTIONS_AUDIT_ACTOR,
      actorType: 'system',
      action: SANCTIONS_LOAD_AUDIT_ACTION,
      meta,
    });
  } catch (err) {
    logError('sanctions.list-load-audit', err instanceof Error ? err.name : 'unknown', { source: SOURCE });
  }
}
