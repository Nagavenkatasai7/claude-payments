// licence-matrix: Fix pack 8 (R12, D7, D9, P17): the licence matrix stored at
// live_controls.licence (T22). A platform admin records it from the partner's
// evidence; a partner admin attests it (lm1 hash, T24); every platform save
// drops the attestation. licenceDecision is THE decision of every licence gate
// and runs only for a certified owner (D1); effectiveResidence is THE residence
// rule its callers pass (a stored staff_verified state wins). Server only
// (node:crypto, the disclosure-hash approach). No I/O. Never throws.
//
// Layout: the first half (codes, sources, types, the parser, isActiveOn,
// utcToday) is pure and free of node:crypto; T22 moves it verbatim into the
// client-safe licence-matrix-parse.ts and re-exports it from here. The second
// half (the hash and everything that needs it) stays server only. No
// 'use client' file may import this module (tests/licence-matrix.test.ts).
import { createHash } from 'node:crypto';
import * as z from 'zod';
import { stableJson } from './ai-provenance';
import { isSupportedDestination } from './destination-country';
import type { CountryCode } from './types';

// ---------------------------------------------------------------------------
// Pure half (T22 moves this verbatim into licence-matrix-parse.ts)
// ---------------------------------------------------------------------------

/** The 50 states, DC and the five inhabited territories, sorted A-Z (56 codes). */
export const US_STATE_CODES = Object.freeze([
  'AK', 'AL', 'AR', 'AS', 'AZ', 'CA', 'CO', 'CT', 'DC', 'DE',
  'FL', 'GA', 'GU', 'HI', 'IA', 'ID', 'IL', 'IN', 'KS', 'KY',
  'LA', 'MA', 'MD', 'ME', 'MI', 'MN', 'MO', 'MP', 'MS', 'MT',
  'NC', 'ND', 'NE', 'NH', 'NJ', 'NM', 'NV', 'NY', 'OH', 'OK',
  'OR', 'PA', 'PR', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VA',
  'VI', 'VT', 'WA', 'WI', 'WV', 'WY',
] as const);
export type UsStateCode = (typeof US_STATE_CODES)[number];

const US_STATE_SET: ReadonlySet<string> = new Set<string>(US_STATE_CODES);

/** Own-value check against the closed list ('__proto__', 'toString', lower case: false). */
export function isUsStateCode(v: unknown): v is UsStateCode {
  return typeof v === 'string' && US_STATE_SET.has(v);
}

/** Where a customer's state of residence came from. 'kyc_vendor' is RESERVED: accepted, never written (D8). */
export const RESIDENCE_SOURCES = Object.freeze(['kyc_vendor', 'partner_attested', 'staff_verified'] as const);
export type ResidenceSource = (typeof RESIDENCE_SOURCES)[number];

const RESIDENCE_SOURCE_SET: ReadonlySet<string> = new Set<string>(RESIDENCE_SOURCES);

export function isResidenceSource(v: unknown): v is ResidenceSource {
  return typeof v === 'string' && RESIDENCE_SOURCE_SET.has(v);
}

export const LICENCE_MATRIX_VERSION = 'lm1';
export const LICENCE_MAX_STATES = 60;
export const LICENCE_MAX_ORIGINS = 20;

export interface LicenceState {
  code: UsStateCode;
  licenceRef: string;
  effectiveFrom: string;
  expiresAt: string;
}
export interface LicenceOrigin {
  country: CountryCode;
  effectiveFrom: string;
  expiresAt?: string;
}
export interface LicenceAttestation {
  by: string;
  at: string;
  hash: string;
}
export interface LicenceMatrix {
  version: 1;
  states: LicenceState[];
  origins: LicenceOrigin[];
  evidenceRef: string;
  recordedBy: string;
  recordedAt: string;
  attestation?: LicenceAttestation;
}

const MAX_TEXT = 200;
const ref = z.string().regex(/^[A-Za-z0-9._/-]{1,64}$/);
const text = z.string().min(1).max(MAX_TEXT);
const timestamp = z
  .string()
  .max(MAX_TEXT)
  .refine((s) => !Number.isNaN(Date.parse(s)));
// YYYY-MM-DD and a real calendar date (the rule of live-controls.ts dateOnly).
const dateOnly = z.string().refine((s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00.000Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
});

const stateSchema = z
  .object({
    code: z.enum(US_STATE_CODES),
    licenceRef: ref,
    effectiveFrom: dateOnly,
    expiresAt: dateOnly,
  })
  .strict()
  .refine((s) => s.effectiveFrom < s.expiresAt);

const originSchema = z
  .object({
    country: z.string().refine((c) => isSupportedDestination(c)),
    effectiveFrom: dateOnly,
    expiresAt: dateOnly.optional(),
  })
  .strict()
  .refine((o) => o.expiresAt === undefined || o.effectiveFrom < o.expiresAt);

const attestationSchema = z
  .object({
    by: text,
    at: timestamp,
    hash: z.string().regex(/^lm1:[a-f0-9]{64}$/),
  })
  .strict();

const matrixSchema = z
  .object({
    version: z.literal(1),
    states: z.array(stateSchema).max(LICENCE_MAX_STATES),
    origins: z.array(originSchema).max(LICENCE_MAX_ORIGINS),
    evidenceRef: ref,
    recordedBy: text,
    recordedAt: timestamp,
    attestation: attestationSchema.optional(),
  })
  .strict()
  .refine((m) => new Set(m.states.map((s) => s.code)).size === m.states.length)
  .refine((m) => new Set(m.origins.map((o) => o.country)).size === m.origins.length);

/** The stored matrix, or undefined when malformed (the key then reads as absent: fail closed). Never throws. */
export function parseLicenceMatrix(v: unknown): LicenceMatrix | undefined {
  try {
    const r = matrixSchema.safeParse(v);
    return r.success ? (r.data as LicenceMatrix) : undefined;
  } catch {
    return undefined;
  }
}

/** The UTC calendar day of `now` (YYYY-MM-DD). */
export function utcToday(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** effectiveFrom <= today < expiresAt (YYYY-MM-DD string compare; expires today = inactive). */
export function isActiveOn(e: { effectiveFrom: string; expiresAt?: string }, today: string): boolean {
  return e.effectiveFrom <= today && (e.expiresAt === undefined || today < e.expiresAt);
}

// ---------------------------------------------------------------------------
// Server-only half (node:crypto)
// ---------------------------------------------------------------------------

/** 'lm1:' + sha256 hex of stableJson(matrix without attestation): key order never changes it, array order does. */
export function licenceMatrixHash(m: LicenceMatrix): string {
  const { attestation: _attestation, ...rest } = m;
  void _attestation;
  return `${LICENCE_MATRIX_VERSION}:${createHash('sha256').update(stableJson(rest), 'utf8').digest('hex')}`;
}

/** True when the matrix carries a partner attestation of exactly its current content. */
export function matrixAttested(m: LicenceMatrix | undefined | null): boolean {
  try {
    return !!m?.attestation && m.attestation.hash === licenceMatrixHash(m);
  } catch {
    return false;
  }
}

/** Readiness (critic R8): attested, >= 1 active origin, and when US is an active origin >= 1 active state. */
export function licenceMatrixReady(m: LicenceMatrix | undefined | null, now: Date): boolean {
  if (!m || !matrixAttested(m)) return false;
  const today = utcToday(now);
  const activeOrigins = m.origins.filter((o) => isActiveOn(o, today));
  if (activeOrigins.length === 0) return false;
  if (!activeOrigins.some((o) => o.country === 'US')) return true;
  return m.states.some((s) => isActiveOn(s, today));
}

type Residence = { state: string; source: string };

/** THE residence rule: a stored staff_verified state wins; else requested ?? stored ?? null. Does not validate. */
export function effectiveResidence(
  stored: Residence | null | undefined,
  requested: Residence | null | undefined,
): Residence | null {
  if (stored?.source === 'staff_verified') return stored;
  return requested ?? stored ?? null;
}

export type LicenceDecision = 'allowed' | 'not_licensed' | 'state_unverified' | 'unavailable';

/** THE licence decision of every gate (D9). First match wins; uncertified reads nothing else. */
export function licenceDecision(i: {
  certified: boolean;
  matrix: LicenceMatrix | undefined | null;
  readFailed: boolean;
  sourceCountry: CountryCode;
  residence: Residence | null | undefined;
  now: Date;
}): LicenceDecision {
  if (!i.certified) return 'allowed';
  try {
    const matrix = i.matrix;
    if (i.readFailed || !matrix || !matrixAttested(matrix)) return 'unavailable';
    const today = utcToday(i.now);
    if (!matrix.origins.some((o) => o.country === i.sourceCountry && isActiveOn(o, today))) return 'not_licensed';
    if (i.sourceCountry !== 'US') return 'allowed';
    const r = i.residence;
    if (!r || !isResidenceSource(r.source) || !isUsStateCode(r.state)) return 'state_unverified';
    if (!matrix.states.some((s) => s.code === r.state && isActiveOn(s, today))) return 'not_licensed';
    return 'allowed';
  } catch {
    return 'unavailable';
  }
}
