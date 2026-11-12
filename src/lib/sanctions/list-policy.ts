// list-policy — Fix pack 2 (R02): which sanctions list a real-money screen may
// rely on. Pure: no I/O, no clock of its own (the caller passes `now`).
//
// A list is 'live' only when it is the real OFAC SDN list, a loaded version
// with a content hash, and confirmed current within SANCTIONS_LIST_MAX_AGE_MS
// (the daily load plus a missed day). 'stale' is the right list grown old (or
// of unknown age); 'not_live' is a list that can never clear real money (the
// mock watchlist, an unloaded or unavailable list).
// Fix pack 5 (R08): under SANCTIONS_LIST=lists a screen is live only when every
// floor list is live (listSetFitness below); the single-list rule above is unchanged.

import type { SanctionsListInfo } from '../providers/sanctions-provider';
import { isSanctionsSourceId, type SanctionsSourceId } from './list-sets';

/** A list confirmed current within this window is live (36 h exactly is live). */
export const SANCTIONS_LIST_MAX_AGE_MS = 36 * 3_600_000;
/** A checkedAt this far ahead of `now` is tolerated as clock skew; further is stale. */
export const LIST_CLOCK_SKEW_MS = 5 * 60_000;
/** The only list sources that can clear a real-money transfer. */
export const FIT_LIST_SOURCES: readonly string[] = Object.freeze(['ofac-sdn']);

export type ListFitness = 'live' | 'stale' | 'not_live';

const NOT_LOADED_VERSIONS: readonly string[] = Object.freeze(['unavailable', 'unloaded']);

export function listFitness(info: SanctionsListInfo, now: Date): ListFitness {
  if (!FIT_LIST_SOURCES.includes(info.source)) return 'not_live';
  if (NOT_LOADED_VERSIONS.includes(info.version)) return 'not_live';
  if (info.hash === '') return 'not_live';

  if (typeof info.checkedAt !== 'string' || info.checkedAt === '') return 'stale';
  const checked = Date.parse(info.checkedAt);
  if (!Number.isFinite(checked)) return 'stale';
  const nowMs = now.getTime();
  if (checked > nowMs + LIST_CLOCK_SKEW_MS) return 'stale';
  if (nowMs - checked > SANCTIONS_LIST_MAX_AGE_MS) return 'stale';
  return 'live';
}

// ── Fix pack 5 (R08, P24): per-source freshness and the set rule ──────────
// Under SANCTIONS_LIST=lists a screen is live only when every floor list
// (list-sets.ts) is live; the single-list rule above is unchanged.

/**
 * Per-source max age. The feeds load daily (36 h = the load plus a missed
 * day). MHA is curated by hand from gazette notifications; a staff "confirm
 * still current" action (T31) re-stamps it, so it gets 8 days.
 */
export const LIST_MAX_AGE_MS: Readonly<Record<SanctionsSourceId, number>> = Object.freeze({
  'ofac-sdn': SANCTIONS_LIST_MAX_AGE_MS,
  'ofac-cons': SANCTIONS_LIST_MAX_AGE_MS,
  'un-sc': SANCTIONS_LIST_MAX_AGE_MS,
  'in-mha-uapa': 8 * 24 * 3_600_000,
});

function fitnessWithAge(info: SanctionsListInfo, now: Date, maxAgeMs: number): ListFitness {
  if (NOT_LOADED_VERSIONS.includes(info.version)) return 'not_live';
  if (info.hash === '') return 'not_live';

  if (typeof info.checkedAt !== 'string' || info.checkedAt === '') return 'stale';
  const checked = Date.parse(info.checkedAt);
  if (!Number.isFinite(checked)) return 'stale';
  const nowMs = now.getTime();
  if (checked > nowMs + LIST_CLOCK_SKEW_MS) return 'stale';
  if (nowMs - checked > maxAgeMs) return 'stale';
  return 'live';
}

/** listFitness rules with the per-source age, for one member of a list set. */
export function sourceFitness(info: SanctionsListInfo, now: Date): ListFitness {
  if (!isSanctionsSourceId(info.source)) return 'not_live';
  return fitnessWithAge(info, now, LIST_MAX_AGE_MS[info.source]);
}

const FITNESS_RANK: Readonly<Record<ListFitness, number>> = Object.freeze({ live: 0, stale: 1, not_live: 2 });

/**
 * Fail safe: the worst sourceFitness over EVERY member (required or not), and
 * not_live for each required source with no member. A set with no list never
 * clears (empty members and empty required -> not_live).
 */
export function listSetFitness(
  members: ReadonlyArray<SanctionsListInfo>,
  required: readonly SanctionsSourceId[],
  now: Date,
): ListFitness {
  if (members.length === 0) return 'not_live';
  let worst: ListFitness = 'live';
  for (const m of members) {
    const f = sourceFitness(m, now);
    if (FITNESS_RANK[f] > FITNESS_RANK[worst]) worst = f;
  }
  const present = new Set(members.map((m) => m.source));
  for (const r of required) if (!present.has(r)) return 'not_live';
  return worst;
}
