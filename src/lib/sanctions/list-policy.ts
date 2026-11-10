// list-policy — Fix pack 2 (R02): which sanctions list a real-money screen may
// rely on. Pure: no I/O, no clock of its own (the caller passes `now`).
//
// A list is 'live' only when it is the real OFAC SDN list, a loaded version
// with a content hash, and confirmed current within SANCTIONS_LIST_MAX_AGE_MS
// (the daily load plus a missed day). 'stale' is the right list grown old (or
// of unknown age); 'not_live' is a list that can never clear real money (the
// mock watchlist, an unloaded or unavailable list).

import type { SanctionsListInfo } from '../providers/sanctions-provider';

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
