import { getRedis } from './redis';
import type { RedisLike, Store } from './store';
import type { CustomerStore } from './customer-store';
import { createCustomerStore, getCustomerStore } from './customer-store';
import type { Customer, PartnerId } from './types';
import type { Db } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { auditSubjectId } from './customer-ref';
import { logWarn } from './log';
import { isScreeningCustomerHold } from './compliance-config';
import { legacyKeyAllowed, legacyTenantResolver } from './legacy-tenant';
import type { KycDelta } from './kyc-state-machine';
import { applyKycEvent } from './kyc-state-machine';
import type { PersonaEvent } from './providers/persona-webhook-parse';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { pokeWorker } from '@/lib/outbox';
import { readSenderScreeningFlags } from '@/db/repos/customer-repo';
import { clearPepInTx, KycScreeningChangedError } from './sender-screening';
import { senderPepOnly } from './hold-queue';
import type { KycDecisionExtraMeta } from './partner-reviews';
import { sanitizeKycExtraMeta } from './partner-kyc-decision';

/**
 * kyc-case-store (Phase 2, Task 9) — the KYC review case layer.
 *
 * Owns: webhook idempotency (each Persona event id processed once), applying a
 * `KycDelta` to the Customer (Persona-driven review-state moves), the HUMAN
 * review transition (the only path that moves `kycStatus` to verified/rejected),
 * an append-only audit log, and the review queue.
 *
 * Program-Fix 28 (compliance-03): a STAFF decision passed `durable` options is
 * recorded in Postgres `audit_events` in the SAME transaction as the customer
 * write (the durable record). The Redis hash below stays as the transitional
 * trail: it still carries Persona events (applyDelta) and pre-fix history, and
 * a durable decision's Redis copy is tagged `durable: true` so the page does not
 * show it twice (the old build, during a rollout, still shows it).
 *
 * Fix pack 7 (P22): `review`'s durable options also take `extraMeta`, `pepClear` and
 * `pepClearable` for a partner that decides KYC (DurableReviewOpts); every option absent ⇒ the
 * same statements, rows and meta as before.
 */

const EVT_TTL = 30 * 24 * 60 * 60; // 30d replay-dedup window
/**
 * Program-Fix 35: the FIRST mark is short-lived. A process killed mid-apply
 * (no release, no confirm) leaves a mark that lapses in 5 min, so Persona's
 * retry is processed; confirmEventSeen extends it to EVT_TTL on success.
 */
const EVT_PENDING_TTL = 5 * 60;
const evtKey = (id: string) => `sr_kyc_evt:${id}`;
const auditKey = (partnerId: PartnerId, phone: string) => `kyc_audit:${partnerId}:${phone}`;
/** Pre-fix-1 phone-only trail — read-only fallback for the phone's pre-fix tenant (D10). */
const legacyAuditKey = (phone: string) => `kyc_audit:${phone}`;

export interface AuditMeta {
  actor: string;
  action: string;
  reason?: string;
}
export interface AuditEntry extends AuditMeta {
  at: string;
  /** Program-Fix 28: true when an audit_events row holds this decision (the page skips it). */
  durable?: boolean;
}

/**
 * Program-Fix 28: the options that make review() durable. `actor` is the
 * staff member's stable username (the audit row's actor); the `reviewer`
 * display string still goes to kycApprovedBy and meta.reviewerName.
 */
export interface DurableReviewOpts {
  db: Db;
  store: Store;
  actor: string;
  slug: string;
  source: 'persona_review' | 'manual';
  /**
   * Program-Fix 43 follow-up: true only when the deciding staffer is PLATFORM
   * staff. A watchlist / PEP hold (isScreeningCustomerHold) is re-checked on
   * the LOCKED row and refused unless this is true (absent ⇒ refused), so a
   * match that lands between the action's read and the lock is still caught.
   */
  allowScreeningHold?: boolean;
  /**
   * Merge plan 2c: the deciding staffer's scope, recorded as meta.actorScope. OPTIONAL and set
   * only by the /partner decision ('partner'); absent ⇒ the meta is byte-identical to before.
   */
  actorScope?: 'platform' | 'partner';
  /**
   * Fix pack 7 (P22): the closed disposition / EDD keys of a partner that decides KYC, merged
   * into the decision's audit meta through sanitizeKycExtraMeta (closed keys, bounded,
   * number-free note). Absent ⇒ the meta is byte-identical to before.
   */
  extraMeta?: KycDecisionExtraMeta;
  /**
   * Fix pack 7 (P22, P23): a partner that decides KYC acts on a PEP-only flag. Inside the
   * locked transaction the row must be PEP-only (senderPepOnly: no watchlist hit, no uncovered
   * watchlist stamp) at the posted flag time, else KycScreeningChangedError (nothing written).
   * An approve then clears the PEP-only hold through clearPepInTx before the save; a reject only
   * re-checks. Absent ⇒ today.
   */
  pepClear?: { reviewedFlaggedAt: string };
  /**
   * Fix pack 7 (P22): the locked re-check uses isScreeningCustomerHold(c, { pepClearable: true })
   * (a PEP-only hit already lifted by a later clear no longer refuses; a watchlist hit or stamp
   * still does). The caller passes partnerDecidesKyc(owner). Absent ⇒ today's rule.
   */
  pepClearable?: boolean;
}

/** The posted reviewed flag time as ISO ('' for none); null when unreadable (admin customers/actions.ts reviewedFlaggedAt). */
function normaliseFlaggedAt(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (v === '') return '';
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** One line of the customer page's KYC audit trail. */
export interface KycTrailLine {
  at: string;
  actor: string;
  action: string;
  reason: string | undefined;
}

/**
 * Program-Fix 28: the page trail = the durable audit_events rows PLUS the
 * legacy Redis entries NOT tagged `durable: true` (pre-fix history, Persona
 * events, and anything the old build wrote during a rollout). No timestamp
 * matching: a durable decision's Redis copy is skipped by its tag alone.
 * Oldest first. Pure.
 */
export function mergeKycTrail(
  durable: ReadonlyArray<{ actor: string; action: string; at: string; meta: Record<string, unknown> }>,
  legacy: ReadonlyArray<AuditEntry>,
): KycTrailLine[] {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
  const lines: KycTrailLine[] = [
    ...durable.map((r) => ({ at: r.at, actor: str(r.meta.reviewerName) ?? r.actor, action: r.action, reason: str(r.meta.reason) })),
    ...legacy.filter((e) => e.durable !== true).map((e) => ({ at: e.at, actor: e.actor, action: e.action, reason: e.reason })),
  ];
  return lines.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/**
 * Program-Fix 35: the options for the webhook's durable apply. `alertMessage`
 * builds the kycmatch ops-alert text (ids only) for the committed review state
 * — 'held' or the human-terminal state the match left untouched; it is
 * enqueued only for a `*.matched` event. It receives only that literal, never
 * the customer row (the outbox payload scan, tests/outbox-payload-secrets).
 */
export interface PersonaApplyOpts {
  db: Db;
  store: Store;
  alertMessage?: (state: 'held' | 'approved' | 'rejected') => string;
}

export interface PersonaApplyResult {
  before: Customer;
  after: Customer;
  changed: boolean;
}

export function createKycCaseStore(
  redis: RedisLike,
  customers: CustomerStore,
  now: () => number = () => Date.now(),
) {
  async function appendAudit(partnerId: PartnerId, phone: string, entry: AuditEntry): Promise<void> {
    const existing = await redis.hgetall(auditKey(partnerId, phone));
    // HGETALL is a FLAT [field0, value0, ...] array under
    // automaticDeserialization:false (see getAudit) — so the entry count is
    // length/2, not Object.keys().length (which would double it on the real client).
    const seq = Array.isArray(existing)
      ? Math.floor(existing.length / 2)
      : Object.keys(existing ?? {}).length;
    // Field = `<iso>#<seq>` so entries sort chronologically and never collide.
    await redis.hset(auditKey(partnerId, phone), { [`${entry.at}#${String(seq).padStart(6, '0')}`]: JSON.stringify(entry) });
  }

  return {
    /** True the FIRST time an event id is seen; false on replay (Persona re-delivers + reorders). */
    async markEventSeen(eventId: string): Promise<boolean> {
      const r = await redis.set(evtKey(eventId), '1', { nx: true, ex: EVT_PENDING_TTL });
      return r !== null;
    },

    /** Program-Fix 35: the event was processed — keep its mark for the full replay window. */
    async confirmEventSeen(eventId: string): Promise<void> {
      await redis.expire(evtKey(eventId), EVT_TTL);
    },

    /**
     * Program-Fix 35: release an event id marked by markEventSeen, so Persona's
     * retry of an event whose processing THREW is processed instead of deduped.
     */
    async unmarkEventSeen(eventId: string): Promise<void> {
      await redis.del(evtKey(eventId));
    },

    async applyDelta(partnerId: PartnerId, phone: string, delta: KycDelta, meta: AuditMeta): Promise<Customer | null> {
      const c = await customers.getCustomer(partnerId, phone);
      if (!c) return null;
      const nowIso = new Date(now()).toISOString();
      const updated: Customer = { ...c, ...delta, updatedAt: nowIso };
      await customers.saveCustomer(updated);
      await appendAudit(partnerId, phone, { ...meta, at: nowIso });
      return updated;
    },

    /**
     * Program-Fix 35 — the Persona webhook's DURABLE apply. ONE transaction:
     * lock the tenant row (SELECT 1 … FOR UPDATE), re-read it through the
     * tx-bound store, RECOMPUTE applyKycEvent on that locked row (so a stale
     * pre-lock read racing a concurrent event can never undo a hold), save,
     * and — for a `*.matched` event — enqueue the kycmatch ops alert
     * (dedupe `kycmatch:<eventId>`). A throw anywhere rolls the save back.
     * The Redis audit line follows the commit, best-effort (a Redis failure
     * never fails the committed apply). Returns null when the row is gone.
     */
    async applyPersonaEvent(
      partnerId: PartnerId,
      phone: string,
      event: PersonaEvent,
      opts: PersonaApplyOpts,
    ): Promise<PersonaApplyResult | null> {
      const nowIso = new Date(now()).toISOString();
      const result = await opts.db.transaction(async (tx) => {
        const txCustomers = createCustomerStore(tx, opts.store);
        if (!(await txCustomers.lockCustomer(partnerId, phone))) return null;
        const before = await txCustomers.getCustomer(partnerId, phone);
        if (!before) return null;
        const delta = applyKycEvent(before, event, nowIso);
        const changed = Object.keys(delta).length > 0;
        const after: Customer = changed ? { ...before, ...delta, updatedAt: nowIso } : before;
        if (changed) await txCustomers.saveCustomer(after);
        // Fix pack 2 T6 (R06): a watchlist / PEP match stamps the sender
        // screening hold in THIS transaction (an approved customer too: a
        // later match records its flag). The single-column writer, so the
        // stamp survives any stale whole-row save; it re-arms a cleared hold.
        // Pack 2 review R3 (H1 b): the stamp time is read AFTER lockCustomer
        // (nowIso was read before it), and the writer keeps it later than any
        // clear on the locked row, so a clear that won the lock first never
        // outranks this match.
        if (delta.pepHit === true || delta.watchlistHit === true) {
          // Fix pack 7 (R2): a watchlist match also records screening_watchlist_at.
          await txCustomers.stampScreeningFlagged(partnerId, phone, new Date(now()), delta.watchlistHit === true ? 'watchlist' : 'pep');
        }
        if (event.matchKind !== undefined && opts.alertMessage) {
          const message =
            after.kycReviewState === 'approved'
              ? opts.alertMessage('approved')
              : after.kycReviewState === 'rejected'
                ? opts.alertMessage('rejected')
                : opts.alertMessage('held');
          await createOutboxRepo(tx).enqueue('ops.alert', { message }, {
            dedupeKey: `kycmatch:${event.eventId}`,
          });
        }
        return { before, after, changed };
      });
      // partner-demo R4: the kycmatch alert committed with the apply — poke
      // (after() runs post-response, i.e. after this commit).
      if (result && event.matchKind !== undefined && opts.alertMessage) pokeWorker();
      if (result?.changed) {
        try {
          await appendAudit(partnerId, phone, { actor: 'persona', action: event.name, at: nowIso });
        } catch (err) {
          logWarn('kyc.persona.redis_audit', err, { partnerId });
        }
      }
      return result;
    },

    /**
     * The human KYC decision. With `durable`: ONE locked transaction (lock, re-read, the
     * screening re-check, an optional partner PEP clear (pack 7, P22: `pepClear` on approve), the
     * save, the audit row with the optional `extraMeta` keys). Without it: the legacy Redis path,
     * which ignores every pack 7 option.
     */
    async review(
      partnerId: PartnerId,
      phone: string,
      decision: 'approve' | 'reject',
      reviewer: string,
      reason: string,
      durable?: DurableReviewOpts,
    ): Promise<Customer | null> {
      const nowIso = new Date(now()).toISOString();
      const decide = (c: Customer): Customer =>
        decision === 'approve'
          ? {
              ...c,
              kycStatus: 'verified',
              kycReviewState: 'approved',
              kycVerifiedAt: nowIso,
              kycApprovedBy: reviewer,
              kycApprovedAt: nowIso,
              kycRejectedReason: undefined,
              updatedAt: nowIso,
            }
          : {
              ...c,
              kycStatus: 'rejected',
              kycReviewState: 'rejected',
              kycRejectedReason: reason,
              kycRejectedAt: nowIso,
              updatedAt: nowIso,
            };
      const redisEntry: AuditEntry = { actor: reviewer, action: `review.${decision}`, reason, at: nowIso };

      if (!durable) {
        // Legacy path (no db handle): unchanged semantics — Redis trail only.
        const c = await customers.getCustomer(partnerId, phone);
        if (!c) return null;
        const updated = decide(c);
        await customers.saveCustomer(updated);
        await appendAudit(partnerId, phone, redisEntry);
        return updated;
      }

      // Program-Fix 28: ONE transaction — lock the tenant row (SELECT 1 … FOR
      // UPDATE), re-read it through the tx-bound store (decrypted PII, never a
      // masked value), write it back, then the audit_events row. A failed audit
      // insert rolls the decision back. Only tx-bound handles inside.
      const updated = await durable.db.transaction(async (tx) => {
        const txCustomers = createCustomerStore(tx, durable.store);
        if (!(await txCustomers.lockCustomer(partnerId, phone))) return null;
        const c = await txCustomers.getCustomer(partnerId, phone);
        if (!c) return null;
        if (durable.pepClear) {
          // Fix pack 7 (P22): the locked row must still be the PEP-only flag the partner reviewed.
          const want = normaliseFlaggedAt(durable.pepClear.reviewedFlaggedAt);
          const flags = await readSenderScreeningFlags(tx, partnerId, phone, { forUpdate: true });
          const locked = flags?.screeningFlaggedAt ? flags.screeningFlaggedAt.toISOString() : '';
          if (!flags || !senderPepOnly(flags) || want === null || want !== locked) throw new KycScreeningChangedError();
        }
        if (
          durable.allowScreeningHold !== true &&
          isScreeningCustomerHold(c, durable.pepClearable === true ? { pepClearable: true } : undefined)
        ) {
          throw new Error('You do not have permission to perform this action.');
        }
        const next = decide(c);
        if (durable.pepClear && decision === 'approve') {
          // Re-locks the same row (one transaction, no deadlock); its own checks are the authority.
          // screening_* columns are read-only in the row mapping, so the save below keeps the clear.
          await clearPepInTx(tx, {
            partnerId,
            phone,
            reviewedFlaggedAt: durable.pepClear.reviewedFlaggedAt,
            actor: durable.actor,
            via: 'kyc_decision',
          });
        }
        await txCustomers.saveCustomer(next);
        await createAuditRepo(tx).record({
          partnerId,
          actor: durable.actor,
          actorType: 'staff',
          action: durable.slug,
          subjectId: auditSubjectId(partnerId, phone), // keyed subject, never the raw phone
          meta: {
            previousStatus: c.kycStatus,
            newStatus: next.kycStatus,
            reason,
            source: durable.source,
            reviewerName: reviewer,
            ...(durable.actorScope ? { actorScope: durable.actorScope } : {}),
            ...(durable.extraMeta ? sanitizeKycExtraMeta(durable.extraMeta) : {}),
          },
        });
        return next;
      });
      if (!updated) return null;
      // Post-commit, best-effort (r2): the transitional Redis copy. A Redis
      // failure here never surfaces as an error (the decision + its durable row
      // are committed; a retry would only duplicate them).
      try {
        await appendAudit(partnerId, phone, { ...redisEntry, durable: true });
      } catch (err) {
        logWarn('kyc.review.redis_audit', err, { partnerId });
      }
      return updated;
    },

    async getAudit(partnerId: PartnerId, phone: string): Promise<AuditEntry[]> {
      // Tenant-scoped since fix 1. TRANSITIONAL (D10): an empty scoped trail
      // falls back to the pre-fix phone-only key ONLY for the phone's pre-fix
      // (oldest-row) tenant — legacyKeyAllowed, the same D9 helper — so a
      // post-fix sibling tenant's staff never read another tenant's KYC events.
      let raw = await redis.hgetall(auditKey(partnerId, phone));
      const empty = !raw || (Array.isArray(raw) ? raw.length === 0 : Object.keys(raw).length === 0);
      if (empty && (await legacyKeyAllowed(partnerId, phone, legacyTenantResolver(customers)))) {
        raw = await redis.hgetall(legacyAuditKey(phone));
      }
      if (!raw) return [];
      // The real Upstash client is built with `automaticDeserialization:false`,
      // so HGETALL returns a FLAT [field0, value0, field1, value1, ...] array —
      // NOT a {field: value} object (the in-memory fake returns the object shape).
      // Normalize both to [field, value] pairs before parsing. Field names are
      // `<iso>#<seq>` strings and are NOT JSON, so we must only parse the values.
      const pairs: [string, string][] = Array.isArray(raw)
        ? Array.from({ length: Math.floor(raw.length / 2) }, (_, i) => [
            String(raw[i * 2]),
            String(raw[i * 2 + 1]),
          ])
        : Object.entries(raw as Record<string, string>);
      return pairs
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([, v]) => {
          // A corrupt/partial entry from a crashed mid-write must not 500 the
          // page — the audit trail is non-critical UI. Skip unparseable values.
          try {
            return JSON.parse(v) as AuditEntry;
          } catch {
            return null;
          }
        })
        .filter((e): e is AuditEntry => e !== null);
    },

    async listNeedsReview(partnerId?: PartnerId): Promise<Customer[]> {
      // Stage 2a: customers live in Postgres now — the Redis phones-set walk is
      // gone. (Stage 4 narrows this to a WHERE kyc_review_state IN (...) query.)
      const all = await customers.listCustomers(partnerId);
      return all.filter(
        (c) => c.kycReviewState === 'pending_review' || c.kycReviewState === 'needs_review',
      );
    },
  };
}

export type KycCaseStore = ReturnType<typeof createKycCaseStore>;

let cached: KycCaseStore | null = null;

/** Singleton accessor backed by the real Upstash client (mirrors getCustomerStore). */
export function getKycCaseStore(store: Store): KycCaseStore {
  if (!cached) {
    cached = createKycCaseStore(getRedis(), getCustomerStore(store));
  }
  return cached;
}
