import { createHash, timingSafeEqual } from 'node:crypto';

// PKCE (RFC 7636), S256 only: the `plain` method is never accepted (OAuth 2.1).

/** An S256 challenge: base64url (no padding) of a 32-byte SHA-256 = exactly 43 characters. */
export const isCodeChallenge = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);

/** RFC 7636 §4.1: 43-128 characters of [A-Z] / [a-z] / [0-9] / "-" / "." / "_" / "~". */
export const isCodeVerifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9\-._~]{43,128}$/.test(v);

/** BASE64URL(SHA256(verifier)) === challenge, in constant time. Never throws. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!isCodeVerifier(verifier) || !isCodeChallenge(challenge)) return false;
  const got = Buffer.from(createHash('sha256').update(verifier, 'ascii').digest('base64url'), 'ascii');
  const want = Buffer.from(challenge, 'ascii');
  return got.length === want.length && timingSafeEqual(got, want);
}
