import type { AgentOAuthRepo, CustomerGrantRow } from '@/db/repos/agent-oauth-repo';
import { normalizePhone } from '@/lib/phone';
import type { PartnerId } from '@/lib/types';
import type { AgentAuditInput } from './audit';
import { GRANT_ID_RE } from './config';

// The portal's "Connected AI apps" (Stage C1 spec item 10), scoped to the signed-in customer's
// (host partner, session phone). Shown while the gate is open OR the customer still has a live
// grant, so a customer can always disconnect an app, even after the switch went off or their
// phone left demo mode. A disconnect revokes the grant row (refresh stops at once, and every
// access token fails the live-grant check on its next MCP request) and writes the audit row.

export interface AgentPortalDeps {
  repo: AgentOAuthRepo;
  now: () => number;
  gateOpen(partnerId: PartnerId, phone: string): Promise<boolean>;
  audit(e: AgentAuditInput): Promise<void>;
}

export const AGENT_APPS_NAV_TIMEOUT_MS = 1_000;

export function createAgentPortal(deps: AgentPortalDeps) {
  return {
    /** Should the page (and its nav item) show? Fails CLOSED (false) on any error or after the timeout. */
    async visible(partnerId: PartnerId, phoneRaw: unknown, timeoutMs = AGENT_APPS_NAV_TIMEOUT_MS): Promise<boolean> {
      const phone = normalizePhone(phoneRaw);
      if (!phone || !partnerId) return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const answer = (async () =>
          (await deps.gateOpen(partnerId, phone)) || (await deps.repo.hasCustomerGrants(partnerId, phone, new Date(deps.now()))))();
        return await Promise.race([
          answer,
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
          }),
        ]);
      } catch {
        return false;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },

    list(partnerId: PartnerId, phone: string): Promise<CustomerGrantRow[]> {
      return deps.repo.listCustomerGrants(partnerId, normalizePhone(phone), new Date(deps.now()));
    },

    /**
     * Disconnect one of MY apps. A grant id that is malformed, another customer's, another tenant's
     * or already gone changes nothing and answers the same (false), so there is no oracle.
     */
    async disconnect(partnerId: PartnerId, phoneRaw: string, grantId: unknown): Promise<boolean> {
      const phone = normalizePhone(phoneRaw);
      if (!phone || typeof grantId !== 'string' || !GRANT_ID_RE.test(grantId)) return false;
      const revoked = await deps.repo.revokeCustomerGrant(partnerId, phone, grantId, new Date(deps.now()));
      if (!revoked) return false;
      await deps.audit({ partnerId, phone, clientId: revoked.clientId, action: 'agent.grant.revoked', meta: { grantId, reason: 'customer' } });
      return true;
    },
  };
}

export type AgentPortal = ReturnType<typeof createAgentPortal>;
