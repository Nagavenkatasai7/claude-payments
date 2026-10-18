import type { AgentAuth } from './contract';
import { getDb } from '@/db/client';
import { getRedis } from '@/lib/redis';
import { createAgentOAuthRepo } from '@/db/repos/agent-oauth-repo';
import { createAgentTokenStore } from './stores';
import { createAgentAuth } from './service';
import { agentGateOpen } from './gate';
import { recordAgentEvent } from './audit';

export * from './contract';

// Stage C1: the AI-agent auth the MCP endpoint uses (src/lib/agent-auth/service.ts), wired to
// Neon (the grant is THE authority) and Redis (access-token hashes). The MCP side imports only
// the contract types and this function.

let cached: AgentAuth | null = null;

export function getAgentAuth(): AgentAuth {
  if (!cached) {
    const db = getDb();
    const redis = getRedis();
    cached = createAgentAuth({
      repo: createAgentOAuthRepo(db),
      store: createAgentTokenStore(redis),
      now: Date.now,
      redis,
      gateOpen: (partnerId, phone) => agentGateOpen(db, partnerId, phone),
      audit: (e) => recordAgentEvent(db, e),
    });
  }
  return cached;
}
