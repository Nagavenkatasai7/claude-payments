// Fix pack 5 T4 (P7, P11): every error class of the pack's new
// settlement.instruct refusals, the allow-list classifier that tells a
// transient error (database, network, timeout) from anything else, and the
// one railrecord alert key. drainOnce (outbox-worker.ts) learns their
// dispositions; later tasks only THROW them.
//
// Imports only db-error.ts: never the worker, instruction-compliance or a
// repo, so no import cycle (instruction-compliance re-exports
// ComplianceBlockUnavailableError from here). Every message holds ids and
// codes only (it reaches outbox.last_error and alerts).
import { isDriverError, isQueryError } from './db-error';

export type InstructPermanentCode = 'decrypt' | 'build' | 'compliance_block';

/**
 * A settlement instruction that can never be built for this transfer (G1 a
 * sealed column that does not open, G15 the builder or the compliance block).
 * TERMINAL: drainOnce marks the row dead at once with the existing dead:<id>
 * alert, so ops Retry and partner Replay still work once the data is fixed.
 */
export class InstructPermanentError extends Error {
  constructor(
    readonly transferId: string,
    readonly code: InstructPermanentCode,
    opts?: { cause?: unknown },
  ) {
    super(`instruct_permanent:${code}:${transferId}`, opts);
    this.name = 'InstructPermanentError';
  }
}

/**
 * G15: the compliance block could not be read because of a transient error.
 * A charged retry under the instruct policy, with one
 * `instructblock:<railPartnerId>:<hour>` alert from attempt 3 (never railfail:
 * the rail itself did not fail).
 */
export class ComplianceBlockUnavailableError extends Error {
  constructor(
    readonly transferId: string,
    readonly railPartnerId: string,
    opts?: { cause?: unknown },
  ) {
    super(`compliance_block_unavailable:${transferId}`, opts);
    this.name = 'ComplianceBlockUnavailableError';
  }
}

/** How long an instruction whose funding does not match the recorded funding mode waits (G14b). */
export const INSTRUCT_FUNDING_MODE_DEFER_SEC = 900;

/** G14b: deferred UNCHARGED; the handler raised `fundmode:<id>`. */
export class InstructFundingModeError extends Error {
  constructor(readonly delaySec: number = INSTRUCT_FUNDING_MODE_DEFER_SEC) {
    super('instruct_funding_mode');
    this.name = 'InstructFundingModeError';
  }
}

/** How long an instruction held by the travel rule waits (G16). */
export const INSTRUCT_TRAVEL_RULE_DEFER_SEC = 900;

/** G16: deferred UNCHARGED; the handler raised `travelrule:<id>`. */
export class InstructTravelRuleError extends Error {
  constructor(readonly delaySec: number = INSTRUCT_TRAVEL_RULE_DEFER_SEC) {
    super('instruct_travel_rule');
    this.name = 'InstructTravelRuleError';
  }
}

/**
 * G17 (and the reverse record): the rail message could not be recorded before
 * sending, so nothing was sent. A charged retry under the row kind's policy,
 * with one `railrecord:<hour>` alert. Deliberately NOT a RailInstructError:
 * it never raises railfail (rail health and routing read that key).
 */
export class RailRecordError extends Error {
  constructor(
    readonly transferId: string,
    opts?: { cause?: unknown },
  ) {
    super(`rail_record_failed:${transferId}`, opts);
    this.name = 'RailRecordError';
  }
}

const TRANSIENT_NAMES = new Set(['AbortError', 'TimeoutError', 'NeonDbError']);
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN']);
// The Neon pool's own connection errors carry NO SQLSTATE and are not wrapped
// by drizzle (NeonSession.transaction awaits client.connect() outside the
// DrizzleQueryError wrapper, node_modules/drizzle-orm/neon-serverless/session.js:178-179;
// messages at node_modules/@neondatabase/serverless/index.mjs:1010, :1113, :1120).
const POOL_TIMEOUT = 'timeout exceeded when trying to connect';
const POOL_TERMINATED = /^Connection terminated/;

function field(o: object, key: string): unknown {
  try {
    return (o as Record<string, unknown>)[key];
  } catch {
    return undefined; // a throwing getter
  }
}

function transientSelf(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if (isQueryError(err) || isDriverError(err)) return true;
  const name = field(err, 'name');
  if (typeof name === 'string' && TRANSIENT_NAMES.has(name)) return true;
  const code = field(err, 'code');
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
  const message = field(err, 'message');
  if (err instanceof TypeError && message === 'fetch failed') return true;
  if (typeof message === 'string' && (message === POOL_TIMEOUT || POOL_TERMINATED.test(message))) return true;
  // A WebSocket ErrorEvent (the Neon socket's error event): by its constructor name.
  const ctor = field(err, 'constructor');
  if (typeof ctor === 'function' && ctor.name === 'ErrorEvent') return true;
  return false;
}

/**
 * P7 allow-list: true only for a database, network or timeout error that a
 * retry may heal (the error itself or its direct `cause`, one level). Anything
 * else (a decrypt failure, a programming error, a non-object) is false. Used
 * only by G1 (behind TransferDecryptError) and G15. Never throws.
 */
export function isTransientInstructError(err: unknown): boolean {
  try {
    if (transientSelf(err)) return true;
    if (typeof err !== 'object' || err === null) return false;
    return transientSelf(field(err, 'cause'));
  } catch {
    return false;
  }
}

/** P7: a message that names the field-crypto key configuration (field-crypto.ts key-ring errors). */
const KEY_CONFIG_MESSAGE = /FIELD_ENCRYPTION_KEY|FIELD_ENCRYPTION_PREVIOUS_KEYS|FIELD_ENCRYPTION_CURRENT_KID|unknown key id/;

function keyConfigSelf(v: unknown): boolean {
  if (typeof v === 'string') return KEY_CONFIG_MESSAGE.test(v);
  if (!(v instanceof Error)) return false;
  const message = field(v, 'message');
  return typeof message === 'string' && KEY_CONFIG_MESSAGE.test(message);
}

/**
 * P7 (G1, and G15 since review round 1 RA2): true when the error, or its
 * direct `cause` (an Error, or a string cause; one level), names the key
 * configuration. A key-ring misconfiguration heals when the env is fixed, so
 * both gates keep today's charged retry for it instead of dead-lettering. A
 * top-level non-Error is false. Never throws.
 */
export function isKeyConfigError(err: unknown): boolean {
  try {
    if (!(err instanceof Error)) return false;
    return keyConfigSelf(err) || keyConfigSelf(field(err, 'cause'));
  } catch {
    return false;
  }
}

/** The ONE railrecord alert key (P30), shared by the worker (T4/T9) and the payment-webhook route (T10). */
export function railRecordAlertKey(nowMs: number = Date.now()): string {
  return `railrecord:${Math.floor(nowMs / 3_600_000)}`;
}
