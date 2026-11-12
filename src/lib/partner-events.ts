// partner-events — Fix pack 7 (P16): compliance events to a live-certified partner's own
// rail endpoint. This is the PURE core: the closed event types, who gets events, the
// dedupe key, the target URL and the body builder. T21 adds the outbox kind
// 'partner.event', enqueuePartnerEvent and the worker case (which signs with the existing
// signRailHeaders: no new signer); T22/T23 add the enqueue points.
//
// The body never carries a reason, name, phone, amount, reference or hash: the builder
// takes T7's ScreeningView (no inputHash) and a ReviewRowLite pick (no reason), and builds
// every object field by field, never spreading an input, so an extra field on a caller's
// object can never reach the partner.
//
// Imports: types only, plus reviewRecordApplies (client-safe). No db, no crypto, no env.

import { reviewRecordApplies, type ScopeOwner } from './partner-decision-scope';
import type { HoldClass, HoldDisposition, ReviewRowLite } from './hold-queue';
import type { ScreeningView } from './partner-screening-view';
import type { PartnerIntegrations } from './partner-integrations';
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
