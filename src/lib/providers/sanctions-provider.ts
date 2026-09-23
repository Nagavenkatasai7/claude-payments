import { createHash } from 'node:crypto';
import type { CountryCode } from '../types';
import { env } from '../env';
import { logWarn } from '../log';
import { normalizeName, tokenKey } from '../sanctions/normalize';
import { ListSanctionsScreener } from '../sanctions/list-screener';
import type { SanctionsList, SanctionsListSource } from '../sanctions/list-source';

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
    const key = tokenKey(input.name ?? '');                         // defensive ?? '' (untrusted)
    if (key === '') return { matched: false };
    const list = this.baseList ?? [];
    for (let i = 0; i < list.length; i++) {
      if (tokenKey(list[i] ?? '') === key) {
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
// to a screener. Unset / 'mock' → the mock; 'ofac-sdn' → the bundled snapshot
// (fails closed to `flagged` if it cannot load); anything else → the mock plus
// one warning. It is optional, not in boot-assert, and unset in production.

/** Where the (uncommitted) snapshot script writes the OFAC list. */
export const OFAC_SNAPSHOT_RELATIVE_PATH = 'src/lib/sanctions/data/ofac-snapshot.json';

/**
 * Reads the snapshot lazily (node:fs is imported at call time, and the JSON is
 * never statically imported, so a missing file breaks neither the build nor
 * any request that does not select the OFAC list). Only a successful load is
 * memoised; a failure is retried on the next screen.
 */
class SnapshotFileListSource implements SanctionsListSource {
  private cached: SanctionsList | null = null;
  async load(): Promise<SanctionsList> {
    if (this.cached) return this.cached;
    const [{ readFile }, { join }] = await Promise.all([import('node:fs/promises'), import('node:path')]);
    const raw = await readFile(join(process.cwd(), OFAC_SNAPSHOT_RELATIVE_PATH), 'utf8');
    const list = JSON.parse(raw) as SanctionsList;
    if (!list || typeof list.version !== 'string' || !Array.isArray(list.entries) || list.entries.length === 0) {
      throw new Error('invalid OFAC snapshot');
    }
    this.cached = list;
    return list;
  }
}

let ofacSource: SanctionsListSource = new SnapshotFileListSource();
let warnedUnknown = false;
// The factory runs on EVERY screen; indexing the SDN list (~44k names) per call
// would be wasteful, so a list screener is kept per distinct base list (the
// global WATCHLIST, or WATCHLIST ∪ a partner's extras). Bounded.
const ofacScreeners = new Map<string, ListSanctionsScreener>();
const MAX_CACHED_SCREENERS = 64;

/** Test seam: replace the OFAC list source (null restores the snapshot file) and reset the one-time warning. */
export function setOfacListSourceForTests(src: SanctionsListSource | null): void {
  ofacSource = src ?? new SnapshotFileListSource();
  warnedUnknown = false;
  ofacScreeners.clear();
}

function ofacScreener(baseList: string[]): ListSanctionsScreener {
  const key = baseList.join('\u0000');
  let s = ofacScreeners.get(key);
  if (!s) {
    if (ofacScreeners.size >= MAX_CACHED_SCREENERS) ofacScreeners.clear();
    s = new ListSanctionsScreener(ofacSource, { extraNames: [...baseList] });
    ofacScreeners.set(key, s);
  }
  return s;
}

export function getSanctionsScreener(baseList: string[]): SanctionsScreener {
  const which = env.sanctionsList;
  if (which === '' || which === 'mock') return new MockSanctionsScreener(baseList);
  if (which === 'ofac-sdn') return ofacScreener(baseList ?? []);
  if (!warnedUnknown) {
    warnedUnknown = true;
    logWarn('sanctions.unknown-list', 'SANCTIONS_LIST has an unknown value; screening with the mock list', {});
  }
  return new MockSanctionsScreener(baseList);
}
