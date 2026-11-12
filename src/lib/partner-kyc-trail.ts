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

/**
 * Fix pack 7 T28 (P25 partner trail, P22): the slugs read ONLY for a qualified compliance user of a
 * partner that decides KYC (partnerDecidesKyc): SmartRemit's recommendation (kyc.recommend) and
 * the team's own PEP clear (customer.screening_hold.clear marked actorScope 'partner'). Both row
 * kinds are also opt-in in partnerKycTrail (opts), so every other viewer reads KYC_TRAIL_ACTIONS
 * and sees today's rows (D8: a recommendation or a PEP clear must not tip anyone else off).
 */
export const KYC_TRAIL_READ_ACTIONS = Object.freeze([...KYC_TRAIL_ACTIONS, 'kyc.recommend', 'customer.screening_hold.clear'] as const);

export interface KycTrailOptions {
  /** kyc.recommend rows: "SmartRemit recommends approval / rejection" with SmartRemit's reason. */
  recommendations?: boolean;
  /** customer.screening_hold.clear rows marked actorScope 'partner': "PEP flag cleared" with the actor. */
  pepClears?: boolean;
}

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
  opts?: KycTrailOptions,
): KycTrailEntry[] {
  const out: Array<KycTrailEntry & { sort: number; id: number }> = [];
  for (const row of rows) {
    if (row.action === 'kyc.recommend') {
      const meta = metaOf(row);
      const rec = meta.recommendation;
      const reason = typeof meta.reason === 'string' ? meta.reason.trim() : '';
      if (opts?.recommendations !== true || row.actorType !== 'staff' || (rec !== 'approve' && rec !== 'reject') || reason === '') continue;
      out.push({
        at: row.at.toISOString(),
        actor: t('partner.audit.smartremit'), // never the SmartRemit username
        labelKey: rec === 'approve' ? 'partner.customers.trail.recommendApprove' : 'partner.customers.trail.recommendReject',
        reason: safeText(reason),
        sort: row.at.getTime(),
        id: row.id,
      });
      continue;
    }
    if (row.action === 'customer.screening_hold.clear') {
      const meta = metaOf(row);
      if (opts?.pepClears !== true || row.actorType !== 'staff' || meta.actorScope !== 'partner' || meta.watchlistHit === true) continue;
      out.push({
        at: row.at.toISOString(),
        actor: safeText(row.actor),
        labelKey: 'partner.customers.trail.pepCleared',
        reason: null,
        sort: row.at.getTime(),
        id: row.id,
      });
      continue;
    }
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
