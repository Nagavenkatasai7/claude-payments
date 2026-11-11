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
//    instance whatever its cache holds. A version whose stored entries do not
//    match its entry_count is 'not_live' (screens cannot load it).
//  - checkSanctionsListHealth: the ENQUEUER. Called from the daily /api/cron
//    route (which pokes the worker afterwards), even with the loader OFF. ONE
//    ops.alert per Eastern day, keyed listNotLiveDedupeKey (shared with the
//    mint's own alert, store.ts enqueueListNotLiveAlert), and only when at
//    least one partner settles on an http rail. The payload is `{ message }`
//    with counts, the version and the age only: never a name. Never throws.
//
// Fix pack 5 (R08, P27): under SANCTIONS_LIST=lists all three judge the WHOLE
// floor set (floorLists(): all four lists, no destination). The fitness is
// listSetFitness over every served member (any throw -> 'not_live'); the
// status gains `members` (one row per SANCTIONS_SOURCES entry, read from the
// DB like the SDN row, a partial version 'not_live') and its set fitness,
// while version / checkedAt / entryCount keep the OFAC SDN values; the alert
// names each source's version and age under the SAME dedupe key. Outside
// 'lists' every field, the text and the key are unchanged.

import { count, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { partnerIntegrations, sanctionsListEntries } from '@/db/schema';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createSanctionsListRepo } from '@/db/repos/sanctions-list-repo';
import { env } from '../env';
import { logError } from '../log';
import { servedListInfo, servedOfacListInfo, type SanctionsListInfo } from '../providers/sanctions-provider';
import { easternDay } from './list-loader';
import { FIT_LIST_SOURCES, listFitness, listSetFitness, sourceFitness, type ListFitness } from './list-policy';
import { floorLists, SANCTIONS_SOURCES, type SanctionsSourceId } from './list-sets';

const OFAC_SOURCE = 'ofac-sdn';
const LISTS_SETTING = 'lists';
const HOUR_MS = 3_600_000;

/** One list-not-live alert per Eastern day (cron and mint share it). */
export const listNotLiveDedupeKey = (now: Date): string => `sanctions-list-not-live:${easternDay(now.getTime())}`;

/** The fitness of the list a screen in this process would use now. Any error -> 'not_live'. */
export async function sanctionsListFitnessNow(now: Date): Promise<ListFitness> {
  if (env.sanctionsList === LISTS_SETTING) {
    try {
      const required = floorLists();
      return listSetFitness(await Promise.all(required.map((s) => servedListInfo(s))), required, now);
    } catch {
      return 'not_live';
    }
  }
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
  /** Fix pack 5 (P33): one row per source, in SANCTIONS_SOURCES order, ONLY under SANCTIONS_LIST=lists. */
  members?: Array<{
    source: SanctionsSourceId;
    version: string | null;
    checkedAt: string | null;
    entryCount: number | null;
    fitness: ListFitness;
  }>;
}

type ListMemberStatus = NonNullable<SanctionsListStatus['members']>[number];

/**
 * Fix pack 5: the per-source rows and the set fitness, from the DB (same
 * rules as the SDN row: an active version whose stored entries do not match
 * its entry_count is not_live). Sequential, one handle. A missing or partial
 * source is absent from the set, so the set reads not_live.
 */
async function listSetStatus(db: Db, now: Date): Promise<{ members: ListMemberStatus[]; fitness: ListFitness }> {
  const repo = createSanctionsListRepo(db);
  const members: ListMemberStatus[] = [];
  const infos: SanctionsListInfo[] = [];
  for (const source of SANCTIONS_SOURCES) {
    const active = await repo.activeVersion(source);
    const checkedAt = active?.checkedAt ? active.checkedAt.toISOString() : null;
    const whole = active ? (await storedEntryCount(db, active.id)) === active.entryCount : false;
    let fitness: ListFitness = 'not_live';
    if (active && whole) {
      const info: SanctionsListInfo = {
        source,
        version: active.version,
        hash: active.hash,
        ...(checkedAt ? { checkedAt } : {}),
      };
      fitness = sourceFitness(info, now);
      infos.push(info);
    }
    members.push({
      source,
      version: active?.version ?? null,
      checkedAt,
      entryCount: active?.entryCount ?? null,
      fitness,
    });
  }
  return { members, fitness: listSetFitness(infos, floorLists(), now) };
}

/** Entry rows stored for one list version (public list data; the table has no tenant). */
async function storedEntryCount(db: Db, versionId: number): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(sanctionsListEntries)
    .where(eq(sanctionsListEntries.versionId, versionId));
  return Number(rows[0]?.n ?? 0);
}

/**
 * READ-ONLY. Throws on a database error (checkSanctionsListHealth catches).
 * An active version whose stored entries do not match its entry_count is
 * 'not_live' (review R4, E5).
 */
export async function sanctionsListStatus(db: Db, now: Date): Promise<SanctionsListStatus> {
  const listSetting = env.sanctionsList || 'mock';
  const active = await createSanctionsListRepo(db).activeVersion(OFAC_SOURCE);
  const rows = await db
    .select({ n: count() })
    .from(partnerIntegrations)
    .where(eq(partnerIntegrations.paymentProviderType, 'http'));
  const httpPartners = Number(rows[0]?.n ?? 0);
  const checkedAt = active?.checkedAt ? active.checkedAt.toISOString() : null;
  // Pack 2 review R4 (E5): a version whose stored entries do not match its
  // entry_count cannot be screened on (loadList throws, screens fail closed),
  // so it is not live, however fresh its checked_at. One count query.
  const whole = listSetting === OFAC_SOURCE && active ? (await storedEntryCount(db, active.id)) === active.entryCount : false;
  const fitness: ListFitness =
    listSetting === OFAC_SOURCE && active && whole
      ? listFitness(
          { source: active.source, version: active.version, hash: active.hash, ...(checkedAt ? { checkedAt } : {}) },
          now,
        )
      : 'not_live';
  if (listSetting === LISTS_SETTING) {
    const set = await listSetStatus(db, now);
    return {
      listSetting,
      version: active?.version ?? null,
      checkedAt,
      entryCount: active?.entryCount ?? null,
      fitness: set.fitness,
      httpPartners,
      members: set.members,
    };
  }
  return {
    listSetting,
    version: active?.version ?? null,
    checkedAt,
    entryCount: active?.entryCount ?? null,
    fitness,
    httpPartners,
  };
}

const ageText = (checkedAt: string | null, now: Date): string =>
  checkedAt ? `${Math.floor((now.getTime() - Date.parse(checkedAt)) / HOUR_MS)} h ago` : 'never';

/** The daily check. Never throws: a failure is logged and nothing is enqueued. */
export async function checkSanctionsListHealth(db: Db, now: Date): Promise<{ alerted: boolean }> {
  try {
    const s = await sanctionsListStatus(db, now);
    if (s.httpPartners === 0 || s.fitness === 'live') return { alerted: false };
    const age = s.checkedAt ? `${Math.floor((now.getTime() - Date.parse(s.checkedAt)) / HOUR_MS)} h ago` : 'never';
    if (s.members) {
      // Fix pack 5: the list-set text, same dedupe key. Sources, versions and ages only.
      const each = s.members.map((m) => `${m.source} ${m.version ?? 'none'} checked ${ageText(m.checkedAt, now)}`).join(', ');
      const alerted = await createOutboxRepo(db).enqueue(
        'ops.alert',
        {
          message:
            `⚠️ SmartRemit ops: the sanctions list set is not live (${s.fitness}; setting lists; ${each}). ` +
            `${s.httpPartners} partner(s) on a real-money rail hold every new transfer until every list is live. ` +
            `Check the sanctions lists page and the loader.`,
        },
        { dedupeKey: listNotLiveDedupeKey(now) },
      );
      return { alerted };
    }
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
