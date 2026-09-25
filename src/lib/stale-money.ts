import type { Db } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';

// stale-money — Program-Fix 32. Two sweeps over money that has stopped moving:
//
//   • escalateStuckPaid (neon-10): reconcileSweep alerts ONCE per stuck-paid
//     transfer (`recon:<id>`, >15 min) and then goes quiet — two prod
//     transfers sat 'paid' ~12 days on one alert. This re-alerts on a ladder:
//     1 h, 6 h, 24 h, then daily, ONE deduped ops alert per rung
//     (`recon:<id>:<rung>`) and one audit row per fresh rung. reconcileSweep is
//     not touched. Runs from every FULL /api/worker run (≤ 30 min apart when idle, R4).
//   • expireUnpaidLinks (neon-09): an UNFUNDED awaiting_payment link older than
//     UNPAID_LINK_EXPIRY_DAYS is cancelled through fix 9's guarded
//     cancelIfCancellable (status + funding predicates IN the UPDATE), with a
//     `transfer.expired` audit row in the same transaction. A charged row
//     (funding_ref set) is never expired — the funding-resume sweep owns it.
//     No customer WhatsApp: a 7-day-old link is outside the 24 h service
//     window, so free-form text would fail and dead-letter. Runs from /api/cron
//     (daily).
//
// Every write is tenant-scoped; alerts and audit meta carry ids only.
//
// Drizzle 0.45.2: db.transaction(fn) — node_modules/drizzle-orm/pg-core/db.d.ts:281.

/** Owner decision (Phase 2 header, fix 32): unpaid pay links expire after 7 days. */
export const UNPAID_LINK_EXPIRY_DAYS = 7;

/** The first escalation rung: a transfer 'paid' this long with no delivery. */
export const STUCK_ESCALATION_MINUTES = 60;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The highest escalation rung a stuck-paid age has crossed: null under 1 h,
 * then '1h', '6h', '24h', and 'd<N>' (N = whole days) from 48 h on. The rung is
 * the dedupe suffix, so each one alerts exactly once.
 */
export function stuckRung(ageMs: number): string | null {
  if (ageMs < STUCK_ESCALATION_MINUTES * 60_000) return null;
  if (ageMs < 6 * HOUR_MS) return '1h';
  if (ageMs < DAY_MS) return '6h';
  if (ageMs < 2 * DAY_MS) return '24h';
  return `d${Math.floor(ageMs / DAY_MS)}`;
}

/** The ops page's red badge: this paid transfer has crossed the first escalation rung. */
export function isEscalated(paidAt: string | undefined | null, now: number): boolean {
  if (!paidAt) return false;
  return stuckRung(now - Date.parse(paidAt)) !== null;
}

function rungLabel(rung: string): string {
  if (rung.startsWith('d')) return `${rung.slice(1)} days`;
  return rung === '24h' ? '24 hours' : rung === '6h' ? '6 hours' : '1 hour';
}

/**
 * Escalate every transfer stuck in 'paid' past the first rung. Returns the
 * number of FRESH rung alerts (a re-run inside the same rung adds none). The
 * alert and its audit row commit together; a rung whose alert already exists
 * writes nothing.
 */
export async function escalateStuckPaid(db: Db, now: Date = new Date()): Promise<number> {
  const stuck = await createTransferRepo(db).findStuckPaid(STUCK_ESCALATION_MINUTES);
  let escalated = 0;
  for (const t of stuck) {
    if (!t.paidAt) continue;
    const rung = stuckRung(now.getTime() - Date.parse(t.paidAt));
    if (!rung) continue;
    const fresh = await db.transaction(async (tx) => {
      const enqueued = await createOutboxRepo(tx).enqueue(
        'ops.alert',
        {
          // Ids only (never a phone, name or destination). Routed transfers
          // name the SETTLEMENT partner too — whose rail owes the callback
          // (the same wording rule as reconcile.ts's recon alert).
          message:
            `🚨 SmartRemit ops: transfer ${t.id} (partner ${t.partnerId}` +
            (t.settlementPartnerId ? `, settles via ${t.settlementPartnerId}` : '') +
            `) has been 'paid' for over ${rungLabel(rung)} with no delivery confirmation ` +
            `(escalation ${rung}; next at 6 h / 24 h / daily). Chase the rail partner.`,
        },
        { dedupeKey: `recon:${t.id}:${rung}` },
      );
      if (enqueued) {
        await createAuditRepo(tx).record({
          partnerId: t.partnerId,
          actor: 'system',
          actorType: 'system',
          action: 'transfer.stuck_escalated',
          subjectId: t.id,
          meta: { rung },
        });
      }
      return enqueued;
    });
    if (fresh) escalated++;
  }
  return escalated;
}

/**
 * Cancel unfunded awaiting_payment links older than `days`. Returns how many
 * were expired. Each row is one transaction: the guarded cancel (null ⇒ a
 * concurrent pay / hold / capture won — skip, no audit row) and the audit row.
 */
export async function expireUnpaidLinks(
  db: Db,
  now: Date = new Date(),
  days: number = UNPAID_LINK_EXPIRY_DAYS,
): Promise<number> {
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  const stale = await createTransferRepo(db).listStaleUnfunded(cutoff);
  let expired = 0;
  for (const t of stale) {
    const done = await db.transaction(async (tx) => {
      const cancelled = await createTransferRepo(tx).cancelIfCancellable(t.id, t.partnerId);
      if (!cancelled) return false;
      await createAuditRepo(tx).record({
        partnerId: t.partnerId,
        actor: 'system',
        actorType: 'system',
        action: 'transfer.expired',
        subjectId: t.id,
        meta: { ageDays: Math.floor((now.getTime() - Date.parse(t.createdAt)) / DAY_MS) },
      });
      return true;
    });
    if (done) expired++;
  }
  return expired;
}
