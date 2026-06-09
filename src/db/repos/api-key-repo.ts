import { and, desc, eq, isNull } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { apiKeys } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import { env } from '@/lib/env';
import { newTransferId } from '@/lib/id';
import type { PartnerId } from '@/lib/types';
import type { ApiKeyPublic, IssuedApiKey } from '@/lib/partner-api-key';

// api-key-repo — mirrors partner-api-key's surface (issue / authenticate /
// revoke / list). Same security contract: plaintext shown ONCE at issue; only
// the SHA-256(+pepper) hash at rest (UNIQUE index = O(1) auth); partnerId is
// bound to the hash row — the sole source of a request's tenant. The UNIQUE
// hash index also makes a (cosmically unlikely) key collision a loud insert
// error instead of a silent cross-tenant overwrite.

const KEY_PREFIX = 'sr_live_';

export interface ApiKeyRepoDeps {
  now?: () => Date;
  genSecret?: () => string;
  genKeyId?: () => string;
  pepper?: string;
}

export function createApiKeyRepo(db: DbOrTx, deps: ApiKeyRepoDeps = {}) {
  const now = deps.now ?? (() => new Date());
  const genSecret = deps.genSecret ?? (() => randomBytes(24).toString('base64url'));
  const genKeyId = deps.genKeyId ?? (() => `pk_${newTransferId()}`);
  const pepper = deps.pepper ?? env.passwordPepper;
  const hashKey = (plaintext: string): string =>
    createHash('sha256').update(`${plaintext}${pepper}`).digest('hex');

  return {
    async issue(partnerId: PartnerId): Promise<IssuedApiKey> {
      const plaintext = `${KEY_PREFIX}${genSecret()}`;
      const keyId = genKeyId();
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

    async authenticate(
      plaintext: string,
    ): Promise<{ partnerId: PartnerId; keyId: string } | null> {
      if (typeof plaintext !== 'string' || !plaintext.startsWith(KEY_PREFIX)) return null;
      const rows = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.keyHash, hashKey(plaintext)))
        .limit(1);
      const row = rows[0];
      if (!row || row.revokedAt) return null;
      return { partnerId: row.partnerId, keyId: row.id };
    },

    /** Idempotent revoke (first revocation timestamp wins). False only for unknown keyId. */
    async revoke(keyId: string): Promise<boolean> {
      const rows = await db
        .update(apiKeys)
        .set({ revokedAt: now() })
        .where(and(eq(apiKeys.id, keyId), isNull(apiKeys.revokedAt)))
        .returning({ id: apiKeys.id });
      if (rows.length > 0) return true;
      const exists = await db
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(eq(apiKeys.id, keyId))
        .limit(1);
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
        return k;
      });
    },
  };
}

export type ApiKeyRepo = ReturnType<typeof createApiKeyRepo>;
