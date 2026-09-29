'use server';

import { revalidatePath } from 'next/cache';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { PARTNER_OPS } from '@/lib/partner-access';
import { getDb } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { getRedis } from '@/lib/redis';
import { boundStaffNote } from '@/lib/send-limits';
import { holdNoteClaimKey, isHeld, isPartnerNoteShaped, isRequestKey, isTransferId } from '@/lib/partner-transfers';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import type { ActionResult } from '../../../action-result';

const CLAIM_TTL_S = 1800;
const CLAIM_PENDING = 'p';
const CLAIM_DONE = 'd';
const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

/**
 * Add a note to one of THIS tenant's held transfers (UI redesign M3-5). AUDIT-ONLY: one
 * `transfer.hold.note` row; no transfer column changes, no money movement. The shared /partner
 * action shape: the gate first (outside any try); the target id from the form (any partnerId field
 * is never read); resolved INSIDE the session tenant (missing and foreign are the same result);
 * the input validated before any write; the write + its audit row in one transaction. A replayed
 * submit (same request key, same user and transfer) writes once, and is reported as saved only
 * after the first write committed. Redis unavailable ⇒ the note is refused (fails closed).
 */
export async function addHoldNoteAction(formData: FormData): Promise<ActionResult> {
  // A partner-site host never runs an apex action (the site-host guard rule for every action).
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_OPS);
  const notFound: ActionResult = { ok: false, error: t('partner.common.notFound') };

  const id = String(formData.get('id') ?? '').trim();
  if (!isTransferId(id)) return notFound;
  const db = getDb();
  const transfer = await createTransferRepo(db).getOwnedTransfer(ctx.partnerId, id);
  if (!transfer || transfer.partnerId !== ctx.partnerId) return notFound;

  if (!isHeld(transfer)) return { ok: false, error: t('partner.transfers.noteNotHeld') };
  const note = boundStaffNote(formData.get('note'));
  if (!note) return { ok: false, error: t('partner.transfers.noteEmpty') };
  if (!isPartnerNoteShaped(note)) return { ok: false, error: t('partner.transfers.noteHasNumber') };
  const requestKey = String(formData.get('requestKey') ?? '');
  if (!isRequestKey(requestKey)) return { ok: false, error: t('partner.transfers.noteExpired') };

  const redis = getRedis();
  const claim = holdNoteClaimKey(ctx.partnerId, ctx.username, transfer.id, requestKey);
  let claimed = false;
  try {
    claimed = (await redis.set(claim, CLAIM_PENDING, { nx: true, ex: CLAIM_TTL_S })) !== null;
    if (!claimed) {
      // A replay. "Saved" only once the first submit's write committed; while it is still in
      // flight (or it failed and a stale claim remains) the user is told to reload and check.
      return (await redis.get(claim)) === CLAIM_DONE ? { ok: true } : { ok: false, error: t('partner.transfers.noteInFlight') };
    }
    await db.transaction(async (tx) => {
      await createAuditRepo(tx).record({
        partnerId: ctx.partnerId,
        actor: ctx.username,
        actorType: 'staff',
        action: 'transfer.hold.note',
        subjectId: transfer.id,
        meta: { note, actorScope: 'partner' },
      });
    });
  } catch (err) {
    if (claimed) {
      try {
        await redis.del(claim);
      } catch (delErr) {
        logWarn('partner.hold_note.release', errName(delErr), { transferId: transfer.id });
      }
    }
    // The error NAME only: a failed query's message carries its bound params (the note text).
    logWarn('partner.hold_note', errName(err), { transferId: transfer.id });
    return { ok: false, error: t('partner.common.failed') };
  }
  try {
    await redis.set(claim, CLAIM_DONE, { ex: CLAIM_TTL_S });
  } catch (err) {
    // The note is written. A replay then reads "still working" until the TTL, never a second note.
    logWarn('partner.hold_note.done', errName(err), { transferId: transfer.id });
  }
  revalidatePath(`/partner/transfers/${transfer.id}`);
  return { ok: true };
}
