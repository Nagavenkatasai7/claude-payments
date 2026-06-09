import { Redis } from '@upstash/redis';
import { createHash, randomBytes } from 'node:crypto';
import { env } from './env';
import type { RedisLike } from './store';
import type { PartnerId } from './types';
import { newTransferId } from './id';

// partner-api-key — issue/authenticate/revoke per-partner API keys for the
// outbound Partner API (Phase B).
//
// SECURITY: the plaintext key is shown EXACTLY ONCE at issue and never stored.
// At rest we keep only a SHA-256 hash (salted with PASSWORD_PEPPER, a Vercel
// secret), so a Redis leak yields no usable credential. A key is high-entropy
// (24 random bytes), so a fast hash is sufficient — a slow KDF would only add
// per-request latency. `partnerId` is bound to the hash record and is the ONLY
// source of a request's tenant — never the request body.

const KEY_PREFIX = 'sr_live_';

export interface ApiKeyRecord {
  partnerId: PartnerId;
  keyId: string;
  createdAt: string;
  revokedAt?: string;
}

/** Public, listable view — never exposes the hash or the plaintext. */
export interface ApiKeyPublic {
  keyId: string;
  createdAt: string;
  revokedAt?: string;
  last4: string;
}

export interface IssuedApiKey {
  plaintext: string; // shown ONCE; never persisted
  keyId: string;
  last4: string;
}

export interface PartnerApiKeyDeps {
  now?: () => string;
  genSecret?: () => string; // the random part after the prefix
  genKeyId?: () => string;
  pepper?: string;
}

export function createPartnerApiKeyStore(
  redis: RedisLike,
  deps: PartnerApiKeyDeps = {},
) {
  const now = deps.now ?? (() => new Date().toISOString());
  const genSecret = deps.genSecret ?? (() => randomBytes(24).toString('base64url'));
  const genKeyId = deps.genKeyId ?? (() => `pk_${newTransferId()}`);
  const pepper = deps.pepper ?? env.passwordPepper;

  const hashKey = (plaintext: string): string =>
    createHash('sha256').update(`${plaintext}${pepper}`).digest('hex');

  return {
    /** Mint a new key. Returns the plaintext ONCE — the caller must surface it now. */
    async issue(partnerId: PartnerId): Promise<IssuedApiKey> {
      const plaintext = `${KEY_PREFIX}${genSecret()}`;
      const keyId = genKeyId();
      const createdAt = now();
      const last4 = plaintext.slice(-4);
      const record: ApiKeyRecord = { partnerId, keyId, createdAt };
      await redis.set(`apikey:hash:${hashKey(plaintext)}`, JSON.stringify(record));
      await redis.set(
        `apikey:meta:${keyId}`,
        JSON.stringify({ ...record, hash: hashKey(plaintext), last4 }),
      );
      await redis.sadd(`partner:${partnerId}:apikeys`, keyId);
      return { plaintext, keyId, last4 };
    },

    /** Resolve a presented key to its partner, or null if unknown/revoked. */
    async authenticate(
      plaintext: string,
    ): Promise<{ partnerId: PartnerId; keyId: string } | null> {
      if (typeof plaintext !== 'string' || !plaintext.startsWith(KEY_PREFIX)) return null;
      const raw = await redis.get(`apikey:hash:${hashKey(plaintext)}`);
      if (!raw) return null;
      let rec: ApiKeyRecord;
      try {
        rec = JSON.parse(raw) as ApiKeyRecord;
      } catch {
        return null;
      }
      if (rec.revokedAt) return null;
      return { partnerId: rec.partnerId, keyId: rec.keyId };
    },

    /** Revoke a key by id (idempotent). Marks both the hash + meta records. */
    async revoke(keyId: string): Promise<boolean> {
      const metaRaw = await redis.get(`apikey:meta:${keyId}`);
      if (!metaRaw) return false;
      let meta: ApiKeyRecord & { hash: string; last4: string };
      try {
        meta = JSON.parse(metaRaw) as ApiKeyRecord & { hash: string; last4: string };
      } catch {
        return false;
      }
      if (meta.revokedAt) return true; // already revoked
      const at = now();
      await redis.set(`apikey:meta:${keyId}`, JSON.stringify({ ...meta, revokedAt: at }));
      const hashRaw = await redis.get(`apikey:hash:${meta.hash}`);
      if (hashRaw) {
        try {
          const rec = JSON.parse(hashRaw) as ApiKeyRecord;
          await redis.set(`apikey:hash:${meta.hash}`, JSON.stringify({ ...rec, revokedAt: at }));
        } catch {
          /* meta is already revoked; authenticate still fails closed below */
        }
      }
      return true;
    },

    /** List a partner's keys (public fields only). */
    async list(partnerId: PartnerId): Promise<ApiKeyPublic[]> {
      const ids = await redis.smembers(`partner:${partnerId}:apikeys`);
      const out: ApiKeyPublic[] = [];
      for (const keyId of ids) {
        const raw = await redis.get(`apikey:meta:${keyId}`);
        if (!raw) continue;
        try {
          const meta = JSON.parse(raw) as ApiKeyRecord & { last4: string };
          out.push({ keyId: meta.keyId, createdAt: meta.createdAt, revokedAt: meta.revokedAt, last4: meta.last4 });
        } catch {
          /* skip corrupt */
        }
      }
      return out;
    },
  };
}

export type PartnerApiKeyStore = ReturnType<typeof createPartnerApiKeyStore>;

let cached: PartnerApiKeyStore | null = null;

export function getPartnerApiKeyStore(): PartnerApiKeyStore {
  if (!cached) {
    const redis = new Redis({
      url: env.kvUrl,
      token: env.kvToken,
      automaticDeserialization: false,
    });
    cached = createPartnerApiKeyStore(redis as unknown as RedisLike);
  }
  return cached;
}
