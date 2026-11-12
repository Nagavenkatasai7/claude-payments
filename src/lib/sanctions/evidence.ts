// Sanctions screening evidence (Program-Fix 14, compliance-07).
//
// Every screen now leaves a provable record: which list (source, version,
// hash), when, the decision, and per party a KEYED hash of the screened name
// plus the match score and the list entry id. No name ever enters evidence:
//   • the input is an HMAC-SHA256 over normalizeName(name), keyed by a key
//     derived (HKDF, info 'sanctions-evidence-v1') from FIELD_ENCRYPTION_KEY
//     through decodeMasterKey — the single accepted-key decoder (field-crypto),
//     so hex64 and base64-32 both work. A plain SHA-256 of a name could be
//     brute-forced from a name dictionary, so it is never used. The master key
//     is only READ here, never rotated or changed.
//   • the matched list entry is referenced by id (`mock:<index>` for the mock,
//     whose entries ARE names; the SDN uid for a real list), never by name.

import { createHmac, hkdfSync } from 'node:crypto';
import { decodeMasterKey } from '../field-crypto';
import { env } from '../env';
import { normalizeName } from './normalize';
import type { AuditEvent } from '@/db/repos/aux-repos';
import type { ListFitness } from './list-policy';

/** The sanctions outcome recorded in evidence (distinct from the transfer's compliance status). */
export type SanctionsDecision =
  | 'clear'             // no party matched
  | 'match'             // an exact (normalised / token-set) match → blocked
  | 'possible_match'    // a fuzzy match at/above threshold → flagged for review
  | 'list_unavailable'  // the list failed to load → flagged (fail closed)
  | 'error';            // the screener threw (register_seller records this)

export interface ScreeningEvidenceParty {
  role: 'recipient' | 'sender';
  /** HMAC of the normalised name; null only when no encryption key is configured. */
  inputHash: string | null;
  matched: boolean;
  matchScore: number;
  matchedEntryId?: string;
  /**
   * Fix pack 5 T29 (SANCTIONS_LIST=lists only): this party was NOT screened
   * (its screen failed closed on a partial list set), so matched false /
   * score 0 is not a clear. Absent everywhere else.
   */
  unscreened?: true;
}

/** Fix pack 5 T29 (P26): one list of a SANCTIONS_LIST=lists set, as screened. */
export interface ScreeningEvidenceList {
  source: string;
  version: string;
  hash: string;
  fitness: ListFitness;
  checkedAt?: string;
}

export interface ScreeningEvidence {
  listSource: string;
  listVersion: string;
  listHash: string;
  screenedAt: string;
  decision: SanctionsDecision;
  parties: ScreeningEvidenceParty[];
  /**
   * Fix pack 2 (R02): the list's fitness at screen time (list-policy.ts
   * listFitness); 'not_live' when the list could not load. Absent on evidence
   * written before pack 2 and on errorEvidence.
   */
  listFitness?: ListFitness;
  /** Fix pack 2 (R02): when the list was last confirmed current (ISO), when known. */
  listCheckedAt?: string;
  /** Fix pack 2 (R02): the base list's hash before corridor additions, when known. */
  listBaseHash?: string;
  /**
   * Fix pack 5 T29 (R08, P26): written ONLY under SANCTIONS_LIST=lists, one
   * item per list of the set in floor order. listSource / listVersion keep the
   * composite values and listFitness is the SET fitness. A list that did not
   * answer reads version 'unavailable', hash '', fitness 'not_live' and no
   * checkedAt (it was not checked). Hashes and versions only, never a name.
   */
  lists?: ScreeningEvidenceList[];
}

/** The audit_events row shape every sanctions.screen write uses (actor is NOT NULL, schema.ts). */
export const SANCTIONS_AUDIT_ACTION = 'sanctions.screen';
export const SANCTIONS_AUDIT_ACTOR = 'system:sanctions';

// Only a successfully derived key is cached; a missing key is re-tried.
let cachedKey: Buffer | undefined;

function evidenceKey(): Buffer | null {
  if (cachedKey) return cachedKey;
  try {
    const master = decodeMasterKey(env.fieldEncryptionKey);
    cachedKey = Buffer.from(hkdfSync('sha256', master, '', 'sanctions-evidence-v1', 32));
    return cachedKey;
  } catch {
    // No/invalid key (dev without the secret). Production refuses to boot
    // without FIELD_ENCRYPTION_KEY (boot-assert), so this is dev-only. Screening
    // must never break over evidence, so the hash is simply absent.
    return null;
  }
}

/** Keyed, normalisation-stable hash of a screened name. Never throws. */
export function inputHash(name: string): string | null {
  const key = evidenceKey();
  if (!key) return null;
  return createHmac('sha256', key).update(normalizeName(name), 'utf8').digest('hex');
}

/** Test seam: forget the derived key so a changed FIELD_ENCRYPTION_KEY is re-read. */
export function resetEvidenceKeyForTests(): void {
  cachedKey = undefined;
}

/**
 * The evidence for a screen that could not complete (the screener threw).
 * No party scores: nothing was compared.
 */
export function errorEvidence(now: Date = new Date()): ScreeningEvidence {
  return {
    listSource: 'unknown',
    listVersion: 'unknown',
    listHash: '',
    screenedAt: now.toISOString(),
    decision: 'error',
    parties: [],
  };
}

/**
 * The audit_events row for one screen: action 'sanctions.screen', actor
 * 'system:sanctions' (the column is NOT NULL), actorType 'system', the
 * transfer or seller id as subject, and the evidence as meta.
 */
export function sanctionsAuditEvent(
  partnerId: string,
  subjectId: string,
  evidence: ScreeningEvidence,
): AuditEvent {
  return {
    partnerId,
    actor: SANCTIONS_AUDIT_ACTOR,
    actorType: 'system',
    action: SANCTIONS_AUDIT_ACTION,
    subjectId,
    meta: evidence as unknown as Record<string, unknown>,
  };
}
