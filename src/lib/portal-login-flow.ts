import { headers } from 'next/headers';
import { getDb } from '@/db/client';
import { getRedis } from './redis';
import { checkIpRateLimit, clientIpFrom } from './ip-rate-limit';
import { getPortalOtpStore } from './portal-otp-store';
import { alertPortalOtpFailure, portalOtpDeliverable, sendPortalOtp, type PortalOtpReady } from './portal-otp-sender';
import { recordPortalAuthEventSafe, type PortalAuthEvent } from './portal-auth-audit';
import { afterPortalResponse, portalCustomers } from './portal-auth';
import type { PartnerId } from './types';

/**
 * portal-login-flow — the shared halves of the customer-portal sign-in and step-up actions
 * (UI redesign M2-5). Not a server module: the actions in the src/app/portal action modules call these.
 */

/** Per-IP verify attempts (codes, TOTP, consent): 60 per hour. */
export const PORTAL_VERIFY_IP_LIMIT = { scope: 'portal-verify-ip', limit: 60, windowSec: 3600 } as const;

export type PortalReady = Extract<PortalOtpReady, { ready: true }>;

export const field = (fd: FormData, name: string) => String(fd.get(name) ?? '');

/** The per-IP verdict for this request (the first x-forwarded-for hop: clientIpFrom). */
export async function ipAllowed(limit: { scope: string; limit: number; windowSec: number }): Promise<boolean> {
  const ip = clientIpFrom(await headers());
  const r = await checkIpRateLimit(getRedis(), limit.scope, ip, { limit: limit.limit, windowSec: limit.windowSec });
  return r.allowed;
}

/** A best-effort, time-bounded portal auth audit row (never throws). */
export const portalAudit = (partnerId: PartnerId, phone: string, event: PortalAuthEvent, meta?: Record<string, string | number | boolean>) =>
  recordPortalAuthEventSafe(getDb(), { partnerId, phone, event, ...(meta ? { meta } : {}) });

/**
 * The phone-dependent half of a code request, run AFTER the response (review round 1, M1): the
 * tenant-keyed customer lookup (knownCustomer), the OTP issue, the template send, every audit row and
 * every alert. `ipOk` and `ready` were computed on the request path, where they are phone-independent.
 * The code goes only to sendPortalOtp; it is never returned, logged or stored in plaintext.
 *
 * Freeform mode (the default tenant without a template, owner 2026-09-29): the 24h-window check is
 * phone-dependent, so it runs HERE, before the issue. Outside the window nothing is issued (no
 * cooldown claimed, so the customer can message us and ask again at once), the attempt is audited
 * `outside_window`, and there is NO ops alert: it is the customer's state, not a broken channel.
 */
export function issueAndSendAfterResponse(partnerId: PartnerId, phone: string, purpose: 'login' | 'stepup', ipOk: boolean, ready: PortalReady) {
  return afterPortalResponse('portal.otp', async () => {
    if (!ipOk) {
      await portalAudit(partnerId, phone, 'otp_refused', { reason: 'ip_limit' });
      return;
    }
    if (!(await portalOtpDeliverable(partnerId, phone, ready))) {
      await portalAudit(partnerId, phone, 'otp_send_failed', { why: 'outside_window' });
      return;
    }
    const known = (await portalCustomers().getCustomer(partnerId, phone)) !== null;
    const issued = await getPortalOtpStore().issue(partnerId, phone, purpose, { knownCustomer: known });
    if (!issued.ok) {
      await portalAudit(partnerId, phone, 'otp_refused', { reason: issued.reason });
      if (issued.reason === 'partner_ceiling') await alertPortalOtpFailure(partnerId, 'partner_ceiling');
      return;
    }
    const sent = await sendPortalOtp(partnerId, phone, issued.code, ready);
    if (sent.ok) {
      await portalAudit(partnerId, phone, 'otp_sent', { purpose });
    } else if ('reason' in sent) {
      // The window closed between the check above and the send: the customer's state, no alert.
      await portalAudit(partnerId, phone, 'otp_send_failed', { why: sent.reason });
    } else {
      await portalAudit(partnerId, phone, 'otp_send_failed', { why: 'send_failed', ...(sent.code !== undefined ? { graph: sent.code } : {}) });
      await alertPortalOtpFailure(partnerId, 'send_failed');
    }
  });
}
