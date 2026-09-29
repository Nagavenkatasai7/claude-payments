import { createHash, randomUUID } from 'node:crypto';
import { getDb, type DbOrTx } from '@/db/client';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { DEFAULT_PARTNER_ID } from './defaults';
import { env } from './env';
import type { RedisLike } from './store';
import type { PartnerRole } from './partner-access';
import type { PartnerId, Ticket, TicketKind, TicketStatus } from './types';

/**
 * partner-tickets: the tenant-scoped STAFF reads and input rules behind /partner/support
 * (UI redesign M3-19).
 *
 * The repo's listTickets treats a missing partnerId as "every tenant" (the platform queue), so
 * /partner never calls it directly. These wrappers REQUIRE the session tenant, throw on an empty
 * one, and pass it into the SQL WHERE. Who may see what mirrors the legacy surfaces:
 * - customer tickets (the tenant's support queue): admin and support see the tenant queue; an
 *   agent sees only the tickets assigned to them (requireTicketWorker + assertCanWork);
 * - "Contact SmartRemit" threads (kind 'internal', the platform employee-questions queue): a
 *   partner admin sees the tenant's threads; everyone else only the ones they opened
 *   (employee-questions/queries.ts).
 * Every miss (missing, another tenant's, the wrong kind, not yours) is the same null.
 *
 * The 'default' tenant has NO Contact SmartRemit surface: SmartRemit's own staff file their
 * internal questions under 'default' (employee-questions), so a partner-scoped record pinned to
 * 'default' must never read (or add to) that queue. It is closed for every role and every opener.
 */

export type TicketViewer = { role: PartnerRole; username: string };
export type TenantViewer = TicketViewer & { partnerId: PartnerId };

/** Refuse a missing or empty tenant: an empty partnerId would drop the WHERE (every tenant). */
function assertTenant(partnerId: PartnerId): void {
  if (typeof partnerId !== 'string' || partnerId.length === 0) throw new Error('partner-tickets: tenant required');
}

export interface TenantTicketQuery {
  kind?: TicketKind;
  status?: TicketStatus;
  assignedTo?: string;
  limit?: number;
}

/** One tenant's tickets, newest activity first. The tenant is required; opts cannot carry one. */
export async function listTenantTickets(
  partnerId: PartnerId,
  opts: TenantTicketQuery,
  db: DbOrTx = getDb(),
): Promise<Ticket[]> {
  assertTenant(partnerId);
  const { kind, status, assignedTo, limit } = opts;
  const rows = await createTicketRepo(db).listTickets({ kind, status, assignedTo, limit, partnerId });
  // Defence in depth: the WHERE already pins the tenant.
  return rows.filter((t) => t.partnerId === partnerId);
}

/** One ticket, only inside its own tenant (null otherwise: 404-never-403). */
export async function getTenantTicket(partnerId: PartnerId, id: string, db: DbOrTx = getDb()): Promise<Ticket | null> {
  assertTenant(partnerId);
  if (!isTicketId(id)) return null;
  const ticket = await createTicketRepo(db).getOwnedTicket(partnerId, id);
  return ticket && ticket.partnerId === partnerId ? ticket : null;
}

const TICKET_ROLES: readonly string[] = ['admin', 'agent', 'support'];

/** Pure: does this tenant have a Contact SmartRemit surface? Never the platform's own 'default'. */
export function contactAvailable(partnerId: PartnerId): boolean {
  return partnerId !== DEFAULT_PARTNER_ID;
}

/** Pure: may this tenant staff member see (and work) this ticket? Fails closed on an unknown role. */
export function canViewTicket(
  viewer: TicketViewer,
  ticket: Pick<Ticket, 'kind' | 'assignedTo' | 'openedBy'>,
): boolean {
  if (!TICKET_ROLES.includes(viewer.role)) return false;
  if (ticket.kind === 'customer') {
    return viewer.role === 'agent' ? ticket.assignedTo === viewer.username : true;
  }
  if (ticket.kind === 'internal') {
    return viewer.role === 'admin' ? true : ticket.openedBy === viewer.username;
  }
  return false;
}

/** A ticket of the expected kind that this viewer may see in their tenant, else null. */
export async function getVisibleTicket(
  viewer: TenantViewer,
  id: string,
  kind: TicketKind,
  db: DbOrTx = getDb(),
): Promise<Ticket | null> {
  if (kind === 'internal' && !contactAvailable(viewer.partnerId)) return null;
  const ticket = await getTenantTicket(viewer.partnerId, id, db);
  if (!ticket || ticket.kind !== kind) return null;
  return canViewTicket(viewer, ticket) ? ticket : null;
}

export const QUEUE_LIMIT = 100;

/** The customer-ticket queue this viewer may see. An agent's list is their assigned tickets. */
export async function listVisibleCustomerTickets(
  viewer: TenantViewer,
  opts: { status?: TicketStatus },
  db: DbOrTx = getDb(),
): Promise<Ticket[]> {
  if (!TICKET_ROLES.includes(viewer.role)) return [];
  const rows = await listTenantTickets(
    viewer.partnerId,
    {
      kind: 'customer',
      status: opts.status,
      ...(viewer.role === 'agent' ? { assignedTo: viewer.username } : {}),
      limit: QUEUE_LIMIT,
    },
    db,
  );
  return rows.filter((t) => canViewTicket(viewer, t));
}

/** The "Contact SmartRemit" threads this viewer may see (admin: the tenant's; others: their own). */
export async function listContactThreads(viewer: TenantViewer, db: DbOrTx = getDb()): Promise<Ticket[]> {
  if (!TICKET_ROLES.includes(viewer.role) || !contactAvailable(viewer.partnerId)) return [];
  // The repo has no openedBy filter; a non-admin's own threads are picked from a deeper tenant page
  // (the same approach as the legacy employee-questions list).
  const rows = await listTenantTickets(
    viewer.partnerId,
    { kind: 'internal', limit: viewer.role === 'admin' ? QUEUE_LIMIT : 500 },
    db,
  );
  return rows.filter((t) => canViewTicket(viewer, t)).slice(0, QUEUE_LIMIT);
}

// ── Input rules: bounded and refused, never silently truncated ──────────────────────────────

export const REPLY_MAX = 4000;
export const CONTACT_SUBJECT_MIN = 3;
export const CONTACT_SUBJECT_MAX = 120;
export const CONTACT_BODY_MIN = 10;
export const CONTACT_BODY_MAX = 2000;
/** At most this many open Contact SmartRemit threads per staff member. */
export const CONTACT_OPEN_CAP = 5;

const TICKET_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export function isTicketId(v: unknown): v is string {
  return typeof v === 'string' && TICKET_ID_RE.test(v);
}

function boundedText(v: unknown, min: number, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length >= min && s.length <= max ? s : null;
}

/** A staff reply, internal note or follow-up: 1..REPLY_MAX characters after trimming. */
export function parseStaffText(v: unknown): string | null {
  return boundedText(v, 1, REPLY_MAX);
}

export function parseContactSubject(v: unknown): string | null {
  return boundedText(v, CONTACT_SUBJECT_MIN, CONTACT_SUBJECT_MAX);
}

export function parseContactBody(v: unknown): string | null {
  return boundedText(v, CONTACT_BODY_MIN, CONTACT_BODY_MAX);
}

/**
 * The statuses a partner may set. `waiting_admin` (the platform escalation) is not offered, and
 * `closed` is terminal (the repo guard refuses every later move).
 */
export const PARTNER_TICKET_STATUSES = ['open', 'pending', 'resolved', 'closed'] as const;
export type PartnerTicketStatus = (typeof PARTNER_TICKET_STATUSES)[number];

export function parsePartnerTicketStatus(v: unknown): PartnerTicketStatus | null {
  return typeof v === 'string' && (PARTNER_TICKET_STATUSES as readonly string[]).includes(v)
    ? (v as PartnerTicketStatus)
    : null;
}

/** The queue filter (the page's ?status=): any ticket status, else none. */
const ALL_STATUSES: readonly TicketStatus[] = ['open', 'pending', 'waiting_admin', 'resolved', 'closed'];
export function parseQueueStatus(v: unknown): TicketStatus | undefined {
  return typeof v === 'string' && (ALL_STATUSES as readonly string[]).includes(v) ? (v as TicketStatus) : undefined;
}

// ── Double-submit guard ──────────────────────────────────────────────────────────────────────

const REQUEST_KEY_RE = /^[0-9a-f]{32}$/;
export function isRequestKey(v: unknown): v is string {
  return typeof v === 'string' && REQUEST_KEY_RE.test(v);
}

const SCOPE_RE = /^[a-z][a-z-]{0,23}$/;

/**
 * The claim key for one staff write: bound to the scope, the tenant, the user, the form's
 * server-minted request key AND the write itself (`target`: the ticket id and the text), hashed so
 * no raw input lands in a Redis key name. Binding the write means a reused key with a different
 * ticket or text is a new request, never a silent "sent" for a write that did not happen.
 */
export function staffClaimKey(scope: string, partnerId: PartnerId, username: string, requestKey: string, target: string): string {
  if (!SCOPE_RE.test(scope)) throw new Error('partner-tickets: invalid claim scope');
  assertTenant(partnerId);
  const digest = createHash('sha256')
    .update(JSON.stringify([partnerId, username, requestKey, target]))
    .digest('hex');
  return `psup:${scope}:${digest}`;
}

const CLAIM_TTL_S = 1800;
const PENDING = 'p';
const DONE_PREFIX = 'd:';

export type ClaimOutcome = { status: 'ran'; value: string } | { status: 'replay'; value: string } | { status: 'inflight' };

/**
 * Run `fn` at most once per claim key (SET NX EX). The winner runs and stores `d:<value>` (an id
 * only, never text), so a replay reports the same result without running again. A replay while
 * the first run is in flight reports `inflight`. A throw releases the claim so an honest retry
 * runs. When the done-mark cannot be stored, the pending claim stays: a replay then reads
 * "in flight" until the TTL, never a second write.
 */
export async function claimOnce(redis: RedisLike, key: string, fn: () => Promise<string>): Promise<ClaimOutcome> {
  const claimed = await redis.set(key, PENDING, { nx: true, ex: CLAIM_TTL_S });
  if (claimed === null) {
    const raw = await redis.get(key);
    return typeof raw === 'string' && raw.startsWith(DONE_PREFIX)
      ? { status: 'replay', value: raw.slice(DONE_PREFIX.length) }
      : { status: 'inflight' };
  }
  let value: string;
  try {
    value = await fn();
  } catch (err) {
    try {
      await redis.del(key);
    } catch {
      // Released by the TTL instead.
    }
    throw err;
  }
  try {
    await redis.set(key, `${DONE_PREFIX}${value}`, { ex: CLAIM_TTL_S });
  } catch {
    // Keep the pending claim (see above).
  }
  return { status: 'ran', value };
}

// ── Action helpers (kept out of the 'use server' modules, which may export only actions) ─────

/** Thrown inside a status transaction when the repo guard refuses the move (rolls it back). */
export class StatusRefusedError extends Error {
  constructor() {
    super('Status change refused');
    this.name = 'StatusRefusedError';
  }
}

/** Thrown inside the Contact create when the open-thread cap is reached (nothing is written). */
export class CapReachedError extends Error {
  constructor() {
    super('Open-thread cap reached');
    this.name = 'CapReachedError';
  }
}

/** An error's NAME only, for logs: a failed query's message carries its bound params (the text). */
export function errName(e: unknown): string {
  return e instanceof Error ? e.name : 'error';
}

/** The customer-facing link in a ticket nudge (the same one the platform ticket actions send). */
export function ticketNudgeUrl(ticketId: string): string {
  return `${env.appBaseUrl}/account/support/${ticketId}`;
}

/**
 * Which of these usernames are members of THIS tenant (and so may be shown by name on its pages).
 * Platform staff and anyone else render as a neutral label: a tenant page never lists SmartRemit
 * staff usernames. One lookup per distinct name; a failed lookup names nobody.
 */
export async function tenantStaffUsernames(
  partnerId: PartnerId,
  usernames: readonly string[],
  getStaff: (username: string) => Promise<{ partnerId?: string } | null>,
): Promise<Set<string>> {
  const out = new Set<string>();
  const distinct = [...new Set(usernames.filter((u) => typeof u === 'string' && u.length > 0))];
  await Promise.all(
    distinct.map(async (u) => {
      try {
        const s = await getStaff(u);
        if (s && s.partnerId === partnerId) out.add(u);
      } catch {
        // Unknown ⇒ not named.
      }
    }),
  );
  return out;
}

/**
 * A short per-(tenant, user) lock around a check-then-create (the Contact SmartRemit open-thread
 * cap), so concurrent submits with fresh request keys cannot all pass the check. Returns false
 * when another submit holds it. The TTL bounds a crashed holder.
 */
export async function withUserLock<T>(
  redis: RedisLike,
  scope: string,
  partnerId: PartnerId,
  username: string,
  fn: () => Promise<T>,
): Promise<{ locked: false } | { locked: true; value: T }> {
  if (!SCOPE_RE.test(scope)) throw new Error('partner-tickets: invalid lock scope');
  assertTenant(partnerId);
  const key = `psup:lock:${scope}:${createHash('sha256').update(JSON.stringify([partnerId, username])).digest('hex')}`;
  const token = randomUUID();
  if ((await redis.set(key, token, { nx: true, ex: 30 })) === null) return { locked: false };
  try {
    return { locked: true, value: await fn() };
  } finally {
    try {
      // Release only our own lock: if fn outlived the TTL and another request took the lock, leave it.
      // (get-then-del is not atomic; the window is a few ms, and the worst case is one extra thread.)
      if ((await redis.get(key)) === token) await redis.del(key);
    } catch {
      // Released by the TTL instead.
    }
  }
}
