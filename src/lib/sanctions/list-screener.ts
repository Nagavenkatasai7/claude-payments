// ListSanctionsScreener (Program-Fix 14 step 7): screens a name against a
// loaded SanctionsList (OFAC SDN today) plus the configured extra names (the
// partner/corridor watchlist, so a partner's additions keep working).
//
// Match policy (brief open question C2, recommended default):
//   • an exact normalised or token-set match → matched, score 1 → blocked;
//   • else the best token-set Jaro-Winkler score ≥ FUZZY_THRESHOLD (0.90) →
//     possibleMatch → flagged for HUMAN review, never a silent pass;
//   • else no match.
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

interface Indexed {
  info: SanctionsListInfo;
  exact: Map<string, string>;            // tokenKey → entry id (first wins)
  keys: Array<{ key: string; id: string }>;
}

export class ListSanctionsScreener implements SanctionsScreener {
  private indexed: Indexed | null = null;
  private loading: Promise<Indexed> | null = null;
  private lastError = false;
  private readonly extraNames: string[];
  private readonly sourceName: string;

  constructor(
    private readonly source: SanctionsListSource,
    opts: { extraNames?: string[]; sourceName?: string } = {},
  ) {
    this.extraNames = opts.extraNames ?? [];
    this.sourceName = opts.sourceName ?? 'ofac-sdn';
  }

  private build(list: SanctionsList): Indexed {
    const exact = new Map<string, string>();
    const keys: Array<{ key: string; id: string }> = [];
    const add = (name: string, id: string) => {
      const key = tokenKey(name);
      if (key === '') return;
      if (!exact.has(key)) exact.set(key, id);
      keys.push({ key, id });
    };
    for (const e of list.entries) for (const n of e.names) add(n, e.id);
    this.extraNames.forEach((n, i) => add(n ?? '', `extra:${i}`));
    // The hash covers the list AND the extra names (which are per-partner), so
    // it identifies exactly what this screen compared against.
    const extras = this.extraNames.map((n) => normalizeName(n ?? '')).sort().join('\n');
    const hash = createHash('sha256').update(`${list.hash}\n${extras}`, 'utf8').digest('hex');
    return { info: { source: list.source, version: list.version, hash }, exact, keys };
  }

  private async ready(): Promise<Indexed> {
    if (this.indexed) return this.indexed;
    if (!this.loading) {
      this.loading = this.source.load().then((list) => {
        if (!list || !Array.isArray(list.entries) || list.entries.length === 0) {
          throw new Error('empty sanctions list');
        }
        this.indexed = this.build(list);
        this.lastError = false;
        return this.indexed;
      });
    }
    try {
      return await this.loading;
    } catch {
      // Not cached: the next screen retries the load.
      this.loading = null;
      this.lastError = true;
      throw new SanctionsListUnavailableError();
    }
  }

  listInfo(): SanctionsListInfo {
    if (this.indexed) return this.indexed.info;
    return { source: this.sourceName, version: this.lastError ? 'unavailable' : 'unloaded', hash: '' };
  }

  async screen(input: { name: string; sourceCountry: CountryCode }): Promise<SanctionsHit> {
    const idx = await this.ready();
    const key = tokenKey(input.name ?? '');
    if (key === '') return { matched: false };
    const exactId = idx.exact.get(key);
    if (exactId) return { matched: true, matchScore: 1, entryId: exactId, listSource: idx.info.source };
    let best = 0;
    let bestId: string | undefined;
    for (const k of idx.keys) {
      const score = jaroWinkler(key, k.key);
      if (score > best) {
        best = score;
        bestId = k.id;
      }
    }
    if (bestId && best >= FUZZY_THRESHOLD) {
      return {
        matched: false,
        possibleMatch: true,
        matchScore: Math.round(best * 1000) / 1000,
        entryId: bestId,
        listSource: idx.info.source,
      };
    }
    return { matched: false };
  }
}
