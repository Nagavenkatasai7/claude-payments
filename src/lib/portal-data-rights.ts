import type { MessageKey } from './i18n';
import type { PartnerId } from './types';

/**
 * portal-data-rights — the customer portal's data-request constants (UI redesign M2-13, Task 13.2).
 *
 * SPEC §6b / X9: the portal only FILES a request (an audit row plus a deduped ops alert). The export
 * job, the erasure engine and retention belong to compliance loop A: there is no job, no table and
 * no erasure code here. The whole surface sits behind CUSTOMER_DATA_RIGHTS_ENABLED (off).
 */

export const DATA_REQUEST_KINDS = ['export', 'delete'] as const;
export type DataRequestKind = (typeof DATA_REQUEST_KINDS)[number];

export function isDataRequestKind(v: unknown): v is DataRequestKind {
  return typeof v === 'string' && (DATA_REQUEST_KINDS as readonly string[]).includes(v);
}

/** Per customer (host partner + phone): 3 data requests per UTC day, across both kinds. */
export const PORTAL_PRIVACY_LIMIT = { scope: 'portal-privacy', limit: 3, windowSec: 86_400 } as const;

/** The ops alert text: the partner id and the keyed audit subject, never the phone. */
export function dataRequestAlertMessage(kind: DataRequestKind, partnerId: PartnerId, subjectId: string): string {
  return `SmartRemit ops: customer data request (${kind}) for partner ${partnerId}, subject ${subjectId}`;
}

/** One alert per (subject, kind, UTC day): repeat requests still audit, but do not re-page ops. */
export function dataRequestDedupeKey(subjectId: string, kind: DataRequestKind, nowMs: number): string {
  return `dr:${subjectId}:${kind}:${new Date(nowMs).toISOString().slice(0, 10)}`;
}

/** The outcome codes the action redirects with (`/portal/privacy?status=<code>`). A closed set. */
export const DATA_REQUEST_STATUS: Readonly<Record<string, MessageKey>> = {
  requested: 'portal.privacy.status.requested',
  reason: 'portal.privacy.status.reason',
  rate_limited: 'portal.privacy.status.rate_limited',
  expired: 'portal.privacy.status.expired',
  in_flight: 'portal.privacy.status.in_flight',
  failed: 'portal.privacy.status.failed',
};

/** The copy for a `status` query value, or null for anything outside the closed set. */
export function dataRequestStatusCopy(status: unknown): { key: MessageKey; ok: boolean } | null {
  if (typeof status !== 'string' || !Object.hasOwn(DATA_REQUEST_STATUS, status)) return null;
  return { key: DATA_REQUEST_STATUS[status], ok: status === 'requested' };
}
