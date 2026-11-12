// partner-events — Fix pack 7 (P16): compliance events to a live-certified partner's own
// rail endpoint: the closed event types, who gets events, the dedupe key, the target URL,
// the body builder, the outbox enqueue (T21) and the delivery error the worker throws.
// The worker case 'partner.event' (src/lib/outbox-worker.ts) builds the body at drain and
// signs it with the existing signRailHeaders (no new signer); T22/T23 add the enqueue points.
//
// The body never carries a reason, name, phone, amount, reference or hash: the builder
// takes T7's ScreeningView (no inputHash) and a ReviewRowLite pick (no reason), and builds
// every object field by field, never spreading an input, so an extra field on a caller's
// object can never reach the partner.
//
// Imports: types, reviewRecordApplies (client-safe), the outbox repo (T21, for
// enqueuePartnerEvent) and the partner repo (T22, the owner read of
// enqueuePotentialMatchIfEligible). No node built-in, no env. Not imported by any client file.

import type { DbOrTx } from '@/db/client';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { reviewRecordApplies, type ScopeOwner } from './partner-decision-scope';
import type { HoldClass, HoldDisposition, ReviewRowLite } from './hold-queue';
import type { ScreeningView } from './partner-screening-view';
import type { PartnerIntegrations } from './partner-integrations';
import type { SanctionsDecision } from './sanctions/evidence';
import type { PartnerId, Transfer } from './types';

export const PARTNER_EVENT_TYPES = Object.freeze(['screening.potential_match', 'hold.disposition'] as const);
export type PartnerEventType = (typeof PARTNER_EVENT_TYPES)[number];

/** A closed event type; string only (never an Object.prototype key such as '__proto__'). */
export function isPartnerEventType(v: unknown): v is PartnerEventType {
  return typeof v === 'string' && (PARTNER_EVENT_TYPES as readonly string[]).includes(v);
}

/** Events go to a live-certified owner, for non-sandbox rows only. */
export function partnerEventsApply(owner: ScopeOwner | null | undefined, t: Pick<Transfer, 'environment'>): boolean {
  return !!owner && reviewRecordApplies(owner) && t.environment !== 'test';
}

/** `${type}:${subjectId}` (subject: transferId or reviewId). Never 'reply:'. */
export function partnerEventDedupeKey(type: PartnerEventType, subjectId: string): string {
  if (!isPartnerEventType(type)) throw new Error('unknown partner event');
  if (typeof subjectId !== 'string' || subjectId === '' || subjectId.includes(':')) {
    throw new Error('partner event subject must be a non-empty id without ":"');
  }
  return `${type}:${subjectId}`;
}

/**
 * The partner's own endpoint for events: an http rail's eventsUrl, else its settlementUrl,
 * else null (a blank string reads as absent). NEVER the hosted-rail fallback of
 * settlementTargetUrl (live-gate.ts): a non-http rail gets no events.
 */
export function partnerEventTarget(payment: PartnerIntegrations['payment']): string | null {
  if (payment?.providerType !== 'http') return null;
  const c = payment.credentials;
  return c?.eventsUrl || c?.settlementUrl || null;
}

export interface PotentialMatchData {
  transfer_id: string;
  client_reference: string | null;
  list_source: string;
  list_version: string;
  decision: 'possible_match';
  screened_at: string;
  parties: Array<{ role: 'sender' | 'recipient'; matched: boolean; score: number | null; matched_entry_id: string | null }>;
}

export interface HoldDispositionData {
  transfer_id: string;
  client_reference: string | null;
  hold_class: HoldClass;
  step: 1 | 2;
  final: boolean;
  disposition: HoldDisposition;
  actor_scope: 'partner' | 'platform';
  decided_at: string;
}

export interface PartnerEventBody {
  type: PartnerEventType;
  id: string;
  created: number;
  partner_id: PartnerId;
  data: PotentialMatchData | HoldDispositionData;
}

export type PartnerEventInput =
  | {
      type: 'screening.potential_match';
      eventId: string;
      created: number;
      ownerId: PartnerId;
      transferId: string;
      clientReference: string | null;
      screening: ScreeningView;
    }
  | {
      type: 'hold.disposition';
      eventId: string;
      created: number;
      ownerId: PartnerId;
      transferId: string;
      clientReference: string | null;
      review: Pick<ReviewRowLite, 'holdClass' | 'step' | 'final' | 'disposition' | 'actorScope' | 'createdAt'>;
    };

/** The signed body of one event. Pure, closed switch; builds every object field by field. */
export function buildPartnerEventBody(i: PartnerEventInput): PartnerEventBody {
  const head = (type: PartnerEventType) => ({
    type,
    id: i.eventId,
    created: i.created,
    partner_id: i.ownerId,
  });
  const clientReference = i.clientReference ?? null;
  switch (i.type) {
    case 'screening.potential_match': {
      const s = i.screening;
      if (s.decision !== 'possible_match') throw new Error('partner event needs a possible_match screen');
      const data: PotentialMatchData = {
        transfer_id: i.transferId,
        client_reference: clientReference,
        list_source: s.listSource,
        list_version: s.listVersion,
        decision: 'possible_match',
        screened_at: s.screenedAt,
        // Unscreened parties are left out: matched false / score null would read as a clean screen.
        parties: s.parties
          .filter((p) => p.screened === true)
          .map((p) => ({ role: p.role, matched: p.matched, score: p.score, matched_entry_id: p.matchedEntryId })),
      };
      return { ...head('screening.potential_match'), data };
    }
    case 'hold.disposition': {
      const r = i.review;
      const data: HoldDispositionData = {
        transfer_id: i.transferId,
        client_reference: clientReference,
        hold_class: r.holdClass,
        step: r.step,
        final: r.final,
        disposition: r.disposition,
        actor_scope: r.actorScope,
        decided_at: r.createdAt,
      };
      return { ...head('hold.disposition'), data };
    }
    default: {
      const never: never = i;
      void never;
      throw new Error('unknown partner event');
    }
  }
}

/**
 * T21 (P16): queue ONE compliance event, in the caller's transaction. The payload is
 * ids only (an inline literal): the worker builds the body from the ledger at drain.
 * `eventId` is the body id the partner dedupes on (stable across retries). Dedupe:
 * `screening.potential_match:<transferId>` (once per transfer, for ever) and
 * `hold.disposition:<reviewId>`. True when a new row was queued. The caller pokes
 * the worker (or runs inside it).
 */
export async function enqueuePartnerEvent(
  tx: DbOrTx,
  e: { type: 'screening.potential_match'; transferId: string } | { type: 'hold.disposition'; transferId: string; reviewId: string },
): Promise<boolean> {
  const dedupeKey = partnerEventDedupeKey(e.type, e.type === 'hold.disposition' ? e.reviewId : e.transferId);
  return createOutboxRepo(tx).enqueue(
    'partner.event',
    {
      type: e.type,
      transferId: e.transferId,
      eventId: globalThis.crypto.randomUUID(),
      ...(e.type === 'hold.disposition' ? { reviewId: e.reviewId } : {}),
    },
    { dedupeKey },
  );
}

/**
 * P21 sites 2-4 (T22): one potential-match event in the caller's transaction when the
 * owner and the row qualify. Reads the owner (tenant row, in `tx`) only for a possible
 * match on a live row; a failed read throws (the caller's transaction rolls back, nothing
 * moves). Never for list_unavailable, match or clear. Returns whether a row was queued
 * (false on a dedupe hit: the key is global and for ever). The caller pokes or runs in the worker.
 */
export async function enqueuePotentialMatchIfEligible(
  tx: DbOrTx,
  t: Pick<Transfer, 'id' | 'partnerId' | 'environment'>,
  decision: SanctionsDecision | null | undefined,
): Promise<boolean> {
  if (decision !== 'possible_match' || t.environment === 'test') return false;
  const owner = await createPartnerRepo(tx).getPartner(t.partnerId);
  if (!partnerEventsApply(owner, t)) return false;
  return enqueuePartnerEvent(tx, { type: 'screening.potential_match', transferId: t.id });
}

/**
 * T21 (P18): the partner's endpoint answered non-2xx (`answer` = the status) or could
 * not be reached ('network'). A charged retry under the partner.event policy. The
 * message (it becomes outbox.last_error) never carries a URL or a body.
 */
export class PartnerEventDeliveryError extends Error {
  constructor(
    readonly partnerId: PartnerId,
    readonly answer: number | 'network',
  ) {
    super(`partner_event_rejected:${answer}`);
    this.name = 'PartnerEventDeliveryError';
  }
}
