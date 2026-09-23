import { createHash } from 'node:crypto';
import type { CountryCode } from '../types';
import { env } from '../env';
import { logWarn } from '../log';
import { normalizeName, tokenKey } from '../sanctions/normalize';
import { ListSanctionsScreener } from '../sanctions/list-screener';
import type { SanctionsListSource } from '../sanctions/list-source';
import { PostgresSanctionsListSource } from '../sanctions/pg-list-source';
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

function defaultOfacSource(): SanctionsListSource {
  // getDb() is resolved lazily (at the first cold load), so selecting the mock
  // — the default — never opens a pool.
  return new PostgresSanctionsListSource(() => createSanctionsListRepo(getDb()), { source: 'ofac-sdn' });
}

let ofacSource: SanctionsListSource = defaultOfacSource();
let warnedUnknown = false;
// The factory runs on EVERY screen; indexing the SDN list (~44k names) per call
// would be wasteful, so a list screener is kept per distinct base list (the
// global WATCHLIST, or WATCHLIST ∪ a partner's extras). Bounded.
const ofacScreeners = new Map<string, ListSanctionsScreener>();
const MAX_CACHED_SCREENERS = 64;

/** Test seam: replace the OFAC list source (null restores the Postgres source) and reset the one-time warning. */
export function setOfacListSourceForTests(src: SanctionsListSource | null): void {
  ofacSource = src ?? defaultOfacSource();
  warnedUnknown = false;
  ofacScreeners.clear();
}

/** Test seam: the OFAC list source currently in use. */
export function ofacListSourceForTests(): SanctionsListSource {
  return ofacSource;
}

/**
 * PR C: refresh the OFAC list BEFORE a mint takes its sender lock
 * (transfer-create.ts), so the screen inside the mint transaction reads the
 * cached list and never needs a second pool connection. A no-op unless
 * SANCTIONS_LIST=ofac-sdn. Never throws: a failed refresh keeps the last
 * loaded version, and a process with none fails closed at screen time.
 */
export async function warmSanctionsList(): Promise<void> {
  if (env.sanctionsList !== 'ofac-sdn') return;
  try {
    await ofacSource.warm?.();
  } catch {
    // warm() is contractually non-throwing; a custom source is guarded here.
  }
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
