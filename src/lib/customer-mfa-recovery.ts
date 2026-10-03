import { createHash } from 'node:crypto';
import { getDb, type Db, type DbOrTx } from '@/db/client';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { getRedis } from './redis';
import { pokeWorker } from './outbox';
import { getCustomerMfaStore, dropMfaRedisState, type CustomerKey } from './customer-mfa';
import { getPortalSessionStore } from './portal-session-store';
import { getCustomerAuthStore } from './customer-auth-store';
import { verifiedReceiptEmail } from './portal-prefs';
import { PORTAL_AUTH_ACTOR } from './portal-auth-audit';
import { auditSubjectId } from './customer-ref';
import { MFA_RECOVERY_CATEGORY } from './ticket-category';
import { newTransferId } from './id';
import { logWarn } from './log';
import { t, type MessageKey } from './i18n';
import type { RedisLike } from './store';
import type { PartnerId, Ticket, TicketStatus } from './types';

/**
 * customer-mfa-recovery: the lost-authenticator recovery (lost-features p4 B4, hardened per the
 * review's BL-3). Two-step verification is never removed by the customer alone: a customer who
 * already proved their phone (the portal WhatsApp code, or the /account password) opens a support
 * request, and staff turn the factor off only after checking it is them.
 *
 * REQUEST (openMfaRecoveryRequest): enrolled customers only. ONE open request per (partner, phone)
 * (findOpenCustomerTicketByCategory, behind a short Redis lock so two submits open one), at most
 * RECOVERY_DAILY_CAP new requests per customer per UTC day. The ticket has a fixed category,
 * subject and first message, priority urgent, and is NOT sent to AI triage (triage would replace
 * the category; keepsCategoryOnTriage and the repo's setTriage guard keep it anyway). The ticket,
 * its audit row and the notices (WhatsApp, plus email when a VERIFIED address is on file) commit
 * in one transaction.
 *
 * DECISION (approveMfaRecovery / declineMfaRecovery): the caller has already gated the approver
 * (platform admin, or an admin of the ticket's own tenant, with a fresh step-up) and resolved the
 * ticket in its scope. The tenant and phone come ONLY from that ticket row. Approval needs an ID
 * document check or a confirmed recent transfer, and without the ID document it waits until
 * RECOVERY_COOL_OFF_MS after the request. The status move is the guard: it is checked in the
 * UPDATE (a partner's also refuses waiting_admin, a request escalated to SmartRemit), so a double
 * click or a lost race writes nothing. Factor clear, ticket resolve, messages, audit rows and the
 * notices commit together; the sign-outs run after the commit, best effort.
 */

export const MFA_RECOVERY_SUBJECT = 'Lost authenticator app: turn off two-step verification';
export const MFA_RECOVERY_BODY =
  'I lost access to my authenticator app. Please turn off two-step verification for my account after checking it is me.';

/** What staff may record they checked. At least one STRONG check is required. */
export const RECOVERY_CHECKS = ['id_document', 'recent_transfer', 'kyc_name', 'callback'] as const;
export type RecoveryCheck = (typeof RECOVERY_CHECKS)[number];
const STRONG_CHECKS: readonly RecoveryCheck[] = ['id_document', 'recent_transfer'];

export const RECOVERY_DECLINE_REASONS = ['not_verified', 'no_response', 'duplicate'] as const;
export type RecoveryDeclineReason = (typeof RECOVERY_DECLINE_REASONS)[number];

/** Without an ID document check, approval waits this long after the request. */
export const RECOVERY_COOL_OFF_MS = 24 * 60 * 60 * 1000;
/** New requests per (partner, phone) per UTC day. */
export const RECOVERY_DAILY_CAP = 3;
const LOCK_TTL_S = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The /admin-dashboard refusal for an ordinary reply / resolve / close on a recovery ticket (that
 * surface has no catalogue). /partner uses partner.support.mfaRecovery.locked.
 */
export const RECOVERY_LOCKED_MESSAGE = 'This is a two-step recovery request. Approve or decline it in the recovery card.';

// ── Pure rules ───────────────────────────────────────────────────────────────

/** A two-step recovery request: only the dedicated approve and decline actions may move it. */
export function isRecoveryTicket(ticket: Pick<Ticket, 'kind' | 'category'>): boolean {
  return ticket.kind === 'customer' && ticket.category === MFA_RECOVERY_CATEGORY;
}

/** An OPEN request this module opened: the category, the fixed subject and a customer phone. */
function isOpenRecoveryRequest(ticket: Ticket): boolean {
  return (
    isRecoveryTicket(ticket) &&
    ticket.subject === MFA_RECOVERY_SUBJECT &&
    typeof ticket.customerPhone === 'string' &&
    ticket.customerPhone.length > 0 &&
    ticket.status !== 'resolved' &&
    ticket.status !== 'closed'
  );
}

/** The checks from a form: known values once each, in RECOVERY_CHECKS order; null without a strong one. */
export function parseRecoveryChecks(values: readonly unknown[]): RecoveryCheck[] | null {
  const picked = RECOVERY_CHECKS.filter((c) => values.includes(c));
  return picked.some((c) => STRONG_CHECKS.includes(c)) ? picked : null;
}

export function parseDeclineReason(v: unknown): RecoveryDeclineReason | null {
  return typeof v === 'string' && (RECOVERY_DECLINE_REASONS as readonly string[]).includes(v) ? (v as RecoveryDeclineReason) : null;
}

/** When a request made at `requestedAt` may be approved with these checks (epoch ms). */
export function recoveryApprovableAt(requestedAt: string, checks: readonly RecoveryCheck[]): number {
  const at = Date.parse(requestedAt);
  return checks.includes('id_document') ? at : at + RECOVERY_COOL_OFF_MS;
}

/** A fixed UTC label for the end of the wait (the action's refusal and the staff card agree). */
export function recoveryTimeLabel(ms: number): string {
  const when = new Date(ms).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
  // Some ICU versions put a narrow no-break space before AM/PM: one plain space everywhere.
  return `${when.replace(/\s+/g, ' ')} UTC`;
}

/** What the approve / decline actions on both dashboards return (`error` is fixed copy). */
export type RecoveryActionResult = { ok: true; outcome: 'approved' | 'already_off' | 'declined' } | { ok: false; error: string };

// ── Dependencies (one seam for tests) ────────────────────────────────────────

export interface RecoveryDeps {
  db: Db;
  redis: RedisLike;
  now: () => number;
  isEnrolled(k: CustomerKey): Promise<boolean>;
  poke(): void;
  revokePortalSessions(partnerId: PartnerId, phone: string): Promise<unknown>;
  revokeLegacySessions(phone: string): Promise<unknown>;
}

function resolveDeps(d: Partial<RecoveryDeps>): RecoveryDeps {
  return {
    db: d.db ?? getDb(),
    redis: d.redis ?? getRedis(),
    now: d.now ?? (() => Date.now()),
    isEnrolled: d.isEnrolled ?? ((k) => getCustomerMfaStore().isEnrolled(k)),
    poke: d.poke ?? pokeWorker,
    revokePortalSessions: d.revokePortalSessions ?? ((p, phone) => getPortalSessionStore().revokeAll(p, phone)),
    revokeLegacySessions: d.revokeLegacySessions ?? ((phone) => getCustomerAuthStore().deleteAllSessions(phone)),
  };
}

const rowHash = (k: CustomerKey) => createHash('sha256').update(`${k.partnerId}|${k.phone}`).digest('hex');
const lockKey = (k: CustomerKey) => `mfarec:lock:${rowHash(k)}`;
const dayKey = (k: CustomerKey, nowMs: number) => `mfarec:n:${rowHash(k)}:${Math.floor(nowMs / DAY_MS)}`;
const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

/** The customer's verified email address, else null. Never throws (a notice is extra, not required). */
async function verifiedEmailFor(db: DbOrTx, k: CustomerKey): Promise<string | null> {
  try {
    const customer = await createCustomerRepo(db, async () => null).getCustomer(k.partnerId, k.phone);
    if (!customer) return null;
    return await verifiedReceiptEmail(db, customer);
  } catch (err) {
    logWarn('mfa.recovery', 'verified email read failed', { error: errName(err) });
    return null;
  }
}

/** The WhatsApp notice (and the email when an address is verified), inside the caller's transaction. */
async function enqueueNotices(tx: DbOrTx, k: CustomerKey, email: string | null, key: MessageKey, prefix: string, ticketId: string): Promise<void> {
  const body = t(key);
  const out = createOutboxRepo(tx);
  // Essential: it is about the customer's account security, so it is sent even after STOP.
  await out.enqueue('whatsapp.text', { to: k.phone, body, partnerId: k.partnerId, category: 'essential' }, { dedupeKey: `${prefix}:${ticketId}` });
  if (email) {
    await out.enqueue('email.send', { to: [email], subject: t('mfaRecovery.email.subject'), text: body }, { dedupeKey: `${prefix}mail:${ticketId}` });
  }
}

// ── Request ──────────────────────────────────────────────────────────────────

export type RecoveryRequestOutcome = 'opened' | 'already_open' | 'not_enrolled' | 'limited';

/**
 * Open (or find) the customer's recovery request. `partnerId` and `phone` come from the caller's
 * server-side proof (the portal's pending record, or the /account pending token's account row),
 * never a form. Throws on a store or database error: the caller answers with its generic failure.
 */
export async function openMfaRecoveryRequest(
  input: { partnerId: PartnerId; phone: string; via: 'portal' | 'account' },
  deps: Partial<RecoveryDeps> = {},
): Promise<RecoveryRequestOutcome> {
  const d = resolveDeps(deps);
  const k: CustomerKey = { partnerId: input.partnerId, phone: input.phone };
  if (!(await d.isEnrolled(k))) return 'not_enrolled';

  // A short lock so two submits cannot both pass the "already open" check below.
  if ((await d.redis.set(lockKey(k), '1', { nx: true, ex: LOCK_TTL_S })) === null) return 'already_open';
  try {
    const tickets = createTicketRepo(d.db);
    if (await tickets.findOpenCustomerTicketByCategory(k.partnerId, k.phone, MFA_RECOVERY_CATEGORY)) return 'already_open';

    const counter = dayKey(k, d.now());
    const n = await d.redis.incr(counter);
    if (n === 1) await d.redis.expire(counter, 2 * 24 * 60 * 60);
    if (n > RECOVERY_DAILY_CAP) return 'limited';

    const email = await verifiedEmailFor(d.db, k);
    const ticketId = `tk_${newTransferId()}`;
    await d.db.transaction(async (tx) => {
      await createTicketRepo(tx).createTicket({
        id: ticketId,
        partnerId: k.partnerId,
        kind: 'customer',
        customerPhone: k.phone,
        subject: MFA_RECOVERY_SUBJECT,
        body: MFA_RECOVERY_BODY,
        category: MFA_RECOVERY_CATEGORY,
        priority: 'urgent',
      });
      await createAuditRepo(tx).record({
        partnerId: k.partnerId,
        // The portal's own actor; the legacy /account keeps its historical one (customer-mfa.ts).
        actor: input.via === 'portal' ? PORTAL_AUTH_ACTOR : 'customer-portal',
        actorType: 'system',
        action: 'customer.mfa.recovery.request',
        subjectId: auditSubjectId(k.partnerId, k.phone),
        meta: { ticketId, via: input.via },
      });
      await enqueueNotices(tx, k, email, 'mfaRecovery.notice.requested', 'mfarecreq', ticketId);
    });
    d.poke();
    return 'opened';
  } finally {
    await d.redis.del(lockKey(k));
  }
}

// ── Decision ─────────────────────────────────────────────────────────────────

export interface RecoveryApprover {
  username: string;
  scope: 'platform' | 'partner';
}

/**
 * not_recovery: not an open request this module opened (nothing written).
 * checks: no ID document and no recent transfer recorded. cool_off: the 24-hour wait is not over.
 * stale: the guarded status move refused (already handled, closed, or for a partner, escalated).
 */
export type RecoveryApproveOutcome = 'approved' | 'already_off' | 'not_recovery' | 'checks' | 'cool_off' | 'stale';
export type RecoveryDeclineOutcome = 'declined' | 'not_recovery' | 'stale';

class StaleRecoveryError extends Error {
  constructor() {
    super('Recovery request moved');
    this.name = 'StaleRecoveryError';
  }
}

/** The statuses the decision may not move the request out of (closed is terminal in the repo). */
function lockedFrom(approver: RecoveryApprover): TicketStatus[] {
  // A partner never decides a request escalated to SmartRemit; checked in the same UPDATE.
  return approver.scope === 'partner' ? ['resolved', 'closed', 'waiting_admin'] : ['resolved', 'closed'];
}

export async function approveMfaRecovery(
  ticket: Ticket,
  approver: RecoveryApprover,
  rawChecks: readonly unknown[],
  deps: Partial<RecoveryDeps> = {},
): Promise<RecoveryApproveOutcome> {
  if (!isOpenRecoveryRequest(ticket)) return 'not_recovery';
  const checks = parseRecoveryChecks(rawChecks);
  if (!checks) return 'checks';
  const d = resolveDeps(deps);
  if (!checks.includes('id_document') && d.now() < recoveryApprovableAt(ticket.createdAt, checks)) return 'cool_off';

  // The tenant and phone of THIS ticket row; nothing from the approver's request.
  const k: CustomerKey = { partnerId: ticket.partnerId, phone: ticket.customerPhone };
  const email = await verifiedEmailFor(d.db, k);
  let wasOn: boolean;
  try {
    wasOn = await d.db.transaction(async (tx) => {
      const tickets = createTicketRepo(tx);
      const moved = await tickets.updateStatus(ticket.id, 'resolved', { notFrom: lockedFrom(approver) });
      if (!moved || moved.partnerId !== k.partnerId || moved.customerPhone !== k.phone || !isRecoveryTicket(moved)) {
        throw new StaleRecoveryError();
      }
      const on = await createCustomerRepo(tx, async () => null).clearMfa(k.partnerId, k.phone);
      await tickets.appendMessage({
        ticketId: ticket.id,
        actorType: 'system',
        actorId: 'system',
        body: t('mfaRecovery.note.approved', { actor: approver.username, checks: checks.join(', ') }),
        internal: true,
      });
      await tickets.appendMessage({
        ticketId: ticket.id,
        actorType: 'staff',
        actorId: approver.username,
        body: t('mfaRecovery.notice.approved'),
        internal: false,
      });
      const audit = createAuditRepo(tx);
      await audit.record({
        partnerId: k.partnerId,
        actor: approver.username,
        actorType: 'staff',
        action: 'customer.mfa.reset',
        subjectId: auditSubjectId(k.partnerId, k.phone),
        meta: { via: 'support_review', ticketId: ticket.id, wasOn: on },
      });
      await audit.record({
        partnerId: k.partnerId,
        actor: approver.username,
        actorType: 'staff',
        action: 'customer.mfa.recovery.approve',
        subjectId: ticket.id,
        meta: { checks, actorScope: approver.scope },
      });
      await enqueueNotices(tx, k, email, 'mfaRecovery.notice.approved', 'mfarecok', ticket.id);
      return on;
    });
  } catch (err) {
    if (err instanceof StaleRecoveryError) return 'stale';
    throw err;
  }

  // After the commit, best effort: the factor is already off, so a failure here only leaves a
  // session or a stale replay marker behind until it expires.
  const steps: Array<[string, () => Promise<unknown>]> = [
    ['redis', () => dropMfaRedisState(d.redis, k)],
    ['portal_sessions', () => d.revokePortalSessions(k.partnerId, k.phone)],
    // The legacy /account session store is keyed by phone only, so this signs the number out of
    // /account at every tenant. That only ever ends sessions; it never grants one.
    ['legacy_sessions', () => d.revokeLegacySessions(k.phone)],
  ];
  for (const [step, run] of steps) {
    try {
      await run();
    } catch (err) {
      logWarn('mfa.recovery', 'after-approval step failed', { step, ticketId: ticket.id, error: errName(err) });
    }
  }
  d.poke();
  return wasOn ? 'approved' : 'already_off';
}

export async function declineMfaRecovery(
  ticket: Ticket,
  approver: RecoveryApprover,
  reason: RecoveryDeclineReason,
  deps: Partial<RecoveryDeps> = {},
): Promise<RecoveryDeclineOutcome> {
  if (!isOpenRecoveryRequest(ticket)) return 'not_recovery';
  const d = resolveDeps(deps);
  const k: CustomerKey = { partnerId: ticket.partnerId, phone: ticket.customerPhone };
  const email = await verifiedEmailFor(d.db, k);
  try {
    await d.db.transaction(async (tx) => {
      const tickets = createTicketRepo(tx);
      const moved = await tickets.updateStatus(ticket.id, 'resolved', { notFrom: lockedFrom(approver) });
      if (!moved || moved.partnerId !== k.partnerId || moved.customerPhone !== k.phone || !isRecoveryTicket(moved)) {
        throw new StaleRecoveryError();
      }
      await tickets.appendMessage({
        ticketId: ticket.id,
        actorType: 'system',
        actorId: 'system',
        body: t('mfaRecovery.note.declined', { actor: approver.username, reason }),
        internal: true,
      });
      await tickets.appendMessage({
        ticketId: ticket.id,
        actorType: 'staff',
        actorId: approver.username,
        body: t('mfaRecovery.notice.declined'),
        internal: false,
      });
      await createAuditRepo(tx).record({
        partnerId: k.partnerId,
        actor: approver.username,
        actorType: 'staff',
        action: 'customer.mfa.recovery.decline',
        subjectId: ticket.id,
        meta: { reason, actorScope: approver.scope },
      });
      await enqueueNotices(tx, k, email, 'mfaRecovery.notice.declined', 'mfarecno', ticket.id);
    });
  } catch (err) {
    if (err instanceof StaleRecoveryError) return 'stale';
    throw err;
  }
  d.poke();
  return 'declined';
}
