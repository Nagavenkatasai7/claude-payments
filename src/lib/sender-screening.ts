import type { DbOrTx } from '@/db/client';
import { createCustomerRepo, readSenderScreeningFlags, type SenderScreeningFlags } from '@/db/repos/customer-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { auditSubjectId } from './customer-ref';
import { senderPepOnly } from './hold-queue';
import { logWarn } from './log';
import type { PartnerId } from './types';

export type { SenderScreeningFlags };

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

/**
 * M3-10 follow-up (owner, 2026-09-29): the transfer SENDER's customer-level PEP / watchlist flags,
 * read inside the partner tenant for the partner hold release (isPartnerReleasableHold's third
 * argument). FAILS CLOSED: a blank key, a missing row or a failed lookup all return null, which the
 * predicate refuses. Never throws (the page renders without the button; the action refuses). Logs
 * the error NAME only: a failed query's message carries its bound params (the phone).
 */
export async function loadSenderScreening(db: DbOrTx, partnerId: PartnerId, phone: string): Promise<SenderScreeningFlags | null> {
  if (!partnerId || !phone) return null;
  try {
    return await readSenderScreeningFlags(db, partnerId, phone);
  } catch (err) {
    logWarn('partner.release.sender-screening', errName(err), { partnerId });
    return null;
  }
}

/**
 * Fix pack 7 (P22, P23): the locked customer row is not the one the partner's
 * PEP decision reviewed (a watchlist hit or stamp, a newer match, no row, an
 * unreadable reviewed time). Thrown INSIDE the caller's transaction, so the
 * rollback undoes everything it wrote. Carries no value.
 */
export class KycScreeningChangedError extends Error {
  constructor() {
    super('kyc_screening_changed');
    this.name = 'KycScreeningChangedError';
  }
}

/** The posted reviewed flag time as ISO ('' for none); null when unreadable (admin customers/actions.ts reviewedFlaggedAt). */
function normaliseReviewed(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (v === '') return '';
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export interface ClearPepInput {
  partnerId: PartnerId;
  phone: string;
  /** The screening flag time the decider's page showed ('' when none). */
  reviewedFlaggedAt: string;
  actor: string;
  via: 'kyc_decision' | 'hold_review';
  /** The hold path: the transfer the decision is about (the review id is not known yet). */
  transferId?: string;
  reviewId?: string;
}

/**
 * Fix pack 7 (P23, shared by the hold seam P9 and the KYC store P22): a
 * partner's PEP decision lifts the sender's screening hold, in the CALLER's
 * transaction (`tx`). It locks the owner tenant's customer row
 * (readSenderScreeningFlags FOR UPDATE; the hold seam locks the transfer
 * first), refuses with KycScreeningChangedError unless the LOCKED flags are
 * PEP-only (senderPepOnly, R2: no watchlist hit, no watchlist stamp newer than
 * the last clear) and the locked flag time is the reviewed one, then sets
 * screening_cleared_at (clearScreeningHold) and writes ONE
 * customer.screening_hold.clear audit row (subject auditSubjectId; meta ids,
 * times, booleans and closed enums only: no reason key, the reason is in the
 * decision row). It releases nothing and logs nothing.
 */
export async function clearPepInTx(tx: DbOrTx, i: ClearPepInput): Promise<void> {
  const flags = await readSenderScreeningFlags(tx, i.partnerId, i.phone, { forUpdate: true });
  const reviewed = normaliseReviewed(i.reviewedFlaggedAt);
  if (!flags || !senderPepOnly(flags) || reviewed === null) throw new KycScreeningChangedError();
  const locked = flags.screeningFlaggedAt ? flags.screeningFlaggedAt.toISOString() : '';
  if (locked !== reviewed) throw new KycScreeningChangedError();
  const repo = createCustomerRepo(tx, async () => null);
  const { found, previous } = await repo.clearScreeningHold(i.partnerId, i.phone);
  if (!found || !previous) throw new KycScreeningChangedError();
  const customer = await repo.getCustomer(i.partnerId, i.phone);
  if (!customer) throw new KycScreeningChangedError();
  await createAuditRepo(tx).record({
    partnerId: i.partnerId,
    actor: i.actor,
    actorType: 'staff',
    action: 'customer.screening_hold.clear',
    subjectId: auditSubjectId(i.partnerId, i.phone),
    meta: {
      flaggedAt: previous.screeningFlaggedAt ? previous.screeningFlaggedAt.toISOString() : null,
      previousClearedAt: previous.screeningClearedAt ? previous.screeningClearedAt.toISOString() : null,
      pepHit: true,
      watchlistHit: false,
      kycStatus: customer.kycStatus,
      actorScope: 'partner',
      via: i.via,
      ...(i.transferId ? { transferId: i.transferId } : {}),
      ...(i.reviewId ? { reviewId: i.reviewId } : {}),
    },
  });
}
