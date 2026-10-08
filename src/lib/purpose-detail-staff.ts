import type { DbOrTx } from '@/db/client';
import { createAuditRepo, type AuditEvent } from '@/db/repos/aux-repos';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { auditSubjectId } from './customer-ref';
import { purposeDetailRisk, PURPOSE_RISK_LABELS } from './purpose-detail';
import type { PartnerId, Transfer } from './types';

/**
 * purpose-detail-staff — Batch B follow-up A4: the customer's "Other" reason on staff pages (the
 * admin transaction page, the compliance review queue, the partner transfer page). Server only.
 *
 * The reason is the customer's own words, sealed at rest (transfers.purpose_detail_enc), so every
 * staff read is a decrypted read and writes ONE `pii.view` row per transfer shown, all in one insert
 * (actor = staff, subject = the keyed customer subject, meta = { fields: ['purpose_detail'],
 * transferId } and, for the partner app, actorScope 'partner'). The audit write is awaited and not
 * caught: if it fails the page fails rather than show the words without a record (the dash-05 rule,
 * customer-ref.ts).
 *
 * `riskLabel` is the staff name of the scam pattern the reason matched (purpose-detail.ts), or null.
 * It is for SmartRemit and compliance staff only: callers decide whether to render it, and it never
 * reaches the customer, the bot or the Partner API.
 */

export interface StaffPurposeDetail {
  detail: string;
  riskLabel: string | null;
}

export async function readPurposeDetailsForStaff(
  db: DbOrTx,
  staff: { username: string },
  /** Transfers the caller ALREADY scope-checked (scoped store / tenant-owned read). */
  shown: readonly Transfer[],
  opts: {
    /** The staff member's tenant (the read is pinned to it), or null for platform staff. */
    tenant: PartnerId | null;
    actorScope?: 'partner' | 'platform';
  },
): Promise<Map<string, StaffPurposeDetail>> {
  const out = new Map<string, StaffPurposeDetail>();
  if (shown.length === 0) return out;
  const byId = new Map(shown.map((t) => [t.id, t]));
  const details = await createTransferRepo(db).listPurposeDetails(opts.tenant, [...byId.keys()]);
  const views: AuditEvent[] = [];
  for (const [id, detail] of details) {
    const t = byId.get(id);
    if (!t) continue;
    views.push({
      partnerId: t.partnerId,
      actor: staff.username,
      actorType: 'staff',
      action: 'pii.view',
      subjectId: auditSubjectId(t.partnerId, t.phone),
      meta: { fields: ['purpose_detail'], transferId: t.id, ...(opts.actorScope ? { actorScope: opts.actorScope } : {}) },
    });
    const risk = purposeDetailRisk(detail);
    out.set(id, { detail, riskLabel: risk ? PURPOSE_RISK_LABELS[risk] : null });
  }
  // ONE insert for every row shown (security review L5), awaited and not caught: no record, no words.
  await createAuditRepo(db).recordMany(views);
  return out;
}
