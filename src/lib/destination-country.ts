// Program-Fix 33: the ONE destination-country authority.
//
// Every runtime valid-code set (the chat tools, the partner API, the pay route)
// and every tool-schema list derives from the keys of DEFAULT_CURRENCY_FOR_COUNTRY
// — nothing is hand-typed, so a corridor added in types.ts is supported
// everywhere at once (the audit found the chat validator knew 8 of the 10).
//
// An unknown destination is an ERROR (`null`), never India: the pre-fix
// coercion turned a Mexico or Hong Kong send into an INR quote, an IN draft and
// the India rail. An ABSENT destination is `undefined` — the caller decides the
// back-compat default (get_quote keeps IN; the card and mint paths guard it).
import type { CountryCode } from './types';
import { DEFAULT_CURRENCY_FOR_COUNTRY } from './types';

export const SUPPORTED_DESTINATIONS = Object.keys(DEFAULT_CURRENCY_FOR_COUNTRY) as CountryCode[];

const SUPPORTED_SET: ReadonlySet<string> = new Set<string>(SUPPORTED_DESTINATIONS);

/**
 * Absent (undefined / null) or blank ⇒ `undefined`. A supported code, in any
 * case and with surrounding whitespace ⇒ that CountryCode. Anything else —
 * an unknown code, a country name, a currency code, a non-string ⇒ `null`.
 */
export function parseDestinationCountry(value: unknown): CountryCode | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  if (code === '') return undefined;
  return SUPPORTED_SET.has(code) ? (code as CountryCode) : null;
}

/** True for a supported ISO code exactly as stored (upper-case). */
export function isSupportedDestination(code: string): code is CountryCode {
  return SUPPORTED_SET.has(code);
}

/** The supported codes as "US, CA, …" — for schema descriptions and error copy. */
export function destinationListText(): string {
  return SUPPORTED_DESTINATIONS.join(', ');
}

/** The name the bot uses for each supported country (plain English, short forms the customers use). */
export const COUNTRY_NAMES: Record<CountryCode, string> = {
  US: 'US',
  CA: 'Canada',
  GB: 'UK',
  AE: 'UAE',
  SG: 'Singapore',
  AU: 'Australia',
  NZ: 'New Zealand',
  IN: 'India',
  HK: 'Hong Kong',
  MX: 'Mexico',
  DE: 'Germany',
  FR: 'France',
  NL: 'Netherlands',
  IE: 'Ireland',
  IT: 'Italy',
  ES: 'Spain',
  AT: 'Austria',
  BE: 'Belgium',
};

export const SUPPORTED_COUNTRY_COUNT = SUPPORTED_DESTINATIONS.length;

const NAMES = SUPPORTED_DESTINATIONS.map((c) => COUNTRY_NAMES[c]);

/** "US, Canada, UK, …, Belgium" */
export const SUPPORTED_COUNTRY_NAMES = NAMES.join(', ');

/** "US, Canada, …, Austria, and Belgium" */
export const SUPPORTED_COUNTRY_NAMES_AND = `${NAMES.slice(0, -1).join(', ')}, and ${NAMES[NAMES.length - 1]}`;
