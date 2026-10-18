'use server';

import { revalidatePath } from 'next/cache';
import { requirePortalSite } from '@/lib/portal-site';
import { requirePortalCustomer } from '@/lib/portal-auth';
import { agentPortal } from '@/lib/agent-auth/portal-wiring';
import { logWarn } from '@/lib/log';
import type { MessageKey } from '@/lib/i18n';

/**
 * "Connected AI apps" — Disconnect (Stage C1 spec item 10). A PUBLIC POST endpoint (Next checks
 * Origin against Host for server actions):
 *  1. requirePortalSite() FIRST (the dark-by-default host gate; tests/portal-actions-gate pins it);
 *  2. the session gate (requirePortalCustomer). No step-up: disconnecting only takes access away,
 *     like signing out a device;
 *  3. the owner is (host partner, session phone), never a form field. The posted grant id is only
 *     looked up inside THAT customer's grants, so another customer's or tenant's id changes nothing
 *     and gets the same "done" copy (no oracle);
 *  4. the grant row is revoked (refresh stops; every access token fails the live-grant check on
 *     its next MCP request) and an `agent.grant.revoked` audit row is written.
 */

export type AgentAppActionState = { notice?: MessageKey; error?: MessageKey } | null;

export async function disconnectAgentAppAction(_prev: AgentAppActionState, formData: FormData): Promise<AgentAppActionState> {
  await requirePortalSite();
  const ctx = await requirePortalCustomer();
  try {
    await agentPortal().disconnect(ctx.site.partnerId, ctx.session.phone, formData.get('grant'));
  } catch (err) {
    logWarn('portal.agent_apps.disconnect', err instanceof Error ? err.name : 'error');
    return { error: 'portal.agentApps.failed' };
  }
  revalidatePath('/portal/ai-apps');
  return { notice: 'portal.agentApps.disconnected' };
}
