// list-health — Fix pack 2 (R02): is the sanctions list live, and does it matter?
//
// A real-money transfer (live-gate.ts) clears only on a LIVE list
// (list-policy.ts: the OFAC SDN list, confirmed current within 36 h). When the
// list is not live every such mint is held, so ops must hear about it:
//
//  - sanctionsListFitnessNow: the fitness of the list a screen would use right
//    now (the in-process OFAC source, refreshed first). Any error is 'not_live'.
//  - sanctionsListStatus: READ-ONLY, for the compliance page and the health
//    check. The fitness comes from the setting (env.sanctionsList) plus the DB
//    checked_at of the active 'ofac-sdn' version, so it is the same on every
//    instance whatever its cache holds.
//  - checkSanctionsListHealth: the ENQUEUER. Called from the daily /api/cron
//    route (which pokes the worker afterwards), even with the loader OFF. ONE
//    ops.alert per Eastern day, keyed listNotLiveDedupeKey (shared with the
//    mint's own alert, store.ts enqueueListNotLiveAlert), and only when at
//    least one partner settles on an http rail. The payload is `{ message }`
//    with counts, the version and the age only: never a name. Never throws.

import { count, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { partnerIntegrations } from '@/db/schema';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createSanctionsListRepo } from '@/db/repos/sanctions-list-repo';
import { env } from '../env';
import { logError } from '../log';
import { servedOfacListInfo } from '../providers/sanctions-provider';
import { easternDay } from './list-loader';
import { FIT_LIST_SOURCES, listFitness, type ListFitness } from './list-policy';

const OFAC_SOURCE = 'ofac-sdn';
const HOUR_MS = 3_600_000;

/** One list-not-live alert per Eastern day (cron and mint share it). */
export const listNotLiveDedupeKey = (now: Date): string => `sanctions-list-not-live:${easternDay(now.getTime())}`;

/** The fitness of the list a screen in this process would use now. Any error -> 'not_live'. */
export async function sanctionsListFitnessNow(now: Date): Promise<ListFitness> {
  if (!FIT_LIST_SOURCES.includes(env.sanctionsList)) return 'not_live';
  try {
    return listFitness(await servedOfacListInfo(), now);
  } catch {
    return 'not_live';
  }
}

export interface SanctionsListStatus {
  /** The SANCTIONS_LIST setting ('mock' when unset). */
  listSetting: string;
  /** The active OFAC SDN version (its publication date), or null when none is loaded. */
  version: string | null;
  /** When the loader last confirmed it current (ISO), or null. */
  checkedAt: string | null;
  entryCount: number | null;
  fitness: ListFitness;
  /** Partners whose payment rail is `http` (real money). */
  httpPartners: number;
}

/** READ-ONLY. Throws on a database error (checkSanctionsListHealth catches). */
export async function sanctionsListStatus(db: Db, now: Date): Promise<SanctionsListStatus> {
  const listSetting = env.sanctionsList || 'mock';
  const active = await createSanctionsListRepo(db).activeVersion(OFAC_SOURCE);
  const rows = await db
    .select({ n: count() })
    .from(partnerIntegrations)
    .where(eq(partnerIntegrations.paymentProviderType, 'http'));
  const httpPartners = Number(rows[0]?.n ?? 0);
  const checkedAt = active?.checkedAt ? active.checkedAt.toISOString() : null;
  const fitness: ListFitness =
    listSetting === OFAC_SOURCE && active
      ? listFitness(
          { source: active.source, version: active.version, hash: active.hash, ...(checkedAt ? { checkedAt } : {}) },
          now,
        )
      : 'not_live';
  return {
    listSetting,
    version: active?.version ?? null,
    checkedAt,
    entryCount: active?.entryCount ?? null,
    fitness,
    httpPartners,
  };
}

/** The daily check. Never throws: a failure is logged and nothing is enqueued. */
export async function checkSanctionsListHealth(db: Db, now: Date): Promise<{ alerted: boolean }> {
  try {
    const s = await sanctionsListStatus(db, now);
    if (s.httpPartners === 0 || s.fitness === 'live') return { alerted: false };
    const age = s.checkedAt ? `${Math.floor((now.getTime() - Date.parse(s.checkedAt)) / HOUR_MS)} h ago` : 'never';
    const alerted = await createOutboxRepo(db).enqueue(
      'ops.alert',
      {
        message:
          `⚠️ SmartRemit ops: the sanctions list is not live (${s.fitness}; setting ${s.listSetting}; ` +
          `OFAC SDN version ${s.version ?? 'none'}, last checked ${age}). ` +
          `${s.httpPartners} partner(s) on a real-money rail hold every new transfer until it is. ` +
          `Check the sanctions list card on the compliance page and the loader.`,
      },
      { dedupeKey: listNotLiveDedupeKey(now) },
    );
    return { alerted };
  } catch (err) {
    logError('sanctions.list_health', err);
    return { alerted: false };
  }
}
