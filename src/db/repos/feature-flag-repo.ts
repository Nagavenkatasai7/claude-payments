import { and, asc, eq } from 'drizzle-orm';
import { featureFlags } from '@/db/schema';
import type { DbOrTx } from '@/db/client';

// feature-flag-repo — the ONLY SQL over feature_flags (Release safety part A,
// migration 0029). Reads go through src/lib/flags.ts (cached); the one writer
// is the platform-admin switch action, which calls upsert INSIDE a transaction
// together with its flag.change audit row.

export type FlagScopeType = 'global' | 'partner' | 'corridor';

export interface FlagRow {
  key: string;
  scopeType: FlagScopeType;
  scopeId: string; // '' for global
  enabled: boolean;
  reason: string | null;
  updatedBy: string;
  updatedAt: Date;
}

export interface FlagWrite {
  key: string;
  scopeType: FlagScopeType;
  scopeId: string;
  enabled: boolean;
  reason: string;
  updatedBy: string;
}

export function createFeatureFlagRepo(db: DbOrTx) {
  return {
    /** Every row that is ON, all keys. Small by construction (one row per switched scope). */
    async listEnabled(): Promise<FlagRow[]> {
      const rows = await db
        .select()
        .from(featureFlags)
        .where(eq(featureFlags.enabled, true));
      return rows as FlagRow[];
    },

    /** Every row (on and off), for the admin switch page. */
    async listAll(): Promise<FlagRow[]> {
      const rows = await db
        .select()
        .from(featureFlags)
        .orderBy(asc(featureFlags.key), asc(featureFlags.scopeType), asc(featureFlags.scopeId));
      return rows as FlagRow[];
    },

    async get(key: string, scopeType: FlagScopeType, scopeId: string): Promise<FlagRow | null> {
      const [row] = await db
        .select()
        .from(featureFlags)
        .where(and(eq(featureFlags.key, key), eq(featureFlags.scopeType, scopeType), eq(featureFlags.scopeId, scopeId)))
        .limit(1);
      return (row as FlagRow | undefined) ?? null;
    },

    /** Insert or overwrite ONE (key, scope) row. updated_at is the DB clock. */
    async upsert(w: FlagWrite): Promise<void> {
      await db
        .insert(featureFlags)
        .values({
          key: w.key,
          scopeType: w.scopeType,
          scopeId: w.scopeId,
          enabled: w.enabled,
          reason: w.reason,
          updatedBy: w.updatedBy,
        })
        .onConflictDoUpdate({
          target: [featureFlags.key, featureFlags.scopeType, featureFlags.scopeId],
          set: { enabled: w.enabled, reason: w.reason, updatedBy: w.updatedBy, updatedAt: new Date() },
        });
    },
  };
}
