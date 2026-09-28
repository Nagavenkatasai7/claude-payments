import { getPortalSessionStore, type PortalDevice } from './portal-session-store';
import type { PortalCustomerContext } from './portal-auth';

/**
 * portal-devices — the customer portal's Devices list (UI redesign M2-13, Task 13.1).
 *
 * The owner is ALWAYS (host partner, session phone) from the resolved portal context: the partner
 * from the Host (requirePortalSite → getSiteTenant), the phone from the Redis session record. Never a
 * form field. A row is the closed-set device label and two times, plus the opaque `sid` the page
 * posts back; never a token, a token hash, a phone, a raw user agent or an IP.
 */

export interface PortalDeviceRow extends PortalDevice {
  /** This row is the session the request came in on. */
  current: boolean;
}

/** The signed-in customer's live sessions, most recently active first, the current one marked. */
export async function listPortalDevices(ctx: Pick<PortalCustomerContext, 'site' | 'session'>): Promise<PortalDeviceRow[]> {
  const devices = await getPortalSessionStore().list(ctx.site.partnerId, ctx.session.phone);
  return devices.map((d) => ({
    sid: d.sid,
    device: d.device,
    createdAtMs: d.createdAtMs,
    lastSeenMs: d.lastSeenMs,
    current: d.sid === ctx.session.sid,
  }));
}

/** Per customer: 30 single-device sign-outs per hour (bounds audit-row spam; sign-out is idempotent). */
export const PORTAL_DEVICE_SIGNOUT_LIMIT = { scope: 'portal-device-signout', limit: 30, windowSec: 3600 } as const;
