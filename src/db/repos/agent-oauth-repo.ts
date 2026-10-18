import { and, desc, eq, gt, isNull, isNotNull, or, sql } from 'drizzle-orm';
import { agentClients, agentGrants } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import type { PartnerId } from '@/lib/types';
import type { AgentScope } from '@/lib/agent-auth/contract';
import type { AgentAuthMethod } from '@/lib/agent-auth/config';

// agent-oauth-repo — the AI-agent sign-in's Neon tables (Stage C1, migration 0034).
//
// TENANT-SCOPED: every query takes partnerId in the WHERE (the host's partner, never request
// input), and the customer-facing ones take the phone too. A client or grant of another tenant
// is simply not found. Only hashes are stored (client secret, refresh tokens).

export type AgentRevokeReason = 'customer' | 'theft' | 'client' | 'code_reuse' | 'admin';

export interface AgentClientRow {
  id: string;
  partnerId: PartnerId;
  name: string;
  redirectUris: string[];
  authMethod: AgentAuthMethod;
  secretHash: string | null;
}

export interface AgentGrantRow {
  id: string;
  partnerId: PartnerId;
  phone: string;
  clientId: string;
  clientName: string;
  scopes: AgentScope[];
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date;
}

export interface CustomerGrantRow {
  id: string;
  clientName: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

const grantCols = {
  id: agentGrants.id,
  partnerId: agentGrants.partnerId,
  phone: agentGrants.phone,
  clientId: agentGrants.clientId,
  clientName: agentClients.name,
  scopes: agentGrants.scopes,
  createdAt: agentGrants.createdAt,
  lastUsedAt: agentGrants.lastUsedAt,
  expiresAt: agentGrants.expiresAt,
};

type GrantSelect = { [K in keyof typeof grantCols]: unknown };
const toGrant = (r: GrantSelect): AgentGrantRow => ({
  id: r.id as string,
  partnerId: r.partnerId as PartnerId,
  phone: r.phone as string,
  clientId: r.clientId as string,
  clientName: r.clientName as string,
  scopes: r.scopes as AgentScope[],
  createdAt: r.createdAt as Date,
  lastUsedAt: (r.lastUsedAt as Date | null) ?? null,
  expiresAt: r.expiresAt as Date,
});

/** Not revoked and not expired at `now`. */
const live = (now: Date) => and(isNull(agentGrants.revokedAt), gt(agentGrants.expiresAt, now));

/** The grant joined to its client ON THE SAME TENANT (a client of another tenant never joins). */
const clientJoin = and(eq(agentClients.id, agentGrants.clientId), eq(agentClients.partnerId, agentGrants.partnerId));

export function createAgentOAuthRepo(db: DbOrTx) {
  return {
    async insertClient(c: { id: string; partnerId: PartnerId; name: string; redirectUris: string[]; authMethod: AgentAuthMethod; secretHash: string | null }): Promise<void> {
      await db.insert(agentClients).values({
        id: c.id,
        partnerId: c.partnerId,
        name: c.name,
        redirectUris: c.redirectUris,
        authMethod: c.authMethod,
        secretHash: c.secretHash,
      });
    },

    async getClient(partnerId: PartnerId, id: string): Promise<AgentClientRow | null> {
      const rows = await db
        .select({
          id: agentClients.id,
          partnerId: agentClients.partnerId,
          name: agentClients.name,
          redirectUris: agentClients.redirectUris,
          authMethod: agentClients.authMethod,
          secretHash: agentClients.secretHash,
        })
        .from(agentClients)
        .where(and(eq(agentClients.partnerId, partnerId), eq(agentClients.id, id)))
        .limit(1);
      const r = rows[0];
      return r ? { ...r, authMethod: r.authMethod as AgentAuthMethod } : null;
    },

    async insertGrant(g: { id: string; partnerId: PartnerId; phone: string; clientId: string; scopes: readonly AgentScope[]; refreshHash: string; now: Date; expiresAt: Date }): Promise<void> {
      await db.insert(agentGrants).values({
        id: g.id,
        partnerId: g.partnerId,
        phone: g.phone,
        clientId: g.clientId,
        scopes: [...g.scopes],
        refreshHash: g.refreshHash,
        createdAt: g.now,
        expiresAt: g.expiresAt,
      });
    },

    /** The grant when it is live at `now` (not revoked, not expired), with its client's name. */
    async getLiveGrant(partnerId: PartnerId, grantId: string, now: Date): Promise<AgentGrantRow | null> {
      const rows = await db
        .select(grantCols)
        .from(agentGrants)
        .innerJoin(agentClients, clientJoin)
        .where(and(eq(agentGrants.partnerId, partnerId), eq(agentGrants.id, grantId), live(now)))
        .limit(1);
      return rows[0] ? toGrant(rows[0]) : null;
    },

    /**
     * The grant whose CURRENT or PREVIOUS (rotated) refresh hash this is, live or not. 'previous' is
     * a replayed, already-rotated token: the caller treats it as theft.
     */
    async findGrantByRefreshHash(
      partnerId: PartnerId,
      hash: string,
    ): Promise<{ match: 'current' | 'previous'; grant: AgentGrantRow; revoked: boolean } | null> {
      const rows = await db
        .select({ ...grantCols, refreshHash: agentGrants.refreshHash, revokedAt: agentGrants.revokedAt })
        .from(agentGrants)
        .innerJoin(agentClients, clientJoin)
        .where(and(eq(agentGrants.partnerId, partnerId), or(eq(agentGrants.refreshHash, hash), eq(agentGrants.prevRefreshHash, hash))))
        .limit(2);
      // The unique index makes 'current' unambiguous; prefer it over a stale 'previous' match.
      const r = rows.find((x) => x.refreshHash === hash) ?? rows[0];
      if (!r) return null;
      return { match: r.refreshHash === hash ? 'current' : 'previous', grant: toGrant(r), revoked: r.revokedAt !== null };
    },

    /**
     * Rotate the refresh hash, only while `oldHash` is still the current one and the grant is live
     * (a concurrent rotation or a revocation wins). Slides the expiry and stamps last use.
     */
    async rotateRefresh(partnerId: PartnerId, grantId: string, oldHash: string, newHash: string, now: Date, expiresAt: Date): Promise<boolean> {
      const rows = await db
        .update(agentGrants)
        .set({ refreshHash: newHash, prevRefreshHash: oldHash, lastUsedAt: now, expiresAt })
        .where(and(eq(agentGrants.partnerId, partnerId), eq(agentGrants.id, grantId), eq(agentGrants.refreshHash, oldHash), live(now)))
        .returning({ id: agentGrants.id });
      return rows.length === 1;
    },

    /** Revoke a grant of this tenant. True when this call revoked it (false: unknown or already revoked). */
    async revokeGrant(partnerId: PartnerId, grantId: string, reason: AgentRevokeReason, now: Date): Promise<boolean> {
      const rows = await db
        .update(agentGrants)
        .set({ revokedAt: now, revokedReason: reason })
        .where(and(eq(agentGrants.partnerId, partnerId), eq(agentGrants.id, grantId), isNull(agentGrants.revokedAt)))
        .returning({ id: agentGrants.id });
      return rows.length === 1;
    },

    /** The customer's own disconnect: only a live grant of THIS (partner, phone). Returns its client id. */
    async revokeCustomerGrant(partnerId: PartnerId, phone: string, grantId: string, now: Date): Promise<{ clientId: string } | null> {
      const rows = await db
        .update(agentGrants)
        .set({ revokedAt: now, revokedReason: 'customer' })
        .where(and(eq(agentGrants.partnerId, partnerId), eq(agentGrants.phone, phone), eq(agentGrants.id, grantId), live(now)))
        .returning({ clientId: agentGrants.clientId });
      return rows[0] ? { clientId: rows[0].clientId } : null;
    },

    /** The customer's live grants, newest first (the portal "Connected AI apps" list). */
    async listCustomerGrants(partnerId: PartnerId, phone: string, now: Date, limit = 50): Promise<CustomerGrantRow[]> {
      return db
        .select({ id: agentGrants.id, clientName: agentClients.name, createdAt: agentGrants.createdAt, lastUsedAt: agentGrants.lastUsedAt })
        .from(agentGrants)
        .innerJoin(agentClients, clientJoin)
        .where(and(eq(agentGrants.partnerId, partnerId), eq(agentGrants.phone, phone), live(now), isNotNull(agentGrants.refreshHash)))
        .orderBy(desc(agentGrants.createdAt))
        .limit(limit);
    },

    async hasCustomerGrants(partnerId: PartnerId, phone: string, now: Date): Promise<boolean> {
      const rows = await db
        .select({ one: sql<number>`1` })
        .from(agentGrants)
        .where(and(eq(agentGrants.partnerId, partnerId), eq(agentGrants.phone, phone), live(now)))
        .limit(1);
      return rows.length > 0;
    },

    /** Stamp last use (the caller throttles). */
    async touchGrant(partnerId: PartnerId, grantId: string, now: Date): Promise<void> {
      await db
        .update(agentGrants)
        .set({ lastUsedAt: now })
        .where(and(eq(agentGrants.partnerId, partnerId), eq(agentGrants.id, grantId)));
    },
  };
}

export type AgentOAuthRepo = ReturnType<typeof createAgentOAuthRepo>;
