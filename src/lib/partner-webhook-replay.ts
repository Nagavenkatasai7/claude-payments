import { sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { checkIpRateLimit } from '@/lib/ip-rate-limit';
import { logWarn } from '@/lib/log';
import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import type { EndpointActor } from '@/lib/partner-settlement-endpoint';
import { getRedis } from '@/lib/redis';
import type { RedisLike } from '@/lib/store';

// partner-webhook-replay (UI redesign M3-15b): the partner's Replay of a DEAD settlement instruction
// on /partner/integrations/webhooks. It never sends anything itself: it re-queues the dead outbox
// row through the ordinary retry path (createOutboxRepo.retryDeadForPartner: the tenant-scoped
// predicate + the status='dead' guard), and the worker then runs the normal instruct handler, whose
// ledger guard refuses a transfer that is no longer payable (outbox-worker.ts settlement.instruct:
// cancelled / delivered / refund pending|completed ⇒ done without a POST). Only a row that could still
// be needed is replayable: the transfer is still paid with no rail ack, and no sibling instruct row
// is live (outbox-repo.ts deadInstructionOnRail). Such a transfer IS re-instructed once; settlement
// endpoints must be idempotent on the transfer id.
//
// NOT a 'use server' module: it takes a partnerId and trusts it. The action gates first and passes
// the SESSION tenant. Order: rail type (only a partner-operated 'http' rail is self-service, as in
// 15a) → the per-tenant rate limit (fail closed) → ONE transaction: the scoped retry + its audit row.
// Another tenant's row, a missing id, a non-instruct row and an already-replayed row are all the
// same `not_found` (no oracle, no write).

/** Replay budget per tenant (checkIpRateLimit keyed by partner id; ip-rate-limit.ts:55). */
export const REPLAY_LIMIT = Object.freeze({ scope: 'partner-webhook-replay', limit: 10, windowSec: 600 });

export type ReplayResult = { ok: true } | { ok: false; reason: 'not_found' | 'rate_limited' | 'not_partner_rail' };

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

async function withinReplayLimit(redis: RedisLike, partnerId: string, nowMs: number): Promise<boolean> {
  try {
    return (await checkIpRateLimit(redis, REPLAY_LIMIT.scope, partnerId, { limit: REPLAY_LIMIT.limit, windowSec: REPLAY_LIMIT.windowSec, now: nowMs })).allowed;
  } catch (err) {
    logWarn('partner.webhooks.replay-limit', errName(err), { partnerId });
    return false; // fail closed: a replay re-sends money instructions
  }
}

export async function replayDeadInstruction(
  db: Db,
  partnerId: string,
  actor: EndpointActor,
  outboxId: number,
  deps: { redis?: RedisLike; now?: () => Date } = {},
): Promise<ReplayResult> {
  const cfg = await createPartnerIntegrationsStore(db).getIntegrations(partnerId);
  if (cfg.payment.providerType !== 'http') return { ok: false, reason: 'not_partner_rail' };
  const now = (deps.now ?? (() => new Date()))();
  if (!(await withinReplayLimit(deps.redis ?? getRedis(), partnerId, now.getTime()))) return { ok: false, reason: 'rate_limited' };

  const replayed = await db.transaction(async (tx) => {
    // Lock order transfer → outbox (the order every writer uses): two replays of sibling rows for one
    // transfer, or a replay racing a sender cancel, serialise here; the retry's predicate (paid, no
    // rail ack, no live sibling) is then evaluated after the other side committed.
    await tx.execute(sql`SELECT t.id FROM transfers t
      WHERE t.id = (SELECT o.payload ->> 'transferId' FROM outbox o WHERE o.id = ${outboxId} AND o.kind = 'settlement.instruct')
      FOR UPDATE`);
    if (!(await createOutboxRepo(tx).retryDeadForPartner(outboxId, partnerId))) return false;
    await createAuditRepo(tx).record({
      partnerId,
      actor: actor.username,
      actorType: 'staff',
      action: 'webhook.replay',
      subjectId: String(outboxId),
      meta: { outboxId, actorScope: actor.actorScope },
    });
    return true;
  });
  return replayed ? { ok: true } : { ok: false, reason: 'not_found' };
}
