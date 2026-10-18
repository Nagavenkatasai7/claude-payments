import { getDb } from '@/db/client';
import { createAgentOAuthRepo } from '@/db/repos/agent-oauth-repo';
import { agentGateOpen } from './gate';
import { recordAgentEvent } from './audit';
import { createAgentPortal, type AgentPortal } from './portal-apps';

// The production wiring of the portal "Connected AI apps" helper (Stage C1): Neon and the gate.
// Its own module so the portal layout pulls in nothing of the OAuth route handlers.

export function agentPortal(): AgentPortal {
  const db = getDb();
  return createAgentPortal({
    repo: createAgentOAuthRepo(db),
    now: Date.now,
    gateOpen: (partnerId, phone) => agentGateOpen(db, partnerId, phone),
    audit: (e) => recordAgentEvent(db, e),
  });
}
