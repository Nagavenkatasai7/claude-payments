import { normalizePhone, isValidPhone } from '@/lib/phone';

// waitlist — the pure helpers behind the public "Join waitlist" form:
// edge validation/normalisation, the display masks the admin list shows
// (so list reads never decrypt), and the CSV renderer for the audited export.
// No I/O here — the server action (src/app/waitlist-action.ts) and the repo
// (src/db/repos/waitlist-repo.ts) own the effects.

/** The consent copy the checkbox shows. Changing the words ⇒ bump the version; rows record which they agreed to. */
export const WAITLIST_CONSENT_TEXT =
  'I agree to receive SmartRemit updates by WhatsApp and email. I can opt out anytime.';
export const WAITLIST_CONSENT_VERSION = 'v1';
/** The consent checkbox's `value`; the server accepts consent only when the field equals it exactly. */
export const WAITLIST_CONSENT_VALUE = 'yes';

export const WAITLIST_LIMITS = {
  name: 120,
  email: 320,
  phone: 40,
  location: 120,
  utm: 64,
} as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Strip C0/C1 control characters (keeps ordinary Unicode text), then trim. */
function cleanText(raw: unknown, max: number): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .trim()
    .slice(0, max);
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Normalise a phone to E.164 (`+` + 10..15 digits) on top of the shared
 * digit-only normaliser. Rules (each pinned by tests/waitlist.test.ts):
 *   • a leading 0 or 00 is REJECTED outright — a trunk prefix (07911…) or an
 *     international dialling prefix (0044…) is not E.164 and guessing the
 *     intended country would silently mis-key the dedupe index; the form copy
 *     asks for the country code instead;
 *   • a bare 10-digit number is ASSUMED US (+1) — the product launches
 *     US→India and the form's placeholder shows a US number — but only when
 *     it can be a NANP number (area code 2-9); 0… / 1… are rejected;
 *   • anything longer must already carry its country code (no leading 0).
 * Null ⇒ invalid.
 */
export function toE164(raw: string): string | null {
  const digits = normalizePhone(raw);
  if (!isValidPhone(digits)) return null;
  if (digits.startsWith('0')) return null;
  if (digits.length === 10) {
    if (digits[0] === '1') return null; // NANP area codes are 2-9
    return `+1${digits}`;
  }
  return `+${digits}`;
}

export interface WaitlistSignupInput {
  fullName: string;
  email: string; // normalised (lowercase)
  phone: string; // E.164
  location: string;
  destinations: string[]; // allow-listed country codes, deduped, form order
  utmSource: string | undefined;
  utmCampaign: string | undefined;
}

export type ParseResult = { ok: true; value: WaitlistSignupInput } | { ok: false };

/**
 * Server-side, authoritative parse of the public form. Every field is capped,
 * control characters are stripped, the email/phone are normalised (the blind
 * indexes are computed from THESE values), destinations are filtered to the
 * allowed set, and the consent box must be ticked.
 */
export function parseWaitlistSignup(formData: FormData, allowedDestinations: ReadonlySet<string>): ParseResult {
  const fullName = cleanText(formData.get('full_name'), WAITLIST_LIMITS.name);
  const emailRaw = cleanText(formData.get('email'), WAITLIST_LIMITS.email + 1);
  const email = normalizeEmail(emailRaw);
  const phone = toE164(cleanText(formData.get('phone'), WAITLIST_LIMITS.phone));
  const location = cleanText(formData.get('location'), WAITLIST_LIMITS.location);
  const destinations = [
    ...new Set(
      formData
        .getAll('destinations')
        .map((c) => String(c).trim())
        .filter((c) => allowedDestinations.has(c)),
    ),
  ];
  // Consent is given ONLY when the field carries the checkbox's exact value —
  // never "any non-empty string" (a forged `consent=no` must not count).
  const consent = formData.get('consent') === WAITLIST_CONSENT_VALUE;
  const utmSource = cleanText(formData.get('utm_source'), WAITLIST_LIMITS.utm) || undefined;
  const utmCampaign = cleanText(formData.get('utm_campaign'), WAITLIST_LIMITS.utm) || undefined;

  const valid =
    fullName.length >= 2 &&
    email.length <= WAITLIST_LIMITS.email &&
    EMAIL_RE.test(email) &&
    phone !== null &&
    location.length >= 1 &&
    destinations.length >= 1 &&
    consent;
  if (!valid || phone === null) return { ok: false };
  return { ok: true, value: { fullName, email, phone, location, destinations, utmSource, utmCampaign } };
}

// ── Display masks (computed at WRITE time, stored as plain siblings) ─────────

/** `asha.patel@gmail.com` → `a***@gmail.com`. The domain stays visible by design. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

/** First letter of the name, upper-cased, as an initial (`A.`); '' for an empty name. */
export function initialOf(fullName: string): string {
  const first = fullName.trim()[0];
  return first ? `${first.toUpperCase()}.` : '';
}

// ── CSV (the audited, decrypted export) ──────────────────────────────────────

export interface WaitlistCsvRow {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  location: string;
  destinations: string[];
  consentAt: string;
  consentTextVersion: string;
  utmSource: string | undefined;
  utmCampaign: string | undefined;
  createdAt: string;
}

/**
 * One CSV cell. Quotes when needed (RFC 4180) and neutralises spreadsheet
 * formula injection: a cell starting with = + - @ (or a tab/CR) is prefixed
 * with a single quote so Excel/Sheets render it as text. E.164 phones start
 * with `+`, so every phone cell takes this path.
 */
export function csvCell(value: string): string {
  let v = value;
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  if (/[",\r\n']/.test(v) || v !== value) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

const CSV_HEADER = [
  'id',
  'full_name',
  'email',
  'phone',
  'location',
  'destinations',
  'consent_at',
  'consent_text_version',
  'utm_source',
  'utm_campaign',
  'created_at',
];

export function waitlistCsv(rows: WaitlistCsvRow[]): string {
  const lines = [CSV_HEADER.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.fullName,
        r.email,
        r.phone,
        r.location,
        r.destinations.join('|'),
        r.consentAt,
        r.consentTextVersion,
        r.utmSource ?? '',
        r.utmCampaign ?? '',
        r.createdAt,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}
