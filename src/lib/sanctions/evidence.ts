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
}

export interface ScreeningEvidence {
  listSource: string;
  listVersion: string;
  listHash: string;
  screenedAt: string;
  decision: SanctionsDecision;
  parties: ScreeningEvidenceParty[];
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
