import { and, desc, eq, lt } from 'drizzle-orm';
import type { DbOrTx } from '@/db/client';
import { partnerWebhookDeliveries } from '@/db/schema';
import { logWarn } from '@/lib/log';

// webhook-delivery-log (UI redesign M3-15b): the worker's record of each settlement-instruction POST
// to a partner rail, shown to that partner on /partner/integrations/webhooks. One
// partner_webhook_deliveries row per attempt (migration 0028): the rail owner, the transfer id (the
// rail already received it), the outbox row id, the attempt number, the outcome class, the HTTP status
// integer and the latency. Never a URL, a body, a secret, an error text or a customer field: the
// table has no column for them and nothing here reads one.
//
// BEST-EFFORT BY CONTRACT. The record must never change a money outcome:
//   • it never throws (every failure is caught and logged by error NAME, with ids only: a Postgres
//     CHECK/FK error can echo the row);
//   • it is capped at DELIVERY_LOG_TIMEOUT_MS. A stalled insert that outlived the worker's row
//     deadline would turn a delivered instruction into a retryable one and re-POST it;
//   • it writes through the worker's db, outside any transaction, after the POST has settled.
// Like the 15a test ping (partner-settlement-endpoint.ts sendTestPing), no URL or body is stored.

/** The most a delivery record may add to a settlement.instruct row (see the worker's ROW_DEADLINE_MS). */
export const DELIVERY_LOG_TIMEOUT_MS = 2_000;

export type InstructOutcome = 'ok' | 'http_error' | 'network';

export interface InstructDeliveryMeta {
  /** The RAIL OWNER whose endpoint was called (transfer.settlementPartnerId ?? transfer.partnerId). */
  partnerId: string;
  transferId: string;
  outboxId: number;
  /** The outbox row's attempt number (claimBatch charges it before the handler runs). */
  attempt: number;
}

export interface InstructDelivery extends InstructDeliveryMeta {
  outcome: InstructOutcome;
  httpStatus: unknown;
  latencyMs: number;
}

class DeliveryLogTimeout extends Error {
  constructor() {
    super('delivery log write timed out');
    this.name = 'DeliveryLogTimeout';
  }
}

const statusOf = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599 ? v : null);
const latencyOf = (v: number): number => (Number.isFinite(v) && v > 0 ? Math.min(Math.round(v), 2_147_483_647) : 0);
const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

/** One delivery row. Never throws, never takes longer than `timeoutMs`. */
export async function recordInstructDelivery(db: DbOrTx, d: InstructDelivery, timeoutMs = DELIVERY_LOG_TIMEOUT_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const write = Promise.resolve(
      db.insert(partnerWebhookDeliveries).values({
        partnerId: d.partnerId,
        kind: 'settlement.instruct',
        subjectId: d.transferId,
        outboxId: d.outboxId,
        attempt: d.attempt,
        outcome: d.outcome,
        httpStatus: statusOf(d.httpStatus),
        latencyMs: latencyOf(d.latencyMs),
      }),
    );
    write.catch(() => {}); // a write that loses the race below must not surface as an unhandled rejection
    const cap = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DeliveryLogTimeout()), timeoutMs);
    });
    await Promise.race([write, cap]);
  } catch (err) {
    logWarn('outbox.delivery-log', errName(err), { partnerId: d.partnerId, outboxId: d.outboxId });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Runs the instruction POST and records its outcome. The response is returned and the error rethrown
 * UNCHANGED: the caller's success/failure handling is exactly what it was without the log.
 */
export async function withInstructDeliveryLog(db: DbOrTx, meta: InstructDeliveryMeta, post: () => Promise<Response>): Promise<Response> {
  const started = performance.now();
  let res: Response;
  try {
    res = await post();
  } catch (err) {
    await recordInstructDelivery(db, { ...meta, outcome: 'network', httpStatus: null, latencyMs: performance.now() - started });
    throw err;
  }
  if (res && typeof res === 'object') {
    await recordInstructDelivery(db, { ...meta, outcome: res.ok ? 'ok' : 'http_error', httpStatus: res.status, latencyMs: performance.now() - started });
  }
  return res;
}

// ── The /partner delivery log reader ─────────────────────────────────────────────────────────────

/** Rows per page of the partner delivery log. */
export const DELIVERY_PAGE_SIZE = 50;

export interface DeliveryView {
  id: number;
  kind: string;
  /** The transfer id for an instruction (the rail owner already received it); null for a ping. */
  subjectId: string | null;
  outcome: string;
  httpStatus: number | null;
  latencyMs: number | null;
  attempt: number;
  createdAt: Date;
}

/**
 * A strict keyset cursor: a positive decimal integer id, nothing else. It is only a position inside
 * the tenant's own rows (the WHERE below always carries the tenant), so a crafted value can at most
 * page within them.
 */
export function parseDeliveryCursor(v: unknown): number | null {
  return parsePositiveId(v);
}

/** A positive decimal integer id (a form field or query value), else null. No signs, spaces, exponents or leading zeros. */
export function parsePositiveId(v: unknown): number | null {
  if (typeof v !== 'string' || !/^[1-9]\d{0,14}$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * The tenant's deliveries (instructions and test pings), newest first, keyset-paged on the identity
 * id (monotonic, no sub-millisecond timestamp ties). Never the outbox id, a URL or a body.
 */
export async function listDeliveries(db: DbOrTx, partnerId: string, opts: { before?: number | null }): Promise<{ rows: DeliveryView[]; nextBefore: number | null }> {
  const d = partnerWebhookDeliveries;
  const rows = await db
    .select({ id: d.id, kind: d.kind, subjectId: d.subjectId, outcome: d.outcome, httpStatus: d.httpStatus, latencyMs: d.latencyMs, attempt: d.attempt, createdAt: d.createdAt })
    .from(d)
    .where(opts.before ? and(eq(d.partnerId, partnerId), lt(d.id, opts.before)) : eq(d.partnerId, partnerId))
    .orderBy(desc(d.id))
    .limit(DELIVERY_PAGE_SIZE + 1);
  const more = rows.length > DELIVERY_PAGE_SIZE;
  const page = more ? rows.slice(0, DELIVERY_PAGE_SIZE) : rows;
  return { rows: page, nextBefore: more ? page[page.length - 1].id : null };
}
