import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * totp — Program-Fix 17b. RFC 6238 TOTP on node:crypto only (no dependency):
 * HMAC-SHA1 (RFC 4226 HOTP with dynamic truncation), a 30 s step from the Unix
 * epoch, 6 digits. That is the profile every mainstream authenticator app
 * uses by default (Google Authenticator, 1Password, Authy, Microsoft).
 *
 *   RFC 4226 (HOTP): https://www.rfc-editor.org/rfc/rfc4226#section-5.3
 *   RFC 6238 (TOTP): https://www.rfc-editor.org/rfc/rfc6238#section-4
 *   RFC 4648 §6 (base32 alphabet): https://www.rfc-editor.org/rfc/rfc4648#section-6
 *
 * Pure: no I/O, no clock of its own (callers pass `nowMs`). The replay guard
 * here is the `lastStep` comparison; the store adds an atomic per-step NX key.
 */

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** ±1 step: tolerates 30 s of clock drift either way (RFC 6238 §5.2). */
export const TOTP_WINDOW = 1;
/** 160-bit secret, the HMAC-SHA1 block-friendly size RFC 4226 §4 recommends. */
export const TOTP_SECRET_BYTES = 20;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Case-insensitive; spaces and trailing '=' padding are ignored. Throws on any other character. */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/\s+/g, '').replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('totp: invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

/** RFC 4226 §5.3: HMAC-SHA1 over the 8-byte big-endian counter, dynamic truncation. */
export function hotp(secret: Buffer, counter: number, digits: number = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

export function totpAt(secret: Buffer, nowMs: number, digits: number = TOTP_DIGITS): string {
  return hotp(secret, totpStep(nowMs), digits);
}

const SIX_DIGITS = /^[0-9]{6}$/;

/**
 * The matched step, or null. `code` must be exactly six ASCII digits (checked
 * BEFORE any compare, so timingSafeEqual always sees equal lengths). Every
 * step in the ±1 window is computed and compared — no early return — and a
 * step at or below `lastStep` (the last accepted one) is refused, so a code
 * is never accepted twice and an older code is refused after a newer one.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  nowMs: number,
  opts: { lastStep?: number | null } = {},
): number | null {
  if (typeof code !== 'string' || !SIX_DIGITS.test(code)) return null;
  const given = Buffer.from(code, 'ascii');
  const current = totpStep(nowMs);
  let matched: number | null = null;
  for (let d = -TOTP_WINDOW; d <= TOTP_WINDOW; d++) {
    const step = current + d;
    const expected = Buffer.from(hotp(secret, step), 'ascii');
    if (timingSafeEqual(expected, given) && matched === null) matched = step;
  }
  if (matched === null) return null;
  const last = opts.lastStep;
  if (typeof last === 'number' && Number.isFinite(last) && matched <= last) return null;
  return matched;
}

/**
 * Key-URI format (https://github.com/google/google-authenticator/wiki/Key-Uri-Format):
 * `otpauth://totp/<issuer>:<account>?secret=…&issuer=…` with the label parts
 * percent-encoded and the defaults spelled out.
 */
export function totpOtpauthUri(p: { issuer: string; account: string; secretBase32: string }): string {
  const issuer = encodeURIComponent(p.issuer);
  const label = `${issuer}:${encodeURIComponent(p.account)}`;
  return `otpauth://totp/${label}?secret=${p.secretBase32}&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}
