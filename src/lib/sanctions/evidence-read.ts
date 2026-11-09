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

import type { DbOrTx } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import type { Transfer } from '@/lib/types';
import {
  inputHash,
  SANCTIONS_AUDIT_ACTION,
  type SanctionsDecision,
  type ScreeningEvidence,
  type ScreeningEvidenceParty,
} from './evidence';
import { LIST_CLOCK_SKEW_MS, SANCTIONS_LIST_MAX_AGE_MS, type ListFitness } from './list-policy';

/** The mint writes its evidence in the mint transaction; this bounds the indexed read below createdAt. */
const BEFORE_CREATED_MS = 10 * 60_000;
/** A row written by a clock slightly ahead of ours is still read. */
const AFTER_NOW_MS = 60_000;

const DECISIONS: readonly SanctionsDecision[] = ['clear', 'match', 'possible_match', 'list_unavailable', 'error'];
const FITNESSES: readonly ListFitness[] = ['live', 'stale', 'not_live'];

function parseParty(v: unknown): ScreeningEvidenceParty | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  if (p.role !== 'recipient' && p.role !== 'sender') return null;
  if (p.inputHash !== null && typeof p.inputHash !== 'string') return null;
  if (typeof p.matched !== 'boolean' || typeof p.matchScore !== 'number') return null;
  if (p.matchedEntryId !== undefined && typeof p.matchedEntryId !== 'string') return null;
  const party: ScreeningEvidenceParty = { role: p.role, inputHash: p.inputHash, matched: p.matched, matchScore: p.matchScore };
  if (typeof p.matchedEntryId === 'string') party.matchedEntryId = p.matchedEntryId;
  return party;
}

/** The evidence in an audit row's meta, or null when any field has the wrong type. */
function parseEvidence(meta: Record<string, unknown>): ScreeningEvidence | null {
  const { listSource, listVersion, listHash, screenedAt, decision, parties, listFitness, listCheckedAt, listBaseHash } = meta;
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
  const parsed: ScreeningEvidenceParty[] = [];
  for (const raw of parties) {
    const p = parseParty(raw);
    if (!p) return null;
    parsed.push(p);
  }
  return {
    listSource,
    listVersion,
    listHash,
    screenedAt,
    decision: decision as SanctionsDecision,
    parties: parsed,
    ...(listFitness !== undefined ? { listFitness: listFitness as ListFitness } : {}),
    ...(typeof listCheckedAt === 'string' ? { listCheckedAt } : {}),
    ...(typeof listBaseHash === 'string' ? { listBaseHash } : {}),
  };
}

/**
 * The transfer's sanctions.screen evidence, OWNER tenant, written in
 * [createdAt - 10 min, now + 1 min), oldest first. Malformed rows are skipped.
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
  const rows = await createAuditRepo(db).listBySubject(
    t.partnerId,
    t.id,
    new Date(created - BEFORE_CREATED_MS),
    new Date(now.getTime() + AFTER_NOW_MS),
  );
  const out: ScreeningEvidence[] = [];
  for (const row of rows) {
    if (row.action !== SANCTIONS_AUDIT_ACTION) continue;
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
