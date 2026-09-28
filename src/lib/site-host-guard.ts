import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { parseSiteHost } from './site-host';

/**
 * site-host-guard — every server action outside the customer portal refuses to run on a partner
 * subdomain (UI redesign M2, X15).
 *
 * Why: once a page path is allowlisted on `<slug>.smartremit.ai`, Next accepts a POST to it that
 * names ANY server-action id, and the action handler runs whichever id the request names, including
 * one that belongs to a legacy apex module (next/dist/server/app-render/action-handler.js). So each
 * legacy action (customer /account, staff dashboard, public forms) calls this as its FIRST statement,
 * and tests/site-host-guard.test.ts scans every 'use server' module to prove it.
 *
 * Pure host parsing (the same parseSiteHost the proxy uses): no resolver, no Redis, no DB, so it is
 * cheap and cannot fail open on an outage. Stricter than "partner site only": ANY non-apex host
 * (a partner site or a refused *.smartremit.ai name) is refused. The apex, www, previews and
 * localhost resolve.
 *
 * notFound() works in Server Functions (node_modules/next/dist/docs/01-app/03-api-reference/
 * 04-functions/not-found.md:15); headers() is async in this Next (headers.md).
 */
export async function refuseOnSiteHost(): Promise<void> {
  const h = await headers();
  if (parseSiteHost(h.get('host')).kind !== 'apex') notFound();
}
