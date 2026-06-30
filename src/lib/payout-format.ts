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
 * - `pattern`, when set, requires the trimmed raw value to match the RegExp
 *   (used for IFSC / IBAN shape checks). `patternMessage` is the per-field error.
 * - `minDigits`, when set, requires at least that many digits after stripping
 *   non-digits (used for free-form account numbers so "12345"/"X" are rejected
 *   while real 8-digit US / hyphenated NZ / 9–18-digit IN accounts pass).
 * - When none of `digits` / `pattern` / `minDigits` is set the field is purely
 *   free-form and only non-emptiness is enforced.
 */
export interface Field {
  key: string;
  label: string;
  digits?: number;        // exact required digit count (after stripping non-digits)
  pattern?: RegExp;       // format the trimmed value must match (IFSC / IBAN)
  patternMessage?: string;// per-field error shown when `pattern` does not match
  minDigits?: number;     // minimum digit count (after stripping non-digits)
  isAccount?: boolean;    // marks the field that holds the recipient's ACCOUNT number
}

// Shared format rules (kept module-level so the field defs read cleanly):
//   IFSC  → 4 letters, a literal "0", then 6 alphanumerics — 11 chars total.
//   IBAN  → 2 letters + 2 check digits + 11–30 alphanumerics — 15–34 chars total.
// Both are intentionally permissive (no checksum / country-table validation);
// they exist to stop obviously-garbage values ("X", "HDFC123") reaching a
// payable Step 2, not to be a full IBAN/IFSC verifier.
const IFSC_PATTERN = /^[A-Za-z]{4}0[A-Za-z0-9]{6}$/;
const IBAN_PATTERN = /^[A-Za-z]{2}[0-9]{2}[A-Za-z0-9]{11,30}$/;
// Free-form account numbers must carry at least this many digits after stripping
// separators — rejects "12345" / "X" while passing every supported real format.
const ACCOUNT_MIN_DIGITS = 6;

// Field lists mirror the old prompt's "BANK DETAILS BY COUNTRY" block exactly:
//   US  → routing number (9 digits) + account number
//   CA  → transit number + institution number + account number
//   GB  → sort code (6 digits) + account number
//   AE  → IBAN
//   SG  → bank code + account number
//   AU  → BSB code (6 digits) + account number
//   NZ  → account number (bank-branch-account-suffix format)
//   IN  → account number + IFSC code
const ACCOUNT_FIELD: Field = {
  key: 'accountNumber',
  label: 'Account number',
  isAccount: true,
  minDigits: ACCOUNT_MIN_DIGITS,
};

export const BANK_FIELDS_BY_COUNTRY: Record<CountryCode, Field[]> = {
  US: [
    { key: 'routingNumber', label: 'Routing number', digits: 9 },
    { ...ACCOUNT_FIELD },
  ],
  CA: [
    { key: 'transitNumber', label: 'Transit number' },
    { key: 'institutionNumber', label: 'Institution number' },
    { ...ACCOUNT_FIELD },
  ],
  GB: [
    { key: 'sortCode', label: 'Sort code', digits: 6 },
    { ...ACCOUNT_FIELD },
  ],
  AE: [
    {
      key: 'iban',
      label: 'IBAN',
      isAccount: true,
      pattern: IBAN_PATTERN,
      patternMessage: 'Enter a valid IBAN (2 letters, 2 digits, then 11–30 characters).',
    },
  ],
  SG: [
    { key: 'bankCode', label: 'Bank code' },
    { ...ACCOUNT_FIELD },
  ],
  AU: [
    { key: 'bsb', label: 'BSB code', digits: 6 },
    { ...ACCOUNT_FIELD },
  ],
  NZ: [
    { ...ACCOUNT_FIELD },
  ],
  IN: [
    { ...ACCOUNT_FIELD },
    {
      key: 'ifsc',
      label: 'IFSC code',
      pattern: IFSC_PATTERN,
      patternMessage: 'Enter a valid 11-character IFSC code (e.g. HDFC0001234).',
    },
  ],
  HK: [
    { key: 'bankCode', label: 'Bank code', digits: 3 },
    { key: 'branchCode', label: 'Branch code', digits: 3 },
    { ...ACCOUNT_FIELD },
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
    // Exact-digit fields (routing 9 / sort 6 / BSB 6) — unchanged.
    if (typeof def.digits === 'number') {
      const d = digitsOnly(raw);
      if (d.length !== def.digits) {
        errors[def.key] = `${def.label} must be ${def.digits} digits.`;
      }
      continue;
    }
    // Format-pattern fields (IFSC / IBAN): the whole trimmed value must match.
    if (def.pattern && !def.pattern.test(raw)) {
      errors[def.key] = def.patternMessage ?? `${def.label} is not valid.`;
      continue;
    }
    // Free-form account numbers: require a sensible minimum of real digits so
    // "12345" / "X" are rejected while 8-digit US / hyphenated NZ / 9–18-digit
    // IN accounts pass (separators are stripped before counting).
    if (typeof def.minDigits === 'number') {
      const d = digitsOnly(raw);
      if (d.length < def.minDigits) {
        errors[def.key] = `${def.label} must have at least ${def.minDigits} digits.`;
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
 * The account field is appended LAST so the account number is the LAST run of
 * digits in the string — the rule `accountLast4` relies on to find the account
 * regardless of the per-country field order. Keeping the account last is what
 * makes the masked dashboard / approve-card tail point at the account (not the
 * routing/sort/IFSC/BSB code) in every supported format.
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
 * payoutDestination string. `composePayoutDestination` always places the account
 * field LAST, so the account is the LAST run of digits in the string — we take
 * that run's tail. (The previous LONGEST-run rule mis-targeted the routing for
 * US routing(9)+account(8), surfacing the routing tail on the dashboard.)
 * Either way only ≤4 digits are ever returned, so the result stays leak-proof.
 * Returns '' when the string holds no digits (e.g. a UPI id).
 *
 * NB: distinct from `@/lib/mask`'s `maskLast4`, which takes the last 4 CHARACTERS
 * of a single-field value (gov-ID display). For a multi-field bank string the
 * account is composed last, so the last-digit-run rule is both correct and
 * leak-safe; this lives here next to the composer it pairs with. Pure +
 * dependency-light so any component (server or client) can import it without
 * pulling in the agent machinery.
 */
export function accountLast4(dest: string): string {
  const runs = (dest ?? '').match(/\d+/g);
  if (!runs || runs.length === 0) return '';
  const last = runs[runs.length - 1];
  return last.slice(-4);
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
