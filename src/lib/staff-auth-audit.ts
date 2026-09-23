import { createHmac, hkdfSync } from 'node:crypto';
import { getDb } from '@/db/client';
import { createAuditRepo, type AuditEvent } from '@/db/repos/aux-repos';
import { env } from './env';
import { decodeMasterKey } from './field-crypto';
import { logWarn } from './log';
import type { PartnerId } from './types';

/**
 * staff-auth-audit — Program-Fix 17a. The `auth.*` trail for staff sign-in and
 * password changes, in the append-only `audit_events` table (free-text
 * `action`, no DDL).
 *
 * BEST-EFFORT and TIME-BOUNDED: staff login is Redis-only, so a Neon outage
 * (a throw OR a hang) must never block it. Each write races a deadline and is
 * wrapped in try/catch; a miss is a logWarn without the username or the IP.
 * Callers await `record()` (bounded by the deadline) and keep any redirect()
 * OUTSIDE their own try/catch.
 *
 * The IP is stored only as `meta.ipHash` = HMAC-SHA256 under a key derived
 * (HKDF, distinct `info`) from FIELD_ENCRYPTION_KEY — the same derivation
 * pattern as customer-ref.auditSubjectId. An unkeyed hash of an IPv4 address
 * is reversible by enumeration; a keyed one is not. No key ⇒ no ipHash.
 */

export type StaffAuthAction =
  | 'auth.login'
  | 'auth.login.failed'
  | 'auth.login.throttled'
  | 'auth.logout'
  | 'auth.password.change'
  | 'auth.password.reset';

export interface StaffAuthEvent {
  action: StaffAuthAction;
  /** 'staff' when a known staff member acted; 'system' (actor 'login') for failures. */
  actorType: 'staff' | 'system';
  actor: string;
  /** The affected staff username — set ONLY when that record exists. */
  subjectId?: string;
  partnerId?: PartnerId;
  /** Raw client IP; hashed (keyed) here, never stored. */
  ip?: string;
  meta?: Record<string, unknown>;
}

export const STAFF_AUTH_AUDIT_TIMEOUT_MS = 1500;
export const STAFF_AUTH_IP_INFO = 'smartremit/staff-auth-ip/v1';

export function deriveStaffIpKey(masterRaw: string | Buffer = env.fieldEncryptionKey): Buffer {
  return Buffer.from(hkdfSync('sha256', decodeMasterKey(masterRaw), '', STAFF_AUTH_IP_INFO, 32));
}

export function staffIpHash(ip: string, key: Buffer): string {
  return createHmac('sha256', key).update(ip).digest('hex').slice(0, 32);
}

export interface StaffAuthAuditDeps {
  record: (e: AuditEvent) => Promise<void>;
  ipKey?: () => Buffer;
  timeoutMs?: number;
  warn?: (message: string, fields?: Record<string, unknown>) => void;
}

export function createStaffAuthAudit(deps: StaffAuthAuditDeps) {
  const timeoutMs = deps.timeoutMs ?? STAFF_AUTH_AUDIT_TIMEOUT_MS;
  const warn = deps.warn ?? ((m: string, f?: Record<string, unknown>) => logWarn('staff.auth_audit', m, f));
  let key: Buffer | null | undefined;
  function ipKey(): Buffer | null {
    if (key === undefined) {
      try {
        key = (deps.ipKey ?? deriveStaffIpKey)();
      } catch {
        key = null;
      }
    }
    return key;
  }

  return {
    /** Never throws; resolves by the deadline at the latest. */
    async record(ev: StaffAuthEvent): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const meta: Record<string, unknown> = { ...(ev.meta ?? {}) };
        const k = ev.ip ? ipKey() : null;
        if (ev.ip && k) meta.ipHash = staffIpHash(ev.ip, k);
        const write = deps.record({
          actor: ev.actor,
          actorType: ev.actorType,
          action: ev.action,
          ...(ev.subjectId ? { subjectId: ev.subjectId } : {}),
          ...(ev.partnerId ? { partnerId: ev.partnerId } : {}),
          meta,
        });
        const deadline = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), timeoutMs);
        });
        // Promise.race subscribes to both: a late rejection of the losing write is absorbed.
        const outcome = await Promise.race([write.then(() => 'ok' as const), deadline]);
        if (outcome === 'timeout') warn('audit write timed out', { action: ev.action });
      } catch (err) {
        warn('audit write failed', { action: ev.action, error: err instanceof Error ? err.name : 'unknown' });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}

export type StaffAuthAudit = ReturnType<typeof createStaffAuthAudit>;

let cached: StaffAuthAudit | null = null;

export function getStaffAuthAudit(): StaffAuthAudit {
  if (!cached) cached = createStaffAuthAudit({ record: (e) => createAuditRepo(getDb()).record(e) });
  return cached;
}
