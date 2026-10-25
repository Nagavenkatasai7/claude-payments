import type { AgentOAuthRepo } from '@/db/repos/agent-oauth-repo';
import type { RedisLike } from '@/lib/store';
import type { PartnerId } from '@/lib/types';
import type { AgentAuth, AgentPrincipal, AgentTokenCheck, AgentToolCallExtra } from './contract';
import { ACCESS_TOKEN_PREFIX } from './config';
import type { AgentAuditInput } from './audit';
import type { AgentTokenStore } from './stores';

// The real AgentAuth (contract.ts) behind getAgentAuth() (Stage C1). The MCP endpoint calls it
// on every request:
//  - verifyAccessToken: the token's hash must be a live Redis record, for THIS resource (the
//    host's MCP URL), and its grant must still be live in Neon (not revoked, not expired) on the
//    record's tenant, for the same phone and client. So a disconnect or a theft revocation stops
//    access at once, a token never crosses hosts, and a partner API key (sr_live_ / sr_test_) is
//    never accepted. Never throws: any error is `invalid`.
//  - toolsActive: the gate (switch AND demo-mode phone), fail closed.
//  - recordToolCall: one audit row (tool, client id, outcome, and the draft id a prepare or
//    cancel touched; never arguments), best effort.

export interface AgentAuthDeps {
  repo: AgentOAuthRepo;
  store: Pick<AgentTokenStore, 'readAccess'>;
  now: () => number;
  /** For the last-used throttle marker (SET NX EX). */
  redis: RedisLike;
  gateOpen(partnerId: PartnerId, phone: string): Promise<boolean>;
  audit(e: AgentAuditInput): Promise<void>;
}

/** A draft or schedule id (newTransferId: base64url); anything else is left out of the audit row. */
const DRAFT_ID = /^[A-Za-z0-9_-]{6,64}$/;

/** last_used_at is written at most once per grant per this window. */
export const GRANT_TOUCH_THROTTLE_SEC = 300;

export function createAgentAuth(deps: AgentAuthDeps): AgentAuth {
  async function touch(partnerId: PartnerId, grantId: string): Promise<void> {
    try {
      const first = await deps.redis.set(`agent:touch:${grantId}`, '1', { ex: GRANT_TOUCH_THROTTLE_SEC, nx: true });
      if (first !== null) await deps.repo.touchGrant(partnerId, grantId, new Date(deps.now()));
    } catch {
      /* best effort: "last used" is informational */
    }
  }

  return {
    async verifyAccessToken(token: string | null, resource: string): Promise<AgentTokenCheck> {
      if (!token) return { ok: false, reason: 'missing' };
      try {
        if (!token.startsWith(ACCESS_TOKEN_PREFIX) || token.length > 128) return { ok: false, reason: 'invalid' };
        const rec = await deps.store.readAccess(token);
        if (!rec || rec.resource !== resource) return { ok: false, reason: 'invalid' };
        const grant = await deps.repo.getLiveGrant(rec.partnerId, rec.grantId, new Date(deps.now()));
        if (!grant || grant.partnerId !== rec.partnerId || grant.phone !== rec.phone || grant.clientId !== rec.clientId) {
          return { ok: false, reason: 'invalid' };
        }
        const scopes = rec.scopes.filter((s) => grant.scopes.includes(s));
        if (scopes.length === 0) return { ok: false, reason: 'invalid' };
        await touch(grant.partnerId, grant.id);
        const principal: AgentPrincipal = {
          grantId: grant.id,
          partnerId: grant.partnerId,
          phone: grant.phone,
          clientId: grant.clientId,
          clientName: grant.clientName,
          scopes,
        };
        return { ok: true, principal };
      } catch {
        return { ok: false, reason: 'invalid' };
      }
    },

    async toolsActive(partnerId: PartnerId, phone: string): Promise<boolean> {
      try {
        return (await deps.gateOpen(partnerId, phone)) === true;
      } catch {
        return false;
      }
    },

    async recordToolCall(
      principal: AgentPrincipal,
      tool: string,
      outcome: 'ok' | 'error' | 'refused',
      extra?: AgentToolCallExtra,
    ): Promise<void> {
      try {
        const draftId = extra?.draftId !== undefined && DRAFT_ID.test(extra.draftId) ? extra.draftId : undefined;
        const scheduleId = extra?.scheduleId !== undefined && DRAFT_ID.test(extra.scheduleId) ? extra.scheduleId : undefined;
        await deps.audit({
          partnerId: principal.partnerId,
          phone: principal.phone,
          clientId: principal.clientId,
          action: 'agent.tool.called',
          meta: { tool: String(tool).slice(0, 64), clientId: principal.clientId, outcome, ...(draftId ? { draftId } : {}), ...(scheduleId ? { scheduleId } : {}) },
        });
      } catch {
        /* best effort: never throws */
      }
    },
  };
}
