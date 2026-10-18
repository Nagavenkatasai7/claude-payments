import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';

// Secrets of the AI-agent sign-in: authorization codes, access and refresh tokens, client
// secrets, consent tickets. Only a hash is ever stored (Redis or Neon); the plaintext leaves the
// server once, to its owner.
//
// The hash is the Partner API key construction (src/db/repos/api-key-repo.ts createApiKeyRepo
// hashKey): SHA-256 over plaintext + PASSWORD_PEPPER, hex. No new secret: the pepper is read from
// env.passwordPepper exactly as that repo reads it. Every value hashed here is 32 random bytes,
// so the hash is not reversible by enumeration even without the pepper.

export function agentSecretHash(plaintext: string, pepper: string = env.passwordPepper): string {
  return createHash('sha256').update(`${plaintext}${pepper}`).digest('hex');
}

/** 32 random bytes, base64url, with an optional prefix (sra_, srr_, src_). */
export function newAgentSecret(prefix = ''): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

/** An opaque id: prefix + 16 random bytes base64url (22 characters). */
export function newAgentId(prefix: 'agc_' | 'agg_'): string {
  return `${prefix}${randomBytes(16).toString('base64url')}`;
}

/** Constant-time compare of two hex hashes. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}
