// ListSanctionsScreener (Program-Fix 14 step 7): screens a name against a
// loaded SanctionsList (OFAC SDN today) plus the configured extra names (the
// partner/corridor watchlist, so a partner's additions keep working).
//
// Match policy (brief open question C2, recommended default):
//   • an exact normalised or token-set match → matched, score 1 → blocked;
//   • else the best token-set Jaro-Winkler score ≥ FUZZY_THRESHOLD (0.90) →
//     possibleMatch → flagged for HUMAN review, never a silent pass;
//   • else no match.
//   • a WEAK a.k.a. (OFAC category 'weak') matched exactly → possibleMatch at
//     score 1 → review, never a block (PR C);
// A list that cannot be loaded FAILS CLOSED: screen() rejects with
// SanctionsListUnavailableError, which screenTransfer turns into `flagged`
// with evidence decision 'list_unavailable'. It never falls back to the mock.

import { createHash } from 'node:crypto';
import type { CountryCode } from '../types';
import type { SanctionsHit, SanctionsListInfo, SanctionsScreener } from '../providers/sanctions-provider';
import type { SanctionsList, SanctionsListSource } from './list-source';
import { normalizeName, tokenKey } from './normalize';

export const FUZZY_THRESHOLD = 0.9;

export class SanctionsListUnavailableError extends Error {
  constructor(message = 'sanctions list unavailable') {
    super(message);
    this.name = 'SanctionsListUnavailableError';
  }
}

/** Standard Jaro-Winkler similarity (prefix scale 0.1, max prefix 4). */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return a.length === 0 ? 0 : 1;
  const la = a.length;
  const lb = b.length;
  if (la === 0 || lb === 0) return 0;
  const window = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const aMatch = new Array<boolean>(la).fill(false);
  const bMatch = new Array<boolean>(lb).fill(false);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(i + window + 1, lb);
    for (let j = lo; j < hi; j++) {
      if (bMatch[j] || a[i] !== b[j]) continue;
      aMatch[i] = true;
      bMatch[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const m = matches;
  const jaro = (m / la + m / lb + (m - transpositions / 2) / m) / 3;
  let prefix = 0;
  while (prefix < Math.min(4, la, lb) && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** The index of ONE loaded list, shared by every screener that screens it. */
interface ListIndex {
  exact: Map<string, string>;            // tokenKey → entry id (first wins) — strong names only
  weak: Map<string, string>;             // tokenKey → entry id — weak AKAs (review, never block)
  keys: Array<{ key: string; id: string }>; // strong names, for the fuzzy scan
}

// PR C: a list is indexed ONCE per list object (the Postgres source hands back
// the same object until a new version is activated), however many per-partner
// screeners screen it. A WeakMap, so a superseded version is collected.
const listIndexes = new WeakMap<SanctionsList, ListIndex>();
const indexBuilds = new WeakMap<SanctionsList, number>();

/** Test seam: how many times this list object has been indexed. */
export function listIndexBuildsForTests(list: SanctionsList): number {
  return indexBuilds.get(list) ?? 0;
}

function indexList(list: SanctionsList): ListIndex {
  const cached = listIndexes.get(list);
  if (cached) return cached;
  const exact = new Map<string, string>();
  const weak = new Map<string, string>();
  const keys: Array<{ key: string; id: string }> = [];
  for (const e of list.entries) {
    for (const n of e.names ?? []) {
      const key = tokenKey(n ?? '');
      if (key === '') continue;
      if (!exact.has(key)) exact.set(key, e.id);
      keys.push({ key, id: e.id });
    }
    for (const n of e.weakNames ?? []) {
      const key = tokenKey(n ?? '');
      if (key !== '' && !weak.has(key)) weak.set(key, e.id);
    }
  }
  const idx = { exact, weak, keys };
  listIndexes.set(list, idx);
  indexBuilds.set(list, (indexBuilds.get(list) ?? 0) + 1);
  return idx;
}

interface Indexed {
  list: SanctionsList;
  info: SanctionsListInfo;
  idx: ListIndex;
}

export class ListSanctionsScreener implements SanctionsScreener {
  private indexed: Indexed | null = null;
  private lastError = false;
  private readonly extraNames: string[];
  private readonly sourceName: string;
  private readonly extraExact = new Map<string, string>();
  private readonly extraKeys: Array<{ key: string; id: string }> = [];
  private readonly extrasDigest: string;

  constructor(
    private readonly source: SanctionsListSource,
    opts: { extraNames?: string[]; sourceName?: string } = {},
  ) {
    this.extraNames = opts.extraNames ?? [];
    this.sourceName = opts.sourceName ?? 'ofac-sdn';
    this.extraNames.forEach((n, i) => {
      const key = tokenKey(n ?? '');
      if (key === '') return;
      if (!this.extraExact.has(key)) this.extraExact.set(key, `extra:${i}`);
      this.extraKeys.push({ key, id: `extra:${i}` });
    });
    this.extrasDigest = this.extraNames.map((n) => normalizeName(n ?? '')).sort().join('\n');
  }

  private bind(list: SanctionsList): Indexed {
    if (this.indexed && this.indexed.list === list) return this.indexed;
    // The hash covers the list AND the extra names (which are per-partner), so
    // it identifies exactly what this screen compared against.
    const hash = createHash('sha256').update(`${list.hash}\n${this.extrasDigest}`, 'utf8').digest('hex');
    this.indexed = { list, info: { source: list.source, version: list.version, hash }, idx: indexList(list) };
    return this.indexed;
  }

  private async ready(): Promise<Indexed> {
    let list: SanctionsList;
    try {
      // The source owns caching and refresh (PR C): it returns the SAME object
      // until a new version is activated, so this is cheap on the hot path.
      list = await this.source.load();
      if (!list || !Array.isArray(list.entries) || list.entries.length === 0) {
        throw new Error('empty sanctions list');
      }
    } catch {
      // Nothing cached here: the next screen asks the source again.
      this.lastError = true;
      throw new SanctionsListUnavailableError();
    }
    this.lastError = false;
    return this.bind(list);
  }

  listInfo(): SanctionsListInfo {
    if (this.indexed && !this.lastError) return this.indexed.info;
    return { source: this.sourceName, version: this.lastError ? 'unavailable' : 'unloaded', hash: '' };
  }

  async screen(input: { name: string; sourceCountry: CountryCode }): Promise<SanctionsHit> {
    const { idx, info } = await this.ready();
    const key = tokenKey(input.name ?? '');
    if (key === '') return { matched: false };
    const exactId = idx.exact.get(key) ?? this.extraExact.get(key);
    if (exactId) return { matched: true, matchScore: 1, entryId: exactId, listSource: info.source };
    // A weak a.k.a. (exact only) is a possible match at score 1 — review, never a block.
    const weakId = idx.weak.get(key);
    if (weakId) return { matched: false, possibleMatch: true, matchScore: 1, entryId: weakId, listSource: info.source };
    let best = 0;
    let bestId: string | undefined;
    for (const keys of [idx.keys, this.extraKeys]) {
      for (const k of keys) {
        // Jaro-Winkler ≥ 0.9 needs shorter/longer ≥ 0.5 (JW ≤ 0.6·jaro + 0.4 and
        // jaro ≤ (2 + s/L)/3), so such keys can never reach the threshold:
        // skipping them loses no match and bounds the cost of a huge name.
        const lk = k.key.length;
        if (Math.min(lk, key.length) * 2 < Math.max(lk, key.length)) continue;
        const score = jaroWinkler(key, k.key);
        if (score > best) {
          best = score;
          bestId = k.id;
        }
      }
    }
    if (bestId && best >= FUZZY_THRESHOLD) {
      return {
        matched: false,
        possibleMatch: true,
        matchScore: Math.round(best * 1000) / 1000,
        entryId: bestId,
        listSource: info.source,
      };
    }
    return { matched: false };
  }
}
