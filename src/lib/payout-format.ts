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
  MX: [
    // The standard 18-digit Mexican interbank account number (CLABE).
    { key: 'clabe', label: 'CLABE', digits: 18, isAccount: true },
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

// ── Display placeholders are never payout accounts (fix 6 / ctx-01) ─────────
//
// Default ledger reads (mappers.rowToTransfer), the LLM-facing tool results
// (tools.maskAccount), the approve card (tools.maskDestination) and staff views
// (maskAccountDisplay) render a destination as a "****<last4>" mask. The audit
// found that string minted, written over a saved recipient's real account and
// sent to the partner rail. isMaskedDestination is the BACKSTOP every money
// chokepoint uses (pay-finalize, createTransfer, pay route + page, partner-API
// edge, rail instruction). The DEFENSE is structural: no chat tool reads a
// model-supplied destination at all.
//
// '' is deliberately NOT masked: an empty destination means "collect on the
// secure pay page" (Item 2), and each caller decides what '' means for it.

/** Cold-start text for the approve card's "To:" line (moved from tools.ts, which re-exports it). */
export const NO_BANK_DETAILS_PLACEHOLDER =
  "their bank account (you'll enter the details on the secure page)";

/** What tools.maskAccount renders for a bank destination that holds no digits. */
export const ACCOUNT_ON_FILE_PLACEHOLDER = 'account on file';

/** Three or more mask glyphs in a row: asterisk, bullet, black circle. No legal destination contains one. */
const MASK_RUN = /[*•●]{3,}/;

/**
 * True when `dest` is display text rather than a payout account: anything that
 * contains a mask-glyph run, or the two fixed placeholders, case-insensitively.
 * Pure; trims; '' / whitespace / null / undefined → false.
 */
export function isMaskedDestination(dest: string | null | undefined): boolean {
  const v = (dest ?? '').trim();
  if (v === '') return false;
  if (MASK_RUN.test(v)) return true;
  const lower = v.toLowerCase();
  return lower === ACCOUNT_ON_FILE_PLACEHOLDER || lower === NO_BANK_DETAILS_PLACEHOLDER.toLowerCase();
}

// ── USDC seller payout (2026-07-02 spec) ─────────────────────────────────────
//
// A cross-border SELLER may choose to receive payouts as USDC to a wallet
// address instead of a bank deposit. The address is captured ONLY on the
// verified onboarding page (OTP-gated), validated here, composed to the
// canonical `USDC|<address>` destination string, and stored in the SAME
// encrypted slot bank details use. NON-CUSTODIAL: the licensed partner
// executes the stablecoin transfer — SmartRemit never holds crypto or fiat.
//
// Phase 1 carries only the EVM address shape (0x + 40 hex); WHICH chain the
// USDC moves on is the partner rail's configuration, not ours.

/** EVM address shape: 0x followed by exactly 40 hex characters (anchored). */
export const USDC_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

/** Canonical destination prefix marking a USDC wallet payout. */
export const USDC_DESTINATION_PREFIX = 'USDC|';

export type UsdcAddressResult =
  | { ok: true; address: string }
  | { ok: false; error: string };

/**
 * Validates a USDC wallet address (trimmed). Intentionally strict — anything
 * that is not exactly `0x` + 40 hex characters is rejected with a clear,
 * human-readable error (no checksum validation; the shape check stops
 * obviously-garbage values from ever reaching a payable instruction).
 */
export function validateUsdcAddress(raw: string): UsdcAddressResult {
  const address = (raw ?? '').trim();
  if (address === '') return { ok: false, error: 'Wallet address is required.' };
  if (!USDC_ADDRESS_PATTERN.test(address)) {
    return {
      ok: false,
      error: 'Enter a valid USDC wallet address — it starts with 0x followed by 40 letters (a–f) and digits.',
    };
  }
  return { ok: true, address };
}

/** Composes the canonical stored destination string for a USDC payout. */
export function composeUsdcDestination(address: string): string {
  return `${USDC_DESTINATION_PREFIX}${address}`;
}

/**
 * Strips the canonical `USDC|` prefix back to the BARE 0x address — the wire
 * format the partner rail receives in the signed settlement instruction. A
 * non-prefixed value passes through unchanged (defensive).
 */
export function usdcAddressFromDestination(dest: string): string {
  const d = dest ?? '';
  return d.startsWith(USDC_DESTINATION_PREFIX) ? d.slice(USDC_DESTINATION_PREFIX.length) : d;
}

/**
 * Human label for a payout method on receipts/admin views: 'usdc' renders as
 * "USDC wallet"; every other method keeps the existing uppercase rendering
 * ("BANK" / "UPI") byte-for-byte.
 */
export function payoutMethodLabel(method: string): string {
  return method === 'usdc' ? 'USDC wallet' : (method ?? '').toUpperCase();
}
