// Per-destination-country bank-detail field definitions + validation/composition.
//
// This module is the single source of truth for "what bank fields does country X
// need, and how do we validate + compose them into the one payoutDestination
// string the rest of the system masks and stores?" It is SHARED by:
//   • the pay-page form (client) — to render the right inputs per country
//   • the /api/pay route (server) — to re-validate the POSTed fields authoritatively
//
// The mirror of the old prompt's "BANK DETAILS BY COUNTRY" block lives here now.
// Pure, no I/O, fully unit-tested.

import type { CountryCode } from './types';

/**
 * One bank-detail input field for a destination country.
 * - `digits`, when set, requires EXACTLY that many digits (non-digits stripped
 *   before counting, so a UK sort code like "12-34-56" passes the 6-digit rule).
 * - When `digits` is unset the field is free-form (e.g. an IBAN or an account
 *   number whose length varies by bank) and only non-emptiness is enforced.
 */
export interface Field {
  key: string;
  label: string;
  digits?: number;     // exact required digit count (after stripping non-digits)
  isAccount?: boolean; // marks the field that holds the recipient's ACCOUNT number
}

// Field lists mirror the old prompt's "BANK DETAILS BY COUNTRY" block exactly:
//   US  → routing number (9 digits) + account number
//   CA  → transit number + institution number + account number
//   GB  → sort code (6 digits) + account number
//   AE  → IBAN
//   SG  → bank code + account number
//   AU  → BSB code (6 digits) + account number
//   NZ  → account number (bank-branch-account-suffix format)
//   IN  → account number + IFSC code
export const BANK_FIELDS_BY_COUNTRY: Record<CountryCode, Field[]> = {
  US: [
    { key: 'routingNumber', label: 'Routing number', digits: 9 },
    { key: 'accountNumber', label: 'Account number', isAccount: true },
  ],
  CA: [
    { key: 'transitNumber', label: 'Transit number' },
    { key: 'institutionNumber', label: 'Institution number' },
    { key: 'accountNumber', label: 'Account number', isAccount: true },
  ],
  GB: [
    { key: 'sortCode', label: 'Sort code', digits: 6 },
    { key: 'accountNumber', label: 'Account number', isAccount: true },
  ],
  AE: [
    { key: 'iban', label: 'IBAN', isAccount: true },
  ],
  SG: [
    { key: 'bankCode', label: 'Bank code' },
    { key: 'accountNumber', label: 'Account number', isAccount: true },
  ],
  AU: [
    { key: 'bsb', label: 'BSB code', digits: 6 },
    { key: 'accountNumber', label: 'Account number', isAccount: true },
  ],
  NZ: [
    { key: 'accountNumber', label: 'Account number', isAccount: true },
  ],
  IN: [
    { key: 'accountNumber', label: 'Account number', isAccount: true },
    { key: 'ifsc', label: 'IFSC code' },
  ],
};

export type ValidationResult =
  | { ok: true; payoutDestination: string }
  | { ok: false; errors: Record<string, string> };

function digitsOnly(s: string): string {
  return (s ?? '').replace(/\D/g, '');
}

/**
 * Validates the supplied bank fields for a destination country.
 *   • missing/blank required field → per-field error
 *   • fixed-digit field whose digit count differs → per-field error
 * On success returns the single composed payoutDestination string.
 *
 * Unknown country codes are treated as having no fields (everything missing) —
 * fail-safe rather than silently composing a partial string.
 */
export function validatePayoutFields(
  country: CountryCode,
  fields: Record<string, string>,
): ValidationResult {
  const defs = BANK_FIELDS_BY_COUNTRY[country] ?? [];
  const errors: Record<string, string> = {};

  for (const def of defs) {
    const raw = (fields[def.key] ?? '').trim();
    if (raw === '') {
      errors[def.key] = `${def.label} is required.`;
      continue;
    }
    if (typeof def.digits === 'number') {
      const d = digitsOnly(raw);
      if (d.length !== def.digits) {
        errors[def.key] = `${def.label} must be ${def.digits} digits.`;
      }
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, payoutDestination: composePayoutDestination(country, fields) };
}

/**
 * Composes the single payoutDestination string the rest of the system stores and
 * masks. Fields are joined in their declared order with single spaces, trimmed.
 *
 * The account field is appended such that the account number remains the LONGEST
 * run of digits in the string — the rule `accountLast4` (in tools.ts) relies on
 * to find the account regardless of field order. For the supported formats the
 * account is already the longest run (routing/sort/IFSC/BSB codes are shorter or
 * contain letters), so ordinary field-order joining is leak-safe; we keep the
 * account LAST among numeric fields as belt-and-suspenders.
 */
export function composePayoutDestination(
  country: CountryCode,
  fields: Record<string, string>,
): string {
  const defs = BANK_FIELDS_BY_COUNTRY[country] ?? [];
  const nonAccount = defs.filter((d) => !d.isAccount);
  const account = defs.filter((d) => d.isAccount);
  const ordered = [...nonAccount, ...account];
  return ordered
    .map((d) => (fields[d.key] ?? '').trim())
    .filter((v) => v !== '')
    .join(' ')
    .trim();
}

/**
 * Returns the last 4 digits of the ACCOUNT number embedded in a composed
 * payoutDestination string. The account is the LONGEST run of digits (the same
 * rule `accountLast4` in tools.ts relies on) — routing/sort/IFSC/BSB codes are
 * shorter or contain letters, so this never leaks anything but the account tail.
 * Returns '' when the string holds no digits (e.g. a UPI id).
 *
 * NB: distinct from `@/lib/mask`'s `maskLast4`, which takes the last 4 CHARACTERS
 * of a single-field value (gov-ID display). For a multi-field bank string only
 * the longest-digit-run rule is leak-safe, so this lives here next to the
 * composer it pairs with. Pure + dependency-light so any component (server or
 * client) can import it without pulling in the agent machinery.
 */
export function accountLast4(dest: string): string {
  const runs = (dest ?? '').match(/\d+/g);
  if (!runs || runs.length === 0) return '';
  const longest = runs.reduce((a, b) => (b.length > a.length ? b : a));
  return longest.slice(-4);
}

/**
 * Masks a composed payoutDestination for staff/agent views: bank destinations
 * collapse to "****<last4>"; anything with no digits (a UPI id) passes through
 * unchanged. The "****<last4>" form lets compliance search by last-4 while never
 * surfacing the full account, routing/sort/IFSC code, or IBAN body by default.
 */
export function maskAccountDisplay(dest: string): string {
  const l4 = accountLast4(dest);
  return l4 ? `****${l4}` : (dest ?? '');
}
