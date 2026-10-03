import type { DbOrTx } from '@/db/client';
import { createAuditRepo, type AuditEvent } from '@/db/repos/aux-repos';
import { auditSubjectId } from './customer-ref';
import { logWarn } from './log';
import { normalizePhone } from './phone';
import type { PartnerId } from './types';

/**
 * Portal auth audit (UI redesign M2). Dormant library: M2-5 wires it.
 *
 * One `audit_events` row per customer sign-in event, action `portal.auth.<event>`,
 * actor `system:customer-portal` (the customer is not staff: AuditEvent has no customer
 * actor type). The subject is auditSubjectId(partnerId, normalized phone), a keyed HMAC
 * bound to the tenant, never the phone.
 *
 * Defence in depth: meta may hold only flat primitives, may not use a key named phone,
 * code, otp, ip or email (any case), and may not carry the phone's digits in a value.
 * The guard runs before anything is hashed or written.
 *
 * recordPortalAuthEventSafe is for the unauthenticated login path: it never throws and
 * is time-bounded, so a DB error or hang never changes the response (no oracle). Its log
 * line is a fixed message: a driver error can embed the bound parameters.
 */

export type PortalAuthEvent =
  | 'otp_sent'
  | 'otp_refused'
  | 'otp_send_failed'
  | 'login_success'
  | 'login_failure'
  | 'login_locked'
  | 'mfa_failure'
  | 'register'
  | 'consent'
  | 'signout'
  | 'signout_one'
  | 'signout_all'
  | 'stepup_success'
  | 'stepup_failure'
  | 'mfa_recovery_requested';

const EVENTS: ReadonlySet<string> = new Set<PortalAuthEvent>([
  'otp_sent',
  'otp_refused',
  'otp_send_failed',
  'login_success',
  'login_failure',
  'login_locked',
  'mfa_failure',
  'register',
  'consent',
  'signout',
  'signout_one',
  'signout_all',
  'stepup_success',
  'stepup_failure',
  'mfa_recovery_requested',
]);

export const PORTAL_AUTH_ACTOR = 'system:customer-portal';
export const PORTAL_AUTH_AUDIT_TIMEOUT_MS = 1_500;

const FORBIDDEN_META_KEYS: ReadonlySet<string> = new Set(['phone', 'code', 'otp', 'ip', 'email']);

export type PortalAuthMeta = Record<string, string | number | boolean>;

export interface PortalAuthEventInput {
  partnerId: PartnerId;
  phone: string;
  event: PortalAuthEvent;
  meta?: PortalAuthMeta;
}

function buildEvent(e: PortalAuthEventInput): AuditEvent {
  if (!EVENTS.has(e.event)) throw new Error('portal auth audit: unknown event');
  const phone = normalizePhone(e.phone);
  if (!phone) throw new Error('portal auth audit: phone required');
  const meta = e.meta;
  if (meta !== undefined) {
    for (const [k, v] of Object.entries(meta)) {
      if (FORBIDDEN_META_KEYS.has(k.toLowerCase())) throw new Error('portal auth audit: forbidden meta key');
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
        throw new Error('portal auth audit: meta values must be primitives');
      }
      if (normalizePhone(String(v)).includes(phone)) throw new Error('portal auth audit: meta carries the phone');
    }
  }
  return {
    partnerId: e.partnerId,
    actor: PORTAL_AUTH_ACTOR,
    actorType: 'system',
    action: `portal.auth.${e.event}`,
    subjectId: auditSubjectId(e.partnerId, phone),
    ...(meta !== undefined ? { meta } : {}),
  };
}

/** Writes the row. Throws on a guard refusal or a DB failure. */
export async function recordPortalAuthEvent(db: DbOrTx, e: PortalAuthEventInput): Promise<void> {
  const event = buildEvent(e);
  await createAuditRepo(db).record(event);
}

/** Best-effort, time-bounded variant for the unauthenticated login path. Never throws. */
export async function recordPortalAuthEventSafe(
  db: DbOrTx,
  e: PortalAuthEventInput,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? PORTAL_AUTH_AUDIT_TIMEOUT_MS;
  const eventLabel = EVENTS.has(e.event) ? e.event : 'unknown';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      recordPortalAuthEvent(db, e).then(() => 'ok' as const),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      }),
    ]);
    if (outcome === 'timeout') {
      logWarn('portal.auth_audit', 'audit write timed out', { event: eventLabel });
    }
  } catch {
    logWarn('portal.auth_audit', 'audit write failed', { event: eventLabel });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
