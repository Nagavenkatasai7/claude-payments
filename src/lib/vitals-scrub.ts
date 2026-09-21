// Vercel Speed Insights `beforeSend` scrubber — strips anything that could be a
// token, id or PII from the page URL before a web-vitals beacon leaves the
// browser. Pure (type-only import), and it NEVER throws: on any doubt it returns
// null, which drops the event (dropping a metric is always better than leaking).
//
// Contract (node_modules/@vercel/speed-insights/dist/index.d.ts:15-20):
//   beforeSend(event: { type: 'vital'; url: string; route?: string })
//     => event | null | undefined | false
// The hosted script (/_vercel/speed-insights/script.js, v0.1.3) calls it once
// per metric with url = location.href and route = the component's data-route,
// and sends ONLY the returned `url` in place of the href; a falsy return drops
// the metric. The route it sends comes from data-route, which the Next
// component computes as the templated route (e.g. /pay/[transferId]).
//
// Rules: query + hash always dropped; path := the templated route when present
// (the event is DROPPED if that route itself carries an id); otherwise a known
// dynamic page maps to its template and id-shaped segments become [id].

import type { BeforeSendMiddleware } from '@vercel/speed-insights';

type VitalsEvent = Parameters<BeforeSendMiddleware>[0];

/** Every dynamic page under src/app (pinned to the filesystem by the test). */
export const DYNAMIC_PAGE_ROUTES = [
  '/account/receipt/[transferId]',
  '/account/support/[ticketId]',
  '/admin-dashboard/customers/[phone]',
  '/admin-dashboard/employee-questions/[ticketId]',
  '/admin-dashboard/partner-requests/[id]',
  '/admin-dashboard/partners/[id]',
  '/admin-dashboard/tickets/[ticketId]',
  '/admin-dashboard/transactions/[id]',
  '/onboard/seller/[id]',
  '/partners/apply/[token]',
  '/pay/[transferId]',
  '/pay/b2b/[invoiceId]',
] as const;

const TEMPLATES = DYNAMIC_PAGE_ROUTES.map((r) => r.split('/'));

/** Static folders that sit beside a dynamic sibling (support/new vs support/[ticketId]). */
const STATIC_SIBLINGS = new Set(['new', 'my-queue', 'b2b']);
/** Static route folders that contain a digit. */
const STATIC_DIGIT_SEGMENTS = new Set(['b2b']);

const MASK = '[id]';
const PARAM = /^\[{1,2}(?:\.\.\.)?[A-Za-z_$][\w$]*\]{1,2}$/; // [transferId], [...slug], [[...slug]]
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HYPHENATED_WORDS = /^[a-z]+(?:-[a-z]+)+$/; // employee-questions, partner-requests
const ROUTE_FOLDER_CHARS = /^[a-z-]+$/;

function looksLikeId(seg: string): boolean {
  if (UUID.test(seg)) return true;
  if (/\d/.test(seg)) return !STATIC_DIGIT_SEGMENTS.has(seg); // base36 ids, phones, numeric ids
  if (seg.includes('_')) return true; // tk_ / inv_ / preq_ / s_ / txn_ style ids
  if (seg.length >= 16 && !HYPHENATED_WORDS.test(seg)) return true; // long tokens
  return !ROUTE_FOLDER_CHARS.test(seg); // %, +, @, ., uppercase: not a route folder
}

function matchTemplate(segs: string[]): string | null {
  for (const tpl of TEMPLATES) {
    if (tpl.length !== segs.length) continue;
    const hit = tpl.every((t, i) =>
      PARAM.test(t) ? segs[i] !== '' && !STATIC_SIBLINGS.has(segs[i]) : t === segs[i],
    );
    if (hit) return tpl.join('/');
  }
  return null;
}

function scrubPath(path: string): string {
  const segs = path.split('/');
  return (
    matchTemplate(segs) ??
    segs.map((s) => (s === '' || PARAM.test(s) || !looksLikeId(s) ? s : MASK)).join('/')
  );
}

export function scrubVitalsEvent(event: VitalsEvent): VitalsEvent | null {
  try {
    const raw: unknown = event.url;
    if (typeof raw !== 'string' || raw === '') return null;

    let prefix: string;
    let pathname: string;
    if (raw.startsWith('/') && !raw.startsWith('//')) {
      prefix = '';
      pathname = new URL(raw, 'https://relative.invalid').pathname;
    } else {
      const u = new URL(raw);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      prefix = u.origin; // origin carries no userinfo, query or hash
      pathname = u.pathname;
    }

    // The hosted script sends `route` verbatim (it only takes `url` from our
    // return value), so a route that would itself need scrubbing — an unmatched
    // /404 path, or an id the SDK failed to template — cannot be made safe here.
    // Drop the metric instead.
    const rawRoute: unknown = event.route;
    let route: string | undefined;
    if (typeof rawRoute === 'string' && rawRoute !== '') {
      if (!rawRoute.startsWith('/') || scrubPath(rawRoute) !== rawRoute) return null;
      route = rawRoute;
    }
    const url = prefix + (route ?? scrubPath(pathname));

    return route === undefined ? { type: event.type, url } : { type: event.type, url, route };
  } catch {
    return null;
  }
}
