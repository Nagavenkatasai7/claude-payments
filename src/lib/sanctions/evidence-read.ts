// evidence-read — Fix pack 2 T9 (R02): read back what a transfer was screened
// against, and decide whether that screen still stands for real money.
//
//   listScreenEvidence  the transfer's sanctions.screen rows (OWNER tenant),
//                       oldest first, each meta type-checked; a malformed row
//                       is skipped, never trusted.
//   liveFresh           a screen on a LIVE list, recent enough to rely on.
//   uncoveredRoles      the coverage rule: a re-screen stands in for an earlier
//                       screen only when it screened the SAME names (by keyed
//                       hash) in the same roles. A name screened before that a
//                       re-screen cannot re-screen (never stored) is uncovered.
//
// Never decrypts and never logs: evidence holds keyed hashes, never names.
//
// Fix pack 5 T29 (P26): a malformed lists[] (or a malformed party `unscreened`
// flag) fails closed on the row itself, never by skipping it: the row is kept,
// lists dropped, listFitness forced to 'not_live' (so an older live row is
// never judged in its place).

import type { DbOrTx } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import type { Transfer } from '@/lib/types';
import {
  inputHash,
  SANCTIONS_AUDIT_ACTION,
  type SanctionsDecision,
  type ScreeningEvidence,
  type ScreeningEvidenceList,
  type ScreeningEvidenceParty,
} from './evidence';
import { LIST_CLOCK_SKEW_MS, SANCTIONS_LIST_MAX_AGE_MS, type ListFitness } from './list-policy';

/** The mint writes its evidence in the mint transaction; this bounds the indexed read below createdAt. */
const BEFORE_CREATED_MS = 10 * 60_000;
/** A row written by a clock slightly ahead of ours is still read. */
const AFTER_NOW_MS = 60_000;

const DECISIONS: readonly SanctionsDecision[] = ['clear', 'match', 'possible_match', 'list_unavailable', 'error'];
const FITNESSES: readonly ListFitness[] = ['live', 'stale', 'not_live'];

/** A party, or null when malformed; `bad` is set when only its `unscreened` flag is malformed. */
function parseParty(v: unknown, flags: { bad: boolean }): ScreeningEvidenceParty | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  if (p.role !== 'recipient' && p.role !== 'sender') return null;
  if (p.inputHash !== null && typeof p.inputHash !== 'string') return null;
  if (typeof p.matched !== 'boolean' || typeof p.matchScore !== 'number') return null;
  if (p.matchedEntryId !== undefined && typeof p.matchedEntryId !== 'string') return null;
  const party: ScreeningEvidenceParty = { role: p.role, inputHash: p.inputHash, matched: p.matched, matchScore: p.matchScore };
  if (typeof p.matchedEntryId === 'string') party.matchedEntryId = p.matchedEntryId;
  // Fix pack 5 T29: any value other than `true` is malformed: the party reads
  // as unscreened (never as screened clear) and the row's fitness is not_live.
  if (p.unscreened !== undefined) {
    if (p.unscreened !== true) flags.bad = true;
    party.unscreened = true;
  }
  return party;
}

/** Fix pack 5 T29 (P26): lists[] item by item (whitelisted keys); 'bad' when malformed; undefined when absent. */
function parseLists(raw: unknown): ScreeningEvidenceList[] | 'bad' | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return 'bad';
  const out: ScreeningEvidenceList[] = [];
  for (const v of raw) {
    if (!v || typeof v !== 'object') return 'bad';
    const l = v as Record<string, unknown>;
    if (typeof l.source !== 'string' || typeof l.version !== 'string' || typeof l.hash !== 'string') return 'bad';
    if (!FITNESSES.includes(l.fitness as ListFitness)) return 'bad';
    if (l.checkedAt !== undefined && typeof l.checkedAt !== 'string') return 'bad';
    out.push({
      source: l.source,
      version: l.version,
      hash: l.hash,
      fitness: l.fitness as ListFitness,
      ...(typeof l.checkedAt === 'string' ? { checkedAt: l.checkedAt } : {}),
    });
  }
  return out;
}

/** The evidence in an audit row's meta, or null when any field has the wrong type. */
function parseEvidence(meta: Record<string, unknown>): ScreeningEvidence | null {
  const { listSource, listVersion, listHash, screenedAt, decision, parties, listFitness, listCheckedAt, listBaseHash, lists } = meta;
  if (
    typeof listSource !== 'string' ||
    typeof listVersion !== 'string' ||
    typeof listHash !== 'string' ||
    typeof screenedAt !== 'string' ||
    typeof decision !== 'string' ||
    !DECISIONS.includes(decision as SanctionsDecision) ||
    !Array.isArray(parties)
  ) {
    return null;
  }
  if (listFitness !== undefined && !FITNESSES.includes(listFitness as ListFitness)) return null;
  if (listCheckedAt !== undefined && typeof listCheckedAt !== 'string') return null;
  if (listBaseHash !== undefined && typeof listBaseHash !== 'string') return null;
  const flags = { bad: false };
  const parsed: ScreeningEvidenceParty[] = [];
  for (const raw of parties) {
    const p = parseParty(raw, flags);
    if (!p) return null;
    parsed.push(p);
  }
  const parsedLists = parseLists(lists);
  // Fix pack 5 T29: a malformed lists[] or unscreened flag keeps the row and fails closed on it.
  const fitness: ListFitness | undefined =
    parsedLists === 'bad' || flags.bad ? 'not_live' : (listFitness as ListFitness | undefined);
  return {
    listSource,
    listVersion,
    listHash,
    screenedAt,
    decision: decision as SanctionsDecision,
    parties: parsed,
    ...(fitness !== undefined ? { listFitness: fitness } : {}),
    ...(typeof listCheckedAt === 'string' ? { listCheckedAt } : {}),
    ...(typeof listBaseHash === 'string' ? { listBaseHash } : {}),
    ...(Array.isArray(parsedLists) ? { lists: parsedLists } : {}),
  };
}

/**
 * ALL the transfer's sanctions.screen evidence, OWNER tenant, written in
 * [createdAt - 10 min, now + 1 min), oldest first, however many other audit
 * rows the subject has. Malformed rows are skipped.
 * An unreadable createdAt reads nothing (the caller then sees no live evidence).
 * A read error propagates: the caller must not settle on it.
 */
export async function listScreenEvidence(
  db: DbOrTx,
  t: Pick<Transfer, 'id' | 'partnerId' | 'createdAt'>,
  now: Date,
): Promise<ScreeningEvidence[]> {
  const created = Date.parse(t.createdAt);
  if (!Number.isFinite(created) || !t.partnerId) return [];
  // Its own query on the action (no cap shared with other audit actions), so
  // .at(-1) is always the newest screen (pack 2 review F1/A4).
  const rows = await createAuditRepo(db).listBySubjectAction(
    t.partnerId,
    t.id,
    SANCTIONS_AUDIT_ACTION,
    new Date(created - BEFORE_CREATED_MS),
    new Date(now.getTime() + AFTER_NOW_MS),
  );
  const out: ScreeningEvidence[] = [];
  for (const row of rows) {
    const e = parseEvidence(row.meta);
    if (e) out.push(e);
  }
  return out;
}

/**
 * A screen real money may still rely on: taken against a LIVE list, and no
 * older than SANCTIONS_LIST_MAX_AGE_MS (a screenedAt up to the clock skew in
 * the future is tolerated; further is not).
 */
export function liveFresh(e: ScreeningEvidence | undefined, now: Date): boolean {
  if (e?.listFitness !== 'live') return false;
  const screened = Date.parse(e.screenedAt);
  if (!Number.isFinite(screened)) return false;
  const age = now.getTime() - screened;
  return age >= -LIST_CLOCK_SKEW_MS && age <= SANCTIONS_LIST_MAX_AGE_MS;
}

/**
 * Pack 2 review F1 (A1): the settlement.instruct live-list gate's rule, shared
 * with the reconcile stuck-paid heal so the two can never disagree. A
 * real-money instruct is refused when the newest evidence carries a
 * listFitness and is not liveFresh, or is a match (the heal records a match it
 * finds, and that row must never be instructed). No evidence, or evidence
 * without listFitness (written before pack 2), is not refused (the deliberate
 * pre-pack pass-through).
 */
export function instructGateRefuses(newest: ScreeningEvidence | undefined, now: Date): boolean {
  if (newest?.listFitness === undefined) return false;
  return newest.decision === 'match' || !liveFresh(newest, now);
}

/**
 * The roles an earlier screen covered that a screen of `screened` does not.
 * A prior party is covered only when its inputHash is non-null and equals the
 * inputHash of a non-empty name screened now in the same role. Distinct roles,
 * sender first.
 */
export function uncoveredRoles(
  prior: ScreeningEvidence[],
  screened: { senderName: string; recipientNames: string[] },
): Array<'sender' | 'recipient'> {
  const hashesFor = (names: string[]): Set<string> => {
    const out = new Set<string>();
    for (const n of names) {
      if (typeof n !== 'string' || n.trim() === '') continue;
      const h = inputHash(n);
      if (h !== null) out.add(h);
    }
    return out;
  };
  const now = { sender: hashesFor([screened.senderName]), recipient: hashesFor(screened.recipientNames) };
  const uncovered = new Set<'sender' | 'recipient'>();
  for (const e of prior) {
    for (const p of e.parties) {
      if (p.inputHash === null || !now[p.role].has(p.inputHash)) uncovered.add(p.role);
    }
  }
  return (['sender', 'recipient'] as const).filter((r) => uncovered.has(r));
}
