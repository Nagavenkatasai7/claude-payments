// corridor-pack: Fix pack 8 (R36, D11, P30): corridor rule packs. One pack
// today, IN-MTSS-v1, applied only for a certified owner whose ACTIVE register
// row for IN names it (Q-R36.3). Values are DRAFTS until counsel's India memo
// (R37): valuesVersion is stamped. The cap folds into SendLimits (existing cap
// arm and text); the per-beneficiary count runs inside the sender lock (T44b)
// with two-int advisory locks of class 8042, after the sender lock and before
// the rewards budget lock; a purpose is allowed only when listed AND mapped by
// the partner (no fallback code). No I/O.
//
// Server only by inheritance (corridor-register.ts uses node:crypto). No
// 'use client' file may import this module (tests/corridor-pack.test.ts).
import { corridorActive, purposeCodeFor, type CorridorRow, type RulePack } from './corridor-register';
import type { CountryCode, PartnerId, SendLimits, TransferPurpose } from './types';

export const IN_MTSS_V1 = Object.freeze({
  id: 'IN-MTSS-v1',
  valuesVersion: 'in-mtss-v1-2026-11-draft',
  perRemittanceCapCents: 250_000,
  perBeneficiaryYearCount: 30,
  allowedPurposes: Object.freeze(['family_support', 'gift', 'education', 'medical', 'savings'] as const),
  yearUtcOffsetMinutes: 330,
} as const); // draft until counsel's India memo (R37)

export type CorridorPack = typeof IN_MTSS_V1;

export const CORRIDOR_PACKS: Readonly<Record<RulePack, CorridorPack>> = Object.freeze({ 'IN-MTSS-v1': IN_MTSS_V1 });

export const CORRIDOR_REFUSAL_CODES = Object.freeze(['beneficiary_year_count', 'prohibited_purpose'] as const);
export type CorridorRefusalCode = (typeof CORRIDOR_REFUSAL_CODES)[number];

/** The pack of an ACTIVE IN register row with a rule pack, for an IN destination; else null. Never decides certification. */
export function packFor(row: CorridorRow | null | undefined, destination: CountryCode, now: Date): CorridorPack | null {
  if (!row || !corridorActive(row, now)) return null;
  if (row.destinationCountry !== 'IN' || destination !== 'IN' || row.rulePack === null) return null;
  return Object.hasOwn(CORRIDOR_PACKS, row.rulePack) ? CORRIDOR_PACKS[row.rulePack] : null;
}

/** Tighten only: no pack -> the SAME object; else the per-transfer cap and maxUsd capped by the pack. */
export function packLimits(limits: SendLimits, pack: CorridorPack | null): SendLimits {
  if (pack === null) return limits;
  const perTransferCapCents = Math.min(limits.perTransferCapCents, pack.perRemittanceCapCents);
  return {
    t0DailyCapCents: limits.t0DailyCapCents,
    t1DailyCapCents: limits.t1DailyCapCents,
    perTransferCapCents,
    maxUsd: Math.min(limits.maxUsd, Math.floor(perTransferCapCents / 100)),
  };
}

/** Listed by the pack AND mapped to a code by the partner's register (no fallback code, ever). */
export function purposeAllowed(
  pack: CorridorPack,
  row: CorridorRow | null | undefined,
  p: TransferPurpose | null | undefined,
): boolean {
  if (!p) return false;
  return (pack.allowedPurposes as readonly string[]).includes(p) && purposeCodeFor(row ?? null, p) !== null;
}

const IST_OFFSET_MS = IN_MTSS_V1.yearUtcOffsetMinutes * 60_000;

/** The India-time (fixed +05:30, no DST) calendar year of `now`, half-open [start, end). */
export function istYearBounds(now: Date): { start: Date; end: Date; year: number } {
  const year = new Date(now.getTime() + IST_OFFSET_MS).getUTCFullYear();
  return {
    start: new Date(Date.UTC(year, 0, 1) - IST_OFFSET_MS),
    end: new Date(Date.UTC(year + 1, 0, 1) - IST_OFFSET_MS),
    year,
  };
}

/** First int of pg_advisory_xact_lock(int4, int4): the beneficiary locks' own key space (P31). */
export const BENEFICIARY_LOCK_CLASS = 8042;

/**
 * The owner-bound beneficiary lock keys (0, 1 or 2, order b then p). The
 * strings never leave the transaction: never logged, audited or alerted.
 */
export function beneficiaryKeys(
  owner: PartnerId,
  bidx: string | null | undefined,
  phoneDigits: string | null | undefined,
): string[] {
  const keys: string[] = [];
  const b = typeof bidx === 'string' ? bidx.trim() : '';
  if (b) keys.push(`ben:${owner}:b:${b}`);
  const digits = typeof phoneDigits === 'string' ? phoneDigits.replace(/\D/g, '') : '';
  if (digits) keys.push(`ben:${owner}:p:${digits}`);
  return [...new Set(keys)];
}
