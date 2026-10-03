import { safeText, type TenantAuditRow } from './partner-audit-view';
import { t, type MessageKey } from './i18n';

// partner-kyc-trail (lost-features p2 A9): the PURE "Decision history" on /partner/customers/[ref].
// Tipping-off rules:
//   - Only the durable audit_events rows of the five KYC decision slugs. The Redis case trail is
//     never read: it holds raw provider event names (screening reports among them).
//   - The tenant's OWN decisions show the actor and the reason. A row is the tenant's own when it is
//     marked meta.actorScope 'partner', or a current member of the tenant wrote it and it is not
//     marked 'platform' (decisions made before the marker existed). The same rule as the audit
//     page's own-only filter. An offboarded member's decisions drop out of "own" (safe direction).
//   - Every other row reads "SmartRemit" with the outcome only, never a reason: a platform reason
//     can describe a screening hit.
// The reason passes the audit page's phone/email mask.

export const KYC_TRAIL_ACTIONS = Object.freeze([
  'kyc.review.approve',
  'kyc.review.reject',
  'kyc.manual_override.approve',
  'kyc.manual_override.reject',
  'kyc.manual_override.create',
] as const);

export interface KycTrailEntry {
  at: string;
  /** null on the "Verification started" line (the customer started it). */
  actor: string | null;
  labelKey: MessageKey;
  reason: string | null;
}

const metaOf = (row: TenantAuditRow): Record<string, unknown> =>
  row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta) ? (row.meta as Record<string, unknown>) : {};

function labelFor(action: string, meta: Record<string, unknown>): MessageKey {
  if (action.endsWith('.approve')) return 'partner.customers.trail.approved';
  if (action.endsWith('.reject')) return 'partner.customers.trail.rejected';
  return meta.newStatus === 'verified' ? 'partner.customers.trail.createdVerified' : 'partner.customers.trail.created';
}

function isOwn(row: TenantAuditRow, meta: Record<string, unknown>, tenantUsernames: ReadonlySet<string>): boolean {
  if (row.actorType !== 'staff') return false;
  if (meta.actorScope === 'partner') return true;
  return tenantUsernames.has(row.actor) && meta.actorScope !== 'platform';
}

export function partnerKycTrail(
  rows: readonly TenantAuditRow[],
  tenantUsernames: ReadonlySet<string>,
  kycSubmittedAt: string | undefined,
): KycTrailEntry[] {
  const out: Array<KycTrailEntry & { sort: number; id: number }> = [];
  for (const row of rows) {
    if (!(KYC_TRAIL_ACTIONS as readonly string[]).includes(row.action)) continue;
    const meta = metaOf(row);
    const own = isOwn(row, meta, tenantUsernames);
    const reason = own && typeof meta.reason === 'string' && meta.reason.trim() !== '' ? safeText(meta.reason.trim()) : null;
    out.push({
      at: row.at.toISOString(),
      actor: own ? safeText(row.actor) : t('partner.audit.smartremit'),
      labelKey: labelFor(row.action, meta),
      reason,
      sort: row.at.getTime(),
      id: row.id,
    });
  }
  const started = kycSubmittedAt && Number.isFinite(Date.parse(kycSubmittedAt)) ? Date.parse(kycSubmittedAt) : null;
  if (started !== null) {
    out.push({ at: new Date(started).toISOString(), actor: null, labelKey: 'partner.customers.trail.started', reason: null, sort: started, id: -1 });
  }
  return out
    .sort((a, b) => a.sort - b.sort || a.id - b.id)
    .map(({ at, actor, labelKey, reason }) => ({ at, actor, labelKey, reason }));
}
