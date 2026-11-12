// corridor-register: Fix pack 8 (R36, D10, P23, P27): the per-partner
// destination register (table partner_corridors, 0042). A platform admin
// records a row from the partner's signed attestation (ref + sha256, no
// upload); every platform save clears the partner's attestation; the partner
// admin attests the pc1 row hash in the app. A row is ACTIVE iff status
// active, attested hash = current row hash, and today < reattest_due. Keyed by
// DESTINATION; partners.corridor_compliance stays the SOURCE-keyed platform
// rule. Server only (node:crypto). No I/O. Never throws.
//
// No 'use client' file may import this module (tests/corridor-register.test.ts).
import { createHash } from 'node:crypto';
import * as z from 'zod';
import { stableJson } from './ai-provenance';
import { isSupportedDestination } from './destination-country';
import { TRANSFER_PURPOSES } from './purpose-codes';
import { TRAVEL_RULE_DOB_FROM_USD, TRAVEL_RULE_FULL_FROM_USD } from './travel-rule';
import type { CountryCode, PartnerId, TransferPurpose } from './types';

export const CORRIDOR_STATUSES = Object.freeze(['active', 'suspended', 'closed'] as const);
export type CorridorStatus = (typeof CORRIDOR_STATUSES)[number];

/** IN-MTSS-v1 is the India pack (D11): accepted only on an IN row. */
export const RULE_PACKS = Object.freeze(['IN-MTSS-v1'] as const);
export type RulePack = (typeof RULE_PACKS)[number];

export const CORRIDOR_ROW_HASH_VERSION = 'pc1';
export const REATTEST_REMINDER_DAYS = 14;
const MAX_PURPOSE_CODES = 8;

export interface CorridorInput {
  destinationCountry: CountryCode;
  status: CorridorStatus;
  rulePack: RulePack | null;
  purposeCodeMap: Partial<Record<TransferPurpose, string>>;
  attestationRef: string;
  attestationSha256: string | null;
  recipientNotices: boolean;
  travelDobFromUsd: number | null;
  travelFullFromUsd: number | null;
  reattestDue: string;
}

export interface CorridorRow extends CorridorInput {
  partnerId: PartnerId;
  recordedBy: string;
  recordedAt: string;
  attestedBy: string | null;
  attestedAt: string | null;
  attestedHash: string | null;
}

/** The UTC calendar day of `now` (YYYY-MM-DD); identical to licence-matrix's. */
function utcToday(now: Date): string {
  return now.toISOString().slice(0, 10);
}

const PURPOSE_SET: ReadonlySet<string> = new Set<string>(TRANSFER_PURPOSES);
const PURPOSE_CODE = /^[A-Z0-9]{2,8}$/;

/** A plain object whose own keys are TransferPurposes and values purpose codes; <= 8 entries. */
const purposeCodeMapSchema = z.custom<Partial<Record<TransferPurpose, string>>>((v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  const keys = Reflect.ownKeys(v);
  if (keys.length > MAX_PURPOSE_CODES) return false;
  return keys.every((k) => {
    if (typeof k !== 'string' || !PURPOSE_SET.has(k)) return false;
    const val = (v as Record<string, unknown>)[k];
    return typeof val === 'string' && PURPOSE_CODE.test(val);
  });
});

/** null, or a finite number > 0, <= max, with at most 2 decimals (tighten only, P28). */
const band = (max: number) =>
  z
    .number()
    .nullable()
    .refine((n) => n === null || (Number.isFinite(n) && n > 0 && n <= max && Math.round(n * 100) / 100 === n));

// YYYY-MM-DD and a real calendar date.
const dateOnly = z.string().refine((s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00.000Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
});

const inputSchema = z
  .object({
    destinationCountry: z.string().refine((c) => isSupportedDestination(c)),
    status: z.enum(CORRIDOR_STATUSES),
    rulePack: z.enum(RULE_PACKS).nullable(),
    purposeCodeMap: purposeCodeMapSchema,
    attestationRef: z.string().regex(/^[A-Za-z0-9._/-]{1,64}$/),
    attestationSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    recipientNotices: z.boolean(),
    travelDobFromUsd: band(TRAVEL_RULE_DOB_FROM_USD),
    travelFullFromUsd: band(TRAVEL_RULE_FULL_FROM_USD),
    reattestDue: dateOnly,
  })
  .strict()
  .refine((i) => i.rulePack === null || i.destinationCountry === 'IN');

/** The platform action's bounded input parser. Never throws. */
export function parseCorridorInput(v: unknown, now: Date = new Date()): CorridorInput | { error: 'invalid' } {
  try {
    const r = inputSchema.safeParse(v);
    if (!r.success) return { error: 'invalid' };
    if (!(r.data.reattestDue > utcToday(now))) return { error: 'invalid' };
    const d = r.data;
    // A fresh map of own entries only (never the caller's object).
    const purposeCodeMap: Partial<Record<TransferPurpose, string>> = {};
    for (const p of TRANSFER_PURPOSES) {
      if (Object.hasOwn(d.purposeCodeMap, p)) purposeCodeMap[p] = d.purposeCodeMap[p];
    }
    return {
      destinationCountry: d.destinationCountry as CountryCode,
      status: d.status,
      rulePack: d.rulePack,
      purposeCodeMap,
      attestationRef: d.attestationRef,
      attestationSha256: d.attestationSha256,
      recipientNotices: d.recipientNotices,
      travelDobFromUsd: d.travelDobFromUsd,
      travelFullFromUsd: d.travelFullFromUsd,
      reattestDue: d.reattestDue,
    };
  } catch {
    return { error: 'invalid' };
  }
}

/** 'pc1:' + sha256 hex of stableJson(every recorded field except recordedAt and attested*). */
export function corridorRowHash(r: CorridorRow): string {
  const obj = {
    partnerId: r.partnerId,
    destinationCountry: r.destinationCountry,
    status: r.status,
    rulePack: r.rulePack,
    purposeCodeMap: r.purposeCodeMap,
    attestationRef: r.attestationRef,
    attestationSha256: r.attestationSha256,
    recipientNotices: r.recipientNotices,
    travelDobFromUsd: r.travelDobFromUsd,
    travelFullFromUsd: r.travelFullFromUsd,
    reattestDue: r.reattestDue,
    recordedBy: r.recordedBy,
  };
  return `${CORRIDOR_ROW_HASH_VERSION}:${createHash('sha256').update(stableJson(obj), 'utf8').digest('hex')}`;
}

/** D10: status active AND the attestation matches the current row hash AND today < reattestDue. */
export function corridorActive(r: CorridorRow | null | undefined, now: Date): boolean {
  try {
    return (
      !!r &&
      r.status === 'active' &&
      r.attestedHash !== null &&
      r.attestedHash === corridorRowHash(r) &&
      utcToday(now) < r.reattestDue
    );
  } catch {
    return false;
  }
}

/** P26: an active-status row from REATTEST_REMINDER_DAYS calendar days before its due date (and after). */
export function reattestReminderDue(r: CorridorRow, now: Date): boolean {
  try {
    if (r.status !== 'active') return false;
    const due = Date.parse(`${r.reattestDue}T00:00:00Z`);
    if (Number.isNaN(due)) return false;
    const remindFrom = new Date(due - REATTEST_REMINDER_DAYS * 86_400_000).toISOString().slice(0, 10);
    return utcToday(now) >= remindFrom;
  } catch {
    return false;
  }
}

/** The stored travel band; undefined for no row. No defaulting (T40 takes the minimum with the code default). */
export function travelBandOf(
  r: CorridorRow | null | undefined,
): { dobFromUsd: number | null; fullFromUsd: number | null } | undefined {
  if (!r) return undefined;
  return { dobFromUsd: r.travelDobFromUsd, fullFromUsd: r.travelFullFromUsd };
}

/** The mapped purpose code, or null. Never a fallback such as SUGGESTED_RBI_CODE (D11 d). */
export function purposeCodeFor(r: CorridorRow | null | undefined, p: TransferPurpose | null | undefined): string | null {
  if (!r || !p) return null;
  const map = r.purposeCodeMap;
  if (!map || typeof map !== 'object' || !Object.hasOwn(map, p)) return null;
  const code = map[p];
  return typeof code === 'string' ? code : null;
}

export type CorridorDecision = 'allowed' | 'corridor_closed';

/** P27: certified owners only; a failed read or an inactive row closes the corridor. */
export function corridorDecision(i: {
  certified: boolean;
  row: CorridorRow | null;
  readFailed: boolean;
  now: Date;
}): CorridorDecision {
  if (!i.certified) return 'allowed';
  if (i.readFailed || !corridorActive(i.row, i.now)) return 'corridor_closed';
  return 'allowed';
}
