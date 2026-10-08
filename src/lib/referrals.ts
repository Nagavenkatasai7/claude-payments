import { randomBytes } from 'node:crypto';
import { csvCell } from './settlement-statement';
import { isBoundedPrintable, isCleanName, NAME_MAX } from './untrusted-text';

// referrals — Batch B4, the pure half of the referral-partner program (Xoxoday Plum).
// Referral partners are OUTSIDE affiliates (accountants, travel agents, associations),
// never licensed partners: a code links a customer to a referral partner for a
// commission, and never changes the customer's licensed partner (tenant).
//
// Codes are `REF-` plus 6 letters or digits. Generated codes use an alphabet without
// 0/O/1/I so a code read aloud or typed from paper is not misread; the format check
// accepts any letters and digits (an admin may hand out a code such as REF-TANA01).

export { REFERRAL_CODE_RE, normalizeReferralCode, findReferralCodeInText } from './referral-code';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols: a byte & 31 is unbiased

/** The 12-month commission window, counted from the customer's first delivered transfer. */
export const COMMISSION_WINDOW_MONTHS = 12;
/** An admin can set at most $1,000.00 per transfer (a typo guard, not a policy). */
export const COMMISSION_MAX_CENTS = 100_000;
export const REFERRAL_CONTACT_MAX = 160;
export const PLUM_URL_MAX = 500;

export function generateReferralCode(): string {
  const bytes = randomBytes(6);
  let out = 'REF-';
  for (const b of bytes) out += CODE_ALPHABET[b & 31];
  return out;
}

export function newReferralPartnerId(): string {
  return `rp_${randomBytes(9).toString('base64url')}`;
}

/** The prefilled first message (phrased as the customer, like the site's other WhatsApp links). */
export function referralWhatsAppText(code: string): string {
  return `Hi SmartRemit, I'd like to send money. My referral code is ${code}.`;
}

/** A wa.me link to SmartRemit's own number with the code in the prefilled text. */
export function referralWhatsAppLink(code: string, waPhone: string): string {
  return `https://wa.me/${waPhone}?text=${encodeURIComponent(referralWhatsAppText(code))}`;
}

/** The customer-portal sign-in with the code (the login page keeps it in a 30-day cookie). */
export function referralPortalLink(code: string, portalLoginUrl: string): string {
  return `${portalLoginUrl}?ref=${encodeURIComponent(code)}`;
}

// ── admin inputs ─────────────────────────────────────────────────────────────

/** Dollars with at most 2 decimals → integer cents. Empty ⇒ 0 (the owner's default). */
export function parseCommissionUsd(raw: unknown): { ok: true; cents: number } | { ok: false; error: string } {
  const s = typeof raw === 'string' ? raw.trim() : raw === null || raw === undefined ? '' : String(raw);
  if (s === '') return { ok: true, cents: 0 };
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return { ok: false, error: 'Commission must be a dollar amount such as 1.00.' };
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  if (cents > COMMISSION_MAX_CENTS) {
    return { ok: false, error: `Commission can be at most ${formatUsdCents(COMMISSION_MAX_CENTS)} USD per transfer.` };
  }
  return { ok: true, cents };
}

export function parseReferralPartnerFields(input: { name: unknown; contact: unknown }):
  | { ok: true; name: string; contact: string }
  | { ok: false; error: string } {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!isCleanName(name)) return { ok: false, error: `Name must be 1–${NAME_MAX} characters with no brackets or line breaks.` };
  const contact = typeof input.contact === 'string' ? input.contact.trim() : '';
  if (!isBoundedPrintable(contact, REFERRAL_CONTACT_MAX)) {
    return { ok: false, error: `Contact must be at most ${REFERRAL_CONTACT_MAX} characters on one line.` };
  }
  return { ok: true, name, contact };
}

/** The Plum portal address: empty clears it (the public link hides); otherwise https only, no credentials. */
export function parsePlumPortalUrl(raw: unknown): { ok: true; url: string | null } | { ok: false; error: string } {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (s === '') return { ok: true, url: null };
  const bad = { ok: false as const, error: 'Enter a full https:// address (at most 500 characters).' };
  if (s.length > PLUM_URL_MAX || !isBoundedPrintable(s, PLUM_URL_MAX)) return bad;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return bad;
  }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return bad;
  return { ok: true, url: u.toString() };
}

// ── statement ────────────────────────────────────────────────────────────────

/** A UTC calendar month `YYYY-MM` → [from, to). Anything else ⇒ the current month. */
export function parseStatementMonth(raw: unknown, now: Date): { month: string; from: Date; to: Date } {
  const m = typeof raw === 'string' ? /^(\d{4})-(0[1-9]|1[0-2])$/.exec(raw.trim()) : null;
  const y = m ? Number(m[1]) : now.getUTCFullYear();
  const mo = m ? Number(m[2]) - 1 : now.getUTCMonth();
  const from = new Date(Date.UTC(y, mo, 1));
  const to = new Date(Date.UTC(y, mo + 1, 1));
  return { month: `${from.getUTCFullYear()}-${String(from.getUTCMonth() + 1).padStart(2, '0')}`, from, to };
}

export function formatUsdCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

export interface ReferralStatementLine {
  name: string;
  contact: string;
  deliveredCount: number;
  commissionCents: number;
}

/**
 * The CSV Raj uses to load Plum points by hand. ONLY the referral partner's name and contact
 * and the amounts: never a customer, phone or transfer. Cells go through the settlement CSV's
 * formula guard.
 */
export function referralStatementCsv(month: string, lines: readonly ReferralStatementLine[]): string {
  const header = 'month,referral_partner,contact,delivered_transfers,commission_per_transfer_usd,commission_total_usd';
  const rows = lines.map((l) =>
    [
      csvCell(month),
      csvCell(l.name),
      csvCell(l.contact),
      csvCell(l.deliveredCount),
      csvCell(formatUsdCents(l.commissionCents)),
      csvCell(formatUsdCents(l.commissionCents * l.deliveredCount)),
    ].join(','),
  );
  return `${[header, ...rows].join('\r\n')}\r\n`;
}
