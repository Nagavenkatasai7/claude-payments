// multi-list-screener — Fix pack 5 (R08, P25): screen one name against EVERY
// list of a set (the floor for the transfer's destination, list-sets.ts
// floorLists), used only under the opt-in SANCTIONS_LIST=lists.
//
//   • any member's exact match blocks (the first member in order wins);
//   • else any member's possible match flags for review (the first one);
//   • ANY member that cannot answer (its load rejects, its list is empty, its
//     screen throws, or it reports no loaded list) fails the WHOLE screen
//     closed with SanctionsListUnavailableError: never a partial result, so
//     screenTransfer holds the row as pack 2 does (LIST_UNAVAILABLE).
//
// A stale member does not throw: the set fitness (list-policy.ts
// listSetFitness over memberInfos()) is what holds real money (T29).
// Hashes, versions and entry ids only: never a name.

import { createHash } from 'node:crypto';
import type { CountryCode } from '../types';
import type { SanctionsHit, SanctionsListInfo, SanctionsScreener } from '../providers/sanctions-provider';
import { SanctionsListUnavailableError } from './list-screener';
import { sourceFitness, type ListFitness } from './list-policy';
import type { SanctionsSourceId } from './list-sets';

export interface ListMember {
  source: SanctionsSourceId;
  screener: SanctionsScreener;
}

export interface MemberListInfo {
  source: SanctionsSourceId;
  version: string;
  hash: string;
  checkedAt?: string;
  fitness: ListFitness;
}

const NOT_LOADED = new Set(['unloaded', 'unavailable']);

function loaded(info: SanctionsListInfo): boolean {
  return !NOT_LOADED.has(info.version) && info.hash !== '';
}

export class MultiListSanctionsScreener implements SanctionsScreener {
  private readonly members: ReadonlyArray<ListMember>;
  private readonly compositeSource: string;

  constructor(members: ReadonlyArray<ListMember>) {
    if (!Array.isArray(members) || members.length === 0) {
      throw new Error('MultiListSanctionsScreener needs at least one list');
    }
    this.members = Object.freeze([...members]);
    this.compositeSource = `lists:${this.members.map((m) => m.source).join('+')}`;
  }

  async screen(input: { name: string; sourceCountry: CountryCode }): Promise<SanctionsHit> {
    let hits: SanctionsHit[];
    try {
      // Each source caches its list, so screening every member in parallel is cheap.
      hits = await Promise.all(this.members.map((m) => m.screener.screen(input)));
    } catch {
      // A list error or any other member failure: no partial result.
      throw new SanctionsListUnavailableError();
    }
    if (!this.members.every((m) => loaded(m.screener.listInfo()))) {
      throw new SanctionsListUnavailableError();
    }
    const source = this.compositeSource;
    const exact = hits.find((h) => h.matched);
    if (exact) return { ...exact, listSource: source };
    const possible = hits.find((h) => Boolean(h.possibleMatch));
    if (possible) return { ...possible, listSource: source };
    return { matched: false };
  }

  /** The composite identity; 'unloaded' (hash '') until every member has loaded. */
  listInfo(): SanctionsListInfo {
    const infos = this.members.map((m) => m.screener.listInfo());
    if (!infos.every(loaded)) {
      const version = infos.some((i) => i.version === 'unavailable') ? 'unavailable' : 'unloaded';
      return { source: this.compositeSource, version, hash: '' };
    }
    const hash = createHash('sha256').update(infos.map((i) => i.hash).join('|'), 'utf8').digest('hex');
    let oldest: string | undefined;
    let oldestMs = Infinity;
    let allKnown = true;
    for (const i of infos) {
      const ms = typeof i.checkedAt === 'string' ? Date.parse(i.checkedAt) : NaN;
      if (!Number.isFinite(ms)) {
        allKnown = false;
        break;
      }
      if (ms < oldestMs) {
        oldestMs = ms;
        oldest = i.checkedAt;
      }
    }
    return {
      source: this.compositeSource,
      version: infos.map((i) => i.version).join('+'),
      hash,
      ...(allKnown && oldest ? { checkedAt: oldest } : {}),
    };
  }

  /** One entry per member, in member order, with its own per-source fitness. */
  memberInfos(now?: Date): MemberListInfo[] {
    const at = now ?? new Date();
    return this.members.map((m) => {
      const info = m.screener.listInfo();
      // A member serving a list of another source is never live (fail safe).
      const fitness: ListFitness = info.source === m.source ? sourceFitness(info, at) : 'not_live';
      return {
        source: m.source,
        version: info.version,
        hash: info.hash,
        ...(info.checkedAt ? { checkedAt: info.checkedAt } : {}),
        fitness,
      };
    });
  }
}

export function isMultiListScreener(s: SanctionsScreener): s is MultiListSanctionsScreener {
  return s instanceof MultiListSanctionsScreener;
}
