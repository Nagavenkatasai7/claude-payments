import { createHash } from 'node:crypto';
import type { CountryCode } from '../types';
import { env } from '../env';
import { logWarn } from '../log';
import { normalizeName, tokenKey } from '../sanctions/normalize';
import { ListSanctionsScreener } from '../sanctions/list-screener';
import type { SanctionsListSource } from '../sanctions/list-source';
import { PostgresSanctionsListSource } from '../sanctions/pg-list-source';
import { MultiListSanctionsScreener } from '../sanctions/multi-list-screener';
import { SANCTIONS_SOURCES, floorLists, type SanctionsSourceId } from '../sanctions/list-sets';
import { createSanctionsListRepo } from '@/db/repos/sanctions-list-repo';
import { getDb } from '@/db/client';

export interface SanctionsHit {
  matched: boolean;
  /** Internal only — NEVER copied into evidence (the mock's entries ARE names). */
  matchedName?: string;
  listSource?: string;   // e.g. 'mock-watchlist' | 'ofac-sdn'
  /** Program-Fix 14: 1 for an exact normalised match; the fuzzy score for a possible match. */
  matchScore?: number;
  /** Program-Fix 14: the list entry id ('mock:<index>', 'sdn:<uid>', 'extra:<index>'), never a name. */
  entryId?: string;
  /** Program-Fix 14: a fuzzy near-miss — flagged for human review, never a silent pass. */
  possibleMatch?: boolean;
}

/** Which list a screen compared against (evidence: listSource/listVersion/listHash). */
export interface SanctionsListInfo {
  source: string;
  version: string;
  hash: string;
  /**
   * Fix pack 2 (R02): when the list was last confirmed current (ISO). Absent
   * means unknown, which list-policy.ts listFitness reads as stale.
   */
  checkedAt?: string;
  /** Fix pack 2 (R02): the base list's hash before corridor additions. */
  baseHash?: string;
}

/**
 * The pluggable sanctions-screening seam (P5), mirroring KycProvider. A real
 * provider (ComplyAdvantage / Sanctions.io) implements the same interface and
 * is swapped in by changing getSanctionsScreener — no call-site change.
 * The contract returns a Promise so a network-backed provider needs no
 * signature change; the mock resolves immediately.
 */
export interface SanctionsScreener {
  screen(input: { name: string; sourceCountry: CountryCode }): Promise<SanctionsHit>;
  /** Program-Fix 14: the list identity recorded in screening evidence. */
  listInfo(): SanctionsListInfo;
}

/**
 * MockSanctionsScreener: P5 stand-in, exact matching against a base list
 * (WATCHLIST plus any corridor watchlistExtra). Program-Fix 14 (prs-03): both
 * the query and each entry go through normalizeName/tokenKey, so formatting
 * differences do not change the outcome.
 * sourceCountry is accepted (so a real provider can scope by jurisdiction)
 * but unused here.
 *
 * entryId is `mock:<index into the base list>` and listInfo().hash is a hash
 * of the sorted normalised list. Both are PER-PARTNER: the base list is the
 * global WATCHLIST ∪ the partner's corridor watchlistExtra (compliance.ts).
 */
export class MockSanctionsScreener implements SanctionsScreener {
  constructor(private readonly baseList: string[]) {}

  listInfo(): SanctionsListInfo {
    const sorted = (this.baseList ?? []).map((n) => normalizeName(n ?? '')).sort().join('\n');
    return {
      source: 'mock-watchlist',
      version: 'static',
      hash: createHash('sha256').update(sorted, 'utf8').digest('hex'),
    };
  }

  async screen(input: { name: string; sourceCountry: CountryCode }): Promise<SanctionsHit> {
    const raw = (input.name ?? '').trim().toLowerCase();            // defensive ?? '' (untrusted)
    if (raw === '') return { matched: false };
    const key = tokenKey(raw);
    const list = this.baseList ?? [];
    for (let i = 0; i < list.length; i++) {
      const entryKey = tokenKey(list[i] ?? '');
      // An entry with no letters or digits (punctuation- or emoji-only)
      // normalises to '' — it falls back to the pre-normalisation exact
      // trim().toLowerCase() compare so it can never silently stop matching.
      const hit = entryKey !== ''
        ? key !== '' && entryKey === key
        : (list[i] ?? '').trim().toLowerCase() === raw;
      if (hit) {
        return {
          matched: true,
          matchedName: normalizeName(list[i] ?? ''),
          listSource: 'mock-watchlist',
          matchScore: 1,
          entryId: `mock:${i}`,
        };
      }
    }
    return { matched: false };
  }
}

// ── The list selector (Program-Fix 14 step 8) ────────────────────────────────
// SANCTIONS_LIST picks WHICH list is screened, never WHETHER: every value maps
// to a screener. Unset / 'mock' → the mock; 'ofac-sdn' → the OFAC SDN list the
// daily loader stored in Postgres (PR C, migration 0023; fails closed to
// `flagged` when no version is loaded); anything else → the mock plus one
// warning. It is optional, not in boot-assert, and unset in production.
// Fix pack 5 (R08, P25): 'lists' (opt-in) → a MultiListSanctionsScreener over
// floorLists(destinationCountry) (list-sets.ts), one Postgres source per list;
// any missing list fails the screen closed. The other values ignore the
// destination and are byte-identical to before.

function defaultListSource(source: SanctionsSourceId): SanctionsListSource {
  // getDb() is resolved lazily (at the first cold load), so selecting the mock
  // — the default — never opens a pool.
  return new PostgresSanctionsListSource(() => createSanctionsListRepo(getDb()), { source });
}

// One source per list, filled lazily (ofac-sdn is the only one outside 'lists').
const listSources = new Map<SanctionsSourceId, SanctionsListSource>();
function listSource(source: SanctionsSourceId): SanctionsListSource {
  let s = listSources.get(source);
  if (!s) {
    s = defaultListSource(source);
    listSources.set(source, s);
  }
  return s;
}
let warnedUnknown = false;
// The factory runs on EVERY screen; indexing the SDN list (~44k names) per call
// would be wasteful, so a list screener is kept per distinct base list (the
// global WATCHLIST, or WATCHLIST ∪ a partner's extras). Bounded.
const ofacScreeners = new Map<string, ListSanctionsScreener>();
const MAX_CACHED_SCREENERS = 64;

/** Test seam (pack 5 T28): replace one list's source (null restores its Postgres source), reset the one-time warning and the caches. */
export function setListSourceForTests(source: SanctionsSourceId, src: SanctionsListSource | null): void {
  listSources.set(source, src ?? defaultListSource(source));
  warnedUnknown = false;
  ofacScreeners.clear();
}

/** Test seam (pack 5 T28): the source one list currently uses. */
export function listSourceForTests(source: SanctionsSourceId): SanctionsListSource {
  return listSource(source);
}

/** Test seam: replace the OFAC list source (null restores the Postgres source) and reset the one-time warning. */
export function setOfacListSourceForTests(src: SanctionsListSource | null): void {
  setListSourceForTests('ofac-sdn', src);
}

/** Test seam: the OFAC list source currently in use. */
export function ofacListSourceForTests(): SanctionsListSource {
  return listSource('ofac-sdn');
}

/** warm() is contractually non-throwing; a custom source is guarded here. */
async function warmSource(source: SanctionsListSource): Promise<void> {
  try {
    await source.warm?.();
  } catch {
    // swallowed on purpose (see above)
  }
}

/**
 * PR C: refresh the OFAC list BEFORE a mint takes its sender lock
 * (transfer-create.ts), so the screen inside the mint transaction reads the
 * cached list and never needs a second pool connection. A no-op unless
 * SANCTIONS_LIST=ofac-sdn. Never throws: a failed refresh keeps the last
 * loaded version, and a process with none fails closed at screen time.
 */
export async function warmSanctionsList(): Promise<void> {
  const which = env.sanctionsList;
  if (which === 'ofac-sdn') {
    await warmSource(listSource('ofac-sdn'));
    return;
  }
  // Fix pack 5 (P25): 'lists' warms every source (the screen inside the mint
  // transaction may use any of them), each on its own, never throwing.
  if (which === 'lists') {
    await Promise.allSettled(SANCTIONS_SOURCES.map((s) => warmSource(listSource(s))));
  }
}

/**
 * Fix pack 2 (R02): the OFAC list served right now (refreshed first, like a
 * mint does), as list info with its live checkedAt. Rejects when no list can
 * load; list-health.ts reads that as 'not_live'. Never a name: ids and hashes.
 */
export async function servedOfacListInfo(): Promise<SanctionsListInfo> {
  return servedListInfo('ofac-sdn');
}

/**
 * Fix pack 5 (P25): servedOfacListInfo for any source. It warms only that
 * source, and only where a screen would use it (ofac-sdn under 'ofac-sdn',
 * any source under 'lists'), so the OFAC call order is unchanged.
 */
export async function servedListInfo(source: SanctionsSourceId): Promise<SanctionsListInfo> {
  const which = env.sanctionsList;
  const src = listSource(source);
  if (which === 'lists' || (which === 'ofac-sdn' && source === 'ofac-sdn')) await warmSource(src);
  const list = await src.load();
  if (!list || !Array.isArray(list.entries) || list.entries.length === 0) {
    throw new Error('empty sanctions list');
  }
  const checkedAt = src.checkedAt?.()?.toISOString();
  return {
    source: list.source,
    version: list.version,
    hash: list.hash,
    baseHash: list.hash,
    ...(checkedAt ? { checkedAt } : {}),
  };
}

function listScreener(source: SanctionsSourceId, baseList: string[]): ListSanctionsScreener {
  const key = `${source}\u0000${baseList.join('\u0000')}`;
  let s = ofacScreeners.get(key);
  if (!s) {
    if (ofacScreeners.size >= MAX_CACHED_SCREENERS) ofacScreeners.clear();
    s = new ListSanctionsScreener(listSource(source), { extraNames: [...baseList], sourceName: source });
    ofacScreeners.set(key, s);
  }
  return s;
}

function ofacScreener(baseList: string[]): ListSanctionsScreener {
  return listScreener('ofac-sdn', baseList);
}

export function getSanctionsScreener(
  baseList: string[],
  opts?: { destinationCountry?: CountryCode | null },
): SanctionsScreener {
  const which = env.sanctionsList;
  if (which === '' || which === 'mock') return new MockSanctionsScreener(baseList);
  if (which === 'ofac-sdn') return ofacScreener(baseList ?? []);
  if (which === 'lists') {
    // The base list (WATCHLIST ∪ the partner's extras) rides on ofac-sdn only,
    // so each extra is screened once.
    return new MultiListSanctionsScreener(
      floorLists(opts?.destinationCountry).map((s) => ({
        source: s,
        screener: listScreener(s, s === 'ofac-sdn' ? baseList ?? [] : []),
      })),
    );
  }
  if (!warnedUnknown) {
    warnedUnknown = true;
    logWarn('sanctions.unknown-list', 'SANCTIONS_LIST has an unknown value; screening with the mock list', {});
  }
  return new MockSanctionsScreener(baseList);
}
