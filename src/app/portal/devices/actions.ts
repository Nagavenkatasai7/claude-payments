'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requirePortalSite } from '@/lib/portal-site';
import { clearPortalCookie, requireFreshPortalAuth, requirePortalCustomer } from '@/lib/portal-auth';
import { getPortalSessionStore } from '@/lib/portal-session-store';
import { portalAudit } from '@/lib/portal-login-flow';
import { PORTAL_DEVICE_SIGNOUT_LIMIT } from '@/lib/portal-devices';
import { checkIpRateLimit } from '@/lib/ip-rate-limit';
import { auditSubjectId } from '@/lib/customer-ref';
import { getRedis } from '@/lib/redis';
import { logWarn } from '@/lib/log';
import type { MessageKey } from '@/lib/i18n';

/**
 * The Devices page's sign-out actions (UI redesign M2-13, Task 13.1). PUBLIC POST endpoints (Next
 * checks Origin against Host for server actions):
 *  1. requirePortalSite() FIRST (the dark-by-default host gate; the scanner pins it);
 *  2. the session gate: requirePortalCustomer for one device, requireFreshPortalAuth (the 15-minute
 *     step-up) for every device;
 *  3. the owner is (host partner, session phone), never a form field. The posted `sid` is only
 *     looked up inside THAT customer's device index, so another customer's or partner's sid is simply
 *     "not listed": the same "done" copy, nothing revoked, no oracle;
 *  4. revocation deletes the Redis index entry and record: Redis is the authority, so a cookie the
 *     proxy re-sets afterwards is still signed out on the next request.
 * Sign-outs are naturally idempotent (a delete), so there is no request key (the plan's table).
 */

export type PortalDeviceActionState = { notice?: MessageKey; error?: MessageKey } | null;

const DONE: PortalDeviceActionState = { notice: 'portal.devices.signed_out' };

/** Sign out ONE of my devices. My current device is a normal sign-out (cookie cleared, to sign-in). */
export async function signOutDeviceAction(_prev: PortalDeviceActionState, formData: FormData): Promise<PortalDeviceActionState> {
  await requirePortalSite();
  const ctx = await requirePortalCustomer();
  const partnerId = ctx.site.partnerId;
  const phone = ctx.session.phone;
  const sid = String(formData.get('sid') ?? '');

  try {
    const rl = await checkIpRateLimit(getRedis(), PORTAL_DEVICE_SIGNOUT_LIMIT.scope, auditSubjectId(partnerId, phone), {
      limit: PORTAL_DEVICE_SIGNOUT_LIMIT.limit,
      windowSec: PORTAL_DEVICE_SIGNOUT_LIMIT.windowSec,
    });
    if (!rl.allowed) return { error: 'portal.devices.rate_limited' };
  } catch (err) {
    logWarn('portal.devices.rate_limit', err); // fail-open: signing out is protective
  }

  const store = getPortalSessionStore();
  if (sid === ctx.session.sid) {
    await store.destroy(ctx.token);
    await portalAudit(partnerId, phone, 'signout_one', { current: true });
    await clearPortalCookie();
    redirect('/portal/login');
  }

  // Index-scoped: a sid outside (partnerId, phone)'s own index returns false and changes nothing.
  if (await store.revoke(partnerId, phone, sid)) {
    await portalAudit(partnerId, phone, 'signout_one', { current: false });
  }
  revalidatePath('/portal/devices');
  return DONE;
}

/** Sign out of EVERY device, this one included (step-up first), then back to sign-in. */
export async function signOutEverywhereAction(): Promise<void> {
  await requirePortalSite();
  const ctx = await requireFreshPortalAuth('/portal/devices');
  const partnerId = ctx.site.partnerId;
  const phone = ctx.session.phone;
  const store = getPortalSessionStore();
  const ended = await store.revokeAll(partnerId, phone);
  await store.destroy(ctx.token); // belt and braces: this session is gone even if the index missed it
  await clearPortalCookie();
  await portalAudit(partnerId, phone, 'signout_all', { count: ended });
  redirect('/portal/login');
}
