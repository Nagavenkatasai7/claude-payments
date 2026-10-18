import { getDb } from '@/db/client';
import { createAgentOAuthRepo } from '@/db/repos/agent-oauth-repo';
import { getRedis } from '@/lib/redis';
import { env } from '@/lib/env';
import { checkIpRateLimit, clientIpFrom } from '@/lib/ip-rate-limit';
import { raiseLimiterDownAlert } from '@/lib/limiter-alert';
import { getPortalSite } from '@/lib/portal-site';
import { getPortalCustomer, isPortalSessionFresh } from '@/lib/portal-auth';
import { AGENT_IP_LIMITS, siteHostFor } from './config';
import { agentGateOpen, agentToolsOn } from './gate';
import { recordAgentEvent } from './audit';
import { createAgentTokenStore } from './stores';
import type { AgentServerDeps, HostCtx } from './server';
import type { AgentSession, AuthorizeDeps } from './authorize-flow';

// The production wiring of the AI-agent sign-in's route handlers (src/app/oauth/**,
// src/app/.well-known/**). Kept apart from the rules (server.ts, authorize-flow.ts) so the
// rules are tested without a request scope.

/**
 * The tenant of THIS request, from the Host alone (getPortalSite: the partner site, the portal
 * switched on and enabled for that partner, the partner active). null on the apex, a preview,
 * localhost or any failure, so every route answers 404 there, like /portal/*.
 */
export async function agentHostCtx(): Promise<HostCtx | null> {
  const site = await getPortalSite();
  return site ? { partnerId: site.partnerId, host: siteHostFor(site.slug) } : null;
}

/** Per-IP limit (checkIpRateLimit). FAILS OPEN on a limiter error, with the deduped limiter-down alert. */
async function ipLimited(name: keyof typeof AGENT_IP_LIMITS, req: Request): Promise<boolean> {
  const l = AGENT_IP_LIMITS[name];
  try {
    const r = await checkIpRateLimit(getRedis(), l.scope, clientIpFrom(req.headers), { limit: l.limit, windowSec: l.windowSec });
    return !r.allowed;
  } catch {
    try {
      void raiseLimiterDownAlert(l.scope, 'fail-open').catch(() => {});
    } catch {
      /* never let the signal break fail-open */
    }
    return false;
  }
}

export function agentServerDeps(): AgentServerDeps {
  const db = getDb();
  return {
    repo: createAgentOAuthRepo(db),
    store: createAgentTokenStore(getRedis()),
    now: Date.now,
    pepper: env.passwordPepper,
    toolsOn: (partnerId) => agentToolsOn(db, partnerId),
    gateOpen: (partnerId, phone) => agentGateOpen(db, partnerId, phone),
    audit: (e) => recordAgentEvent(db, e),
    limited: ipLimited,
  };
}

/** The signed-in portal customer on this host, with the 15-minute step-up answer. */
async function portalSession(): Promise<AgentSession | null> {
  const ctx = await getPortalCustomer();
  if (!ctx) return null;
  return { phone: ctx.session.phone, sid: ctx.session.sid, fresh: await isPortalSessionFresh(ctx) };
}

export function authorizeDeps(): AuthorizeDeps {
  return { ...agentServerDeps(), session: portalSession, isDev: process.env.NODE_ENV === 'development' };
}
