'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { requirePortalSite } from '@/lib/portal-site';
import { getPortalSessionStore, PORTAL_SESSION_COOKIE } from '@/lib/portal-session-store';
import { clearPortalCookie } from '@/lib/portal-auth';
import { portalAudit } from '@/lib/portal-login-flow';

/**
 * Sign out of the customer portal (UI redesign M2-5). A public POST endpoint: host gate first; the
 * session is resolved on THIS host (another partner's cookie is never touched), destroyed, the
 * cookie cleared with its __Host- attributes, and the event audited. Idempotent.
 */
export async function signOutAction(): Promise<void> {
  const site = await requirePortalSite();
  const token = (await cookies()).get(PORTAL_SESSION_COOKIE)?.value;
  if (token) {
    try {
      const store = getPortalSessionStore();
      const session = await store.resolve(token, site.partnerId);
      if (session) {
        await store.destroy(token);
        await portalAudit(site.partnerId, session.phone, 'signout');
      }
    } catch {
      /* the cookie is cleared below either way */
    }
  }
  await clearPortalCookie();
  redirect('/portal/login');
}
