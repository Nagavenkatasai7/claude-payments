// multi-list-screener — Fix pack 5 (R08, P25): screen one name against EVERY
// list of a set (the floor for the transfer's destination, list-sets.ts
// floorLists), used only under the opt-in SANCTIONS_LIST=lists.
//
// THE RULE (LA1): an exact match on any member blocks, whatever the other
// members did; every other outcome on a partial set (a possible match, a
// clear) fails closed.
//
//   • every member is settled; an exact match on any member that answered is
//     returned (the first one in member order), even when another member's
//     load rejects, its list is empty, its screen throws, or it reports no
//     loaded list: a confirmed listed hit is never turned into a hold;
//   • else, when ANY member cannot answer (as above), the WHOLE screen fails
//     closed with SanctionsListUnavailableError: never a partial possible match
//     or clear, so screenTransfer holds the row as pack 2 does
//     (LIST_UNAVAILABLE);
//   • else any member's possible match flags for review (the first one).
//
// An exact match from a partial set is marked (fromPartialSet): screenTransfer
// then writes the not-checked list fields on the block's evidence (version
// 'unavailable', hash '', not_live), never the composite identity read after
// the screen, which a member that loads again meanwhile would make look full.
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

/**
 * LF1-D1: the exact-match hits returned while the set was partial (a member
 * rejected or was not loaded during THAT screen). Kept out of SanctionsHit so
 * the shared type and every other screener stay unchanged; the composite
 * listInfo() read later cannot tell, because a member may load again before.
 */
const PARTIAL_HITS = new WeakSet<SanctionsHit>();

/** True when this hit is an exact match found while the set was partial. */
export function fromPartialSet(hit: SanctionsHit): boolean {
  return PARTIAL_HITS.has(hit);
}

/**
 * Fix pack 5 T29 (P26): the members that did NOT answer one screen (their load
 * rejected, their screen threw, or they reported no loaded list), recorded on
 * the partial-set hit or on the SanctionsListUnavailableError that screen
 * returned or threw. screenTransfer reads it so the evidence's lists[] never
 * claims a list was checked when it was not.
 */
const UNANSWERED = new WeakMap<object, readonly SanctionsSourceId[]>();

/** The members that did not answer the screen that produced this hit or error; [] when none is recorded. */
export function unansweredMembers(hitOrError: unknown): readonly SanctionsSourceId[] {
  if (!hitOrError || typeof hitOrError !== 'object') return [];
  return UNANSWERED.get(hitOrError) ?? [];
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
    // Each source caches its list, so screening every member in parallel is
    // cheap. allSettled: a member's failure never drops another member's hit.
    const settled = await Promise.allSettled(this.members.map((m) => m.screener.screen(input)));
    const source = this.compositeSource;
    const missing = Object.freeze(
      this.members
        .filter((m, i) => settled[i].status === 'rejected' || !loaded(m.screener.listInfo()))
        .map((m) => m.source),
    );
    const partial = missing.length > 0;
    // An exact match on any member blocks, whatever the other members did.
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value.matched) {
        const hit: SanctionsHit = { ...r.value, listSource: source };
        if (partial) {
          PARTIAL_HITS.add(hit);
          UNANSWERED.set(hit, missing);
        }
        return hit;
      }
    }
    // Anything else on a partial set fails closed: no partial result.
    if (partial) {
      const err = new SanctionsListUnavailableError();
      UNANSWERED.set(err, missing);
      throw err;
    }
    const hits = settled.map((r) => (r as PromiseFulfilledResult<SanctionsHit>).value);
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
