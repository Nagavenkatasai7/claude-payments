// travel-rule — fix pack 5 (R38, P18): which originator data a real-money
// transfer needs, and the checks on the values a customer types.
//
// Code defaults until PR8 adds per-partner bands; counsel confirms them before
// merge. amountUsd is the PRINCIPAL in USD, the number the $2,999 cap uses
// (src/lib/transfer-create.ts, the mint cap on round(q.amountUsd * 100)).
// Every use is gated on realMoneyRail by the caller: this module never decides
// whether a row is real money.
//
// Pure: type-only imports from ./types, plus the pure send-limits and
// untrusted-text helpers. Never throws.
import type { CountryCode } from './types';
import { PLATFORM_SEND_LIMITS } from './send-limits';
import { hasWebAddress, isBoundedPrintable } from './untrusted-text';

/** From this principal (USD) the date of birth is asked for the DOB_DESTINATIONS. */
export const TRAVEL_RULE_DOB_FROM_USD = 1000;
/** From this principal (USD) the date of birth is asked for every destination. */
export const TRAVEL_RULE_FULL_FROM_USD = 3000;
/** Destinations that ask the date of birth from TRAVEL_RULE_DOB_FROM_USD. */
export const DOB_DESTINATIONS: readonly CountryCode[] = Object.freeze([
  'DE', 'FR', 'NL', 'IE', 'IT', 'ES', 'AT', 'BE', 'GB', 'CA', 'AU', 'SG', 'NZ', 'HK',
] as CountryCode[]);

export interface TravelRuleRequirement {
  band: 'address' | 'address_dob';
  address: true;
  dateOfBirth: boolean;
}

/** The address always; the date of birth from $3,000, or from $1,000 to a DOB destination. */
export function travelRuleRequirement(i: {
  destinationCountry: CountryCode | null | undefined;
  amountUsd: number;
}): TravelRuleRequirement {
  const a = Number.isFinite(i.amountUsd) ? i.amountUsd : 0;
  const dob =
    a >= TRAVEL_RULE_FULL_FROM_USD ||
    (a >= TRAVEL_RULE_DOB_FROM_USD && !!i.destinationCountry && DOB_DESTINATIONS.includes(i.destinationCountry));
  return { band: dob ? 'address_dob' : 'address', address: true, dateOfBirth: dob };
}

/** True when a field the requirement asks for is not on file. */
export function originatorDataMissing(
  req: TravelRuleRequirement,
  onFile: { address: boolean; dateOfBirth: boolean },
): boolean {
  return (req.address && !onFile.address) || (req.dateOfBirth && !onFile.dateOfBirth);
}

/** A per-transfer limit above the $2,999 platform cap on a real-money owner needs the sender's address on file. */
export function limitRaiseNeedsAddress(i: {
  perTransferCapCents: number;
  ownerRealMoney: boolean;
  addressOnFile: boolean;
}): boolean {
  return i.perTransferCapCents > PLATFORM_SEND_LIMITS.perTransferCapCents && i.ownerRealMoney && !i.addressOnFile;
}

export const LIMIT_NEEDS_ADDRESS_COPY = "Capture the sender's address first: limits above $2,999 need it on file.";

const ADDRESS_MIN = 5;
const ADDRESS_MAX = 300;

/**
 * Review round 2 (GB3): the web-address TLD list endings that are also a US state code
 * or "us" / "in" ("Denver.CO 80202", "Indianapolis.IN 46204"). For the address only, a
 * single label followed by one of these, then the end, a space or punctuation other than
 * "/", ":", "." or "-", is read as an address; the dot becomes a space before the
 * web-address check. A scheme, "www.", an IPv4 address, a path or port ("evil.co/a",
 * "evil.co:80"), a dotted chain ("pay.evil.co"), an email ("a@evil.co") and every other
 * ending are still refused. Known limit: a bare "name.co" is accepted in an address.
 */
const ADDRESS_CLASHING_ENDING =
  /(?<![\p{L}\p{N}.@/:-])([\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?)\.(ca|co|de|in|me|us)(?![\p{L}\p{N}./:-])/giu;

/** The sender's address as typed: trimmed, 5..300 characters on one line, printable, no web address. */
export function validateSenderAddress(v: string): { ok: true; value: string } | { ok: false } {
  if (typeof v !== 'string') return { ok: false };
  const s = v.trim();
  const len = [...s].length;
  if (len < ADDRESS_MIN || len > ADDRESS_MAX) return { ok: false };
  if (!isBoundedPrintable(s, ADDRESS_MAX) || hasWebAddress(s.replace(ADDRESS_CLASHING_ENDING, '$1 $2'))) {
    return { ok: false };
  }
  return { ok: true, value: s };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DOB_MIN_AGE = 18;
const DOB_MAX_AGE = 120;

/** YYYY-MM-DD and a real calendar date (the live-controls rule; a local copy, that module reads the DB). */
function isCalendarDate(s: string): boolean {
  if (!DATE_ONLY.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00.000Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/** The sender's date of birth: strict YYYY-MM-DD (no trim), a real date, 18..120 whole years old at `now` (UTC). */
export function validateSenderDob(v: string, now: Date): { ok: true; value: string } | { ok: false } {
  if (typeof v !== 'string' || !isCalendarDate(v)) return { ok: false };
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return { ok: false };
  const [y, m, d] = v.split('-').map(Number);
  const ny = now.getUTCFullYear();
  const nm = now.getUTCMonth() + 1;
  const nd = now.getUTCDate();
  const age = ny - y - (nm < m || (nm === m && nd < d) ? 1 : 0);
  return age >= DOB_MIN_AGE && age <= DOB_MAX_AGE ? { ok: true, value: v } : { ok: false };
}
