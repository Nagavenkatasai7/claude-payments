import { createHash, randomBytes } from 'node:crypto';
import type { RedisLike } from './store';
import { parseQuery, parseStatusGroup, type PortalOwner, type PortalStatusGroup } from './portal-transfers';

/**
 * portal-transfer-filter — the transfer list's search and status filter WITHOUT a name in any URL
 * (UI redesign M2-7, Task 7.2). A recipient name is PII-ish, so the search form POSTs to a server
 * action that stores the filter under a short-lived Redis key and redirects with `?f=<opaque id>`.
 *
 * The key is `pfilt:<sha256(partnerId|phone|f)>` (review round 1, L3): an `f` pasted into another
 * customer's session (or another partner's host) resolves to nothing. TTL 30 minutes.
 */

export const PORTAL_FILTER_TTL_S = 1800;
const F_RE = /^[0-9a-f]{32}$/;

export interface PortalTransferFilter {
  status?: PortalStatusGroup;
  q?: string;
}

function filterKey(owner: PortalOwner, f: string): string {
  return `pfilt:${createHash('sha256').update(`${owner.partnerId}|${owner.phone}|${f}`).digest('hex')}`;
}

/** Store a filter; returns the opaque id for the URL, or null when the filter is empty. */
export async function saveTransferFilter(redis: RedisLike, owner: PortalOwner, input: { status?: unknown; q?: unknown }): Promise<string | null> {
  const filter: PortalTransferFilter = {};
  const status = parseStatusGroup(input.status);
  const q = parseQuery(input.q);
  if (status) filter.status = status;
  if (q) filter.q = q;
  if (!filter.status && !filter.q) return null;
  const f = randomBytes(16).toString('hex');
  await redis.set(filterKey(owner, f), JSON.stringify(filter), { ex: PORTAL_FILTER_TTL_S });
  return f;
}

/** The filter behind `f` for THIS customer, or null (unknown, expired, another customer's, malformed). */
export async function loadTransferFilter(redis: RedisLike, owner: PortalOwner, f: unknown): Promise<PortalTransferFilter | null> {
  if (typeof f !== 'string' || !F_RE.test(f)) return null;
  const raw = await redis.get(filterKey(owner, f));
  if (typeof raw !== 'string') return null;
  try {
    const v = JSON.parse(raw) as { status?: unknown; q?: unknown };
    const out: PortalTransferFilter = {};
    const status = parseStatusGroup(v?.status);
    const q = parseQuery(v?.q);
    if (status) out.status = status;
    if (q) out.q = q;
    return out;
  } catch {
    return null;
  }
}
