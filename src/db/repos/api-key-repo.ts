import { and, desc, eq, isNull } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { apiKeys } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import { env } from '@/lib/env';
import { newTransferId } from '@/lib/id';
import type { PartnerId } from '@/lib/types';
import type { ApiKeyPublic, IssuedApiKey } from '@/lib/partner-api-key';
import type { RedisLike } from '@/lib/store';
import { logWarn } from '@/lib/log';
import {
  displayKeyPrefix,
  effectiveScopes,
  keyModeFromPlaintext,
  type ApiKeyMode,
  type ApiScope,
} from '@/lib/partner-api-scopes';

// api-key-repo — mirrors partner-api-key's surface (issue / authenticate /
// revoke / list). Same security contract: plaintext shown ONCE at issue; only
// the SHA-256(+pepper) hash at rest (UNIQUE index = O(1) auth); partnerId is
// bound to the hash row — the sole source of a request's tenant. The UNIQUE
// hash index also makes a (cosmically unlikely) key collision a loud insert
// error instead of a silent cross-tenant overwrite.
//
// Program-Fix 44 P1: keys carry a MODE. The plaintext prefix (sr_live_ /
// sr_test_) is authoritative and hash-covered, so it cannot be forged; the key
// id mirrors it (pk_live_ / pk_test_) for display. Every pre-fix key (a bare
// pk_<id> id with an sr_live_ plaintext) is live with full scope (its
// api_keys.scopes is NULL — P2's column only ever narrows a key).

/** last_used_at is rewritten at most once per this window (Redis SET NX EX marker). */
const LAST_USED_THROTTLE_SEC = 300;

export interface AuthenticatedKey {
  partnerId: PartnerId;
  keyId: string;
  mode: ApiKeyMode;
  scopes: ApiScope[];
}

export interface ApiKeyRepoDeps {
  now?: () => Date;
  genSecret?: () => string;
  genKeyId?: () => string;
  pepper?: string;
  /** Throttle marker store for last_used_at. Absent ⇒ every auth writes (tests). */
  redis?: RedisLike;
}

export function createApiKeyRepo(db: DbOrTx, deps: ApiKeyRepoDeps = {}) {
  const now = deps.now ?? (() => new Date());
  const genSecret = deps.genSecret ?? (() => randomBytes(24).toString('base64url'));
  const genKeyId = deps.genKeyId ?? (() => `pk_${newTransferId()}`);
  const pepper = deps.pepper ?? env.passwordPepper;
  const hashKey = (plaintext: string): string =>
    createHash('sha256').update(`${plaintext}${pepper}`).digest('hex');

  // AWAITED (an un-awaited write can be dropped once a Vercel response is sent)
  // but throttled to one write per key per LAST_USED_THROTTLE_SEC, and never
  // able to fail the auth: any Redis or DB error is logged and swallowed.
  async function touchLastUsed(keyId: string): Promise<void> {
    try {
      if (deps.redis) {
        const claimed = await deps.redis.set(`apikey_seen:${keyId}`, '1', {
          nx: true,
          ex: LAST_USED_THROTTLE_SEC,
        });
        if (claimed === null) return; // written within the window
      }
      await db.update(apiKeys).set({ lastUsedAt: now() }).where(eq(apiKeys.id, keyId));
    } catch (e) {
      logWarn('api-key', 'last_used_at update failed', { keyId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    async issue(partnerId: PartnerId, mode: ApiKeyMode = 'live'): Promise<IssuedApiKey> {
      const plaintext = `${displayKeyPrefix(mode)}${genSecret()}`;
      // The id always encodes the mode, even with an injected generator.
      const keyId = `pk_${mode}_${genKeyId().replace(/^pk_/, '')}`;
      const last4 = plaintext.slice(-4);
      await db.insert(apiKeys).values({
        id: keyId,
        partnerId,
        keyHash: hashKey(plaintext),
        last4,
        createdAt: now(),
      });
      return { plaintext, keyId, last4 };
    },

    async authenticate(plaintext: string): Promise<AuthenticatedKey | null> {
      const mode = keyModeFromPlaintext(plaintext);
      if (!mode) return null;
      const rows = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.keyHash, hashKey(plaintext)))
        .limit(1);
      const row = rows[0];
      if (!row || row.revokedAt) return null;
      await touchLastUsed(row.id);
      // Program-Fix 44 P2: the stored scopes column can only narrow the mode's set.
      return { partnerId: row.partnerId, keyId: row.id, mode, scopes: effectiveScopes(mode, row.scopes) };
    },

    /**
     * Idempotent revoke (first revocation timestamp wins), TENANT-SCOPED:
     * partner_id is in the WHERE of both the update and the fallback read
     * (partner-demo R3a, M4), so another partner's key id behaves exactly like
     * an unknown one. False ⇒ no such key for THIS partner (404-never-403).
     */
    async revoke(keyId: string, partnerId: PartnerId): Promise<boolean> {
      const owned = and(eq(apiKeys.id, keyId), eq(apiKeys.partnerId, partnerId));
      const rows = await db
        .update(apiKeys)
        .set({ revokedAt: now() })
        .where(and(owned, isNull(apiKeys.revokedAt)))
        .returning({ id: apiKeys.id });
      if (rows.length > 0) return true;
      const exists = await db.select({ id: apiKeys.id }).from(apiKeys).where(owned).limit(1);
      return exists.length > 0;
    },

    async list(partnerId: PartnerId): Promise<ApiKeyPublic[]> {
      const rows = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.partnerId, partnerId))
        .orderBy(desc(apiKeys.createdAt));
      return rows.map((r) => {
        const k: ApiKeyPublic = {
          keyId: r.id,
          createdAt: r.createdAt.toISOString(),
          last4: r.last4,
        };
        if (r.revokedAt) k.revokedAt = r.revokedAt.toISOString();
        if (r.lastUsedAt) k.lastUsedAt = r.lastUsedAt.toISOString();
        return k;
      });
    },
  };
}

export type ApiKeyRepo = ReturnType<typeof createApiKeyRepo>;
