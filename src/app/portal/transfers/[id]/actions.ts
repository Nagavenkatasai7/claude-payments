'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db/client';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { requirePortalSite } from '@/lib/portal-site';
import { requireFreshPortalAuth, requirePortalCustomer, type PortalCustomerContext } from '@/lib/portal-auth';
import { getPortalTransfer, PORTAL_TRANSFER_ID_RE, portalOwner, receiptView, renderReceiptText } from '@/lib/portal-transfers';
import { runOnce, BadRequestKeyError, RequestInFlightError, type ReplayValue } from '@/lib/portal-request-key';
import { verifiedReceiptEmail } from '@/lib/portal-prefs';
import { cancelWithinWindow } from '@/lib/sender-cancel';
import { requestRecallFor, requestRefundFor } from '@/lib/receipt-cores';
import { checkIpRateLimit } from '@/lib/ip-rate-limit';
import { auditSubjectId } from '@/lib/customer-ref';
import { PORTAL_AUTH_ACTOR } from '@/lib/portal-auth-audit';
import { encryptField } from '@/lib/field-crypto';
import { outboxSealedCtx } from '@/lib/crypto-context';
import { pokeWorker } from '@/lib/outbox';
import { getRedis } from '@/lib/redis';
import { logWarn } from '@/lib/log';
import { t, type MessageKey } from '@/lib/i18n';
import { transferRewardOrNull } from '@/lib/rewards/read';

/**
 * The customer portal's transfer-detail actions (UI redesign M2-7, Tasks 7.3 and 7.4). Each is a
 * PUBLIC POST endpoint (Next's Origin-vs-Host check applies to server actions):
 *  1. requirePortalSite() FIRST (the dark-by-default host gate; the scanner pins it);
 *  2. the session: requireFreshPortalAuth (the 15-minute step-up) for cancel, refund and recall,
 *     BEFORE any read, so the redirect is the same for every id (no oracle); requirePortalCustomer
 *     for the receipt email;
 *  3. ownership: getPortalTransfer(host partner, session phone, id), else one "not found" copy
 *     (404-never-403). The bound `transferId` arrives from the client and is only ever re-scoped;
 *  4. runOnce on the server-minted request key: one effect per submit (the replay value is a code);
 *  5. the SHARED cores: cancel = the locked sender-cancel service (its own transaction, refund
 *     effect, confirmation and audit); refund/recall = the legacy receipt cores.
 * Results are fixed copy keys. No redirect() inside a try (it throws).
 */

export type PortalTransferActionState = { notice?: MessageKey; error?: MessageKey } | null;

const NOT_FOUND: PortalTransferActionState = { error: 'portal.transfer.not_found' };

const field = (fd: FormData, name: string) => String(fd.get(name) ?? '');
const idOf = (v: unknown) => (typeof v === 'string' && PORTAL_TRANSFER_ID_RE.test(v) ? v : '');

/** runOnce's refusals and any internal error → fixed copy (the error itself is logged, scrubbed). */
function failed(err: unknown, label: string): PortalTransferActionState {
  if (err instanceof BadRequestKeyError) return { error: 'portal.action.expired' };
  if (err instanceof RequestInFlightError) return { error: 'portal.action.in_flight' };
  logWarn(label, err);
  return { error: 'portal.action.failed' };
}

async function once<T extends ReplayValue>(scope: string, ctx: PortalCustomerContext, fd: FormData, fn: () => Promise<T>): Promise<T> {
  const owner = portalOwner(ctx);
  return (await runOnce(getRedis(), scope, owner.partnerId, owner.phone, field(fd, 'requestKey'), fn)).value;
}

function refresh(id: string) {
  revalidatePath(`/portal/transfers/${id}`);
  revalidatePath('/portal/transfers');
  revalidatePath('/portal');
}

const CANCEL_COPY: Record<string, PortalTransferActionState> = {
  cancelled: { notice: 'portal.cancel.cancelled' },
  escalated: { notice: 'portal.cancel.requested' },
  escalated_held: { notice: 'portal.cancel.received' },
  window_passed: { error: 'portal.cancel.closed' },
  ineligible: { error: 'portal.cancel.ineligible' },
  not_found: NOT_FOUND,
};

/** Cancel within the Reg E 30-minute window (12 CFR 1005.34): the locked sender-cancel service decides. */
export async function cancelTransferPortalAction(
  transferId: string,
  _prev: PortalTransferActionState,
  formData: FormData,
): Promise<PortalTransferActionState> {
  await requirePortalSite();
  const id = idOf(transferId);
  const ctx = await requireFreshPortalAuth(`/portal/transfers/${id}`);
  const owner = portalOwner(ctx);
  const transfer = await getPortalTransfer(owner, id);
  if (!transfer) return NOT_FOUND;
  let code: string;
  try {
    ({ code } = await once('portal-cancel', ctx, formData, async () => {
      const res = await cancelWithinWindow(getDb(), owner.partnerId, transfer.id, { via: 'receipt' });
      return { code: res.kind === 'escalated' ? (res.held ? 'escalated_held' : 'escalated') : res.kind };
    }));
  } catch (err) {
    return failed(err, 'portal.transfer.cancel');
  }
  refresh(transfer.id);
  return CANCEL_COPY[code] ?? { error: 'portal.action.failed' };
}

/** Flag a paid, not-delivered transfer for an ops-reviewed refund (moves no money). */
export async function requestRefundPortalAction(
  transferId: string,
  _prev: PortalTransferActionState,
  formData: FormData,
): Promise<PortalTransferActionState> {
  await requirePortalSite();
  const id = idOf(transferId);
  const ctx = await requireFreshPortalAuth(`/portal/transfers/${id}`);
  const owner = portalOwner(ctx);
  const transfer = await getPortalTransfer(owner, id);
  if (!transfer) return NOT_FOUND;
  let code: string;
  try {
    // The portal's step-up already ran (requireFreshPortalAuth), so the core's gate is 'ok'.
    ({ code } = await once('portal-refund', ctx, formData, async () => ({
      code: (await requestRefundFor({ partnerId: owner.partnerId, senderPhone: owner.phone }, transfer.id, async () => 'ok')).kind,
    })));
  } catch (err) {
    return failed(err, 'portal.transfer.refund');
  }
  refresh(transfer.id);
  if (code === 'requested') return { notice: 'portal.refund.requested' };
  if (code === 'ineligible') return { error: 'portal.refund.ineligible' };
  return { error: 'portal.action.failed' };
}

const RECALL_COPY: Record<string, PortalTransferActionState> = {
  opened: { notice: 'portal.recall.opened' },
  bad_reason: { error: 'portal.recall.bad_reason' },
  support_off: { error: 'portal.recall.support_off' },
  ineligible: { error: 'portal.recall.ineligible' },
  cap: { error: 'portal.recall.cap' },
};

/** Report a problem with a delivered transfer inside the 24h window: opens a ticket (moves no money). */
export async function requestRecallPortalAction(
  transferId: string,
  _prev: PortalTransferActionState,
  formData: FormData,
): Promise<PortalTransferActionState> {
  await requirePortalSite();
  const id = idOf(transferId);
  const ctx = await requireFreshPortalAuth(`/portal/transfers/${id}`);
  const owner = portalOwner(ctx);
  const transfer = await getPortalTransfer(owner, id);
  if (!transfer) return NOT_FOUND;
  const reason = field(formData, 'reason').trim();
  let code: string;
  try {
    ({ code } = await once('portal-recall', ctx, formData, async () => ({
      code: (
        await requestRecallFor({ partnerId: owner.partnerId, senderPhone: owner.phone }, transfer.id, { reason }, async () => 'ok', {
          tenantScopedCap: true,
        })
      ).kind,
    })));
  } catch (err) {
    return failed(err, 'portal.transfer.recall');
  }
  refresh(transfer.id);
  return RECALL_COPY[code] ?? { error: 'portal.action.failed' };
}

/** Per customer: 10 receipt emails per hour. */
const PORTAL_RECEIPT_LIMIT = { scope: 'portal-receipt', limit: 10, windowSec: 3600 } as const;

/**
 * "Email me a receipt" to the customer's VERIFIED address (Task 7.3). The body holds the masked
 * destination only and is SEALED in the outbox payload (opened by the worker at send time); the
 * address sits in the payload until the 7-day scrub (the known exposure the plan logs). Enqueued
 * with its audit row in one transaction, deduped per request key.
 */
export async function emailReceiptAction(
  transferId: string,
  _prev: PortalTransferActionState,
  formData: FormData,
): Promise<PortalTransferActionState> {
  await requirePortalSite();
  const ctx = await requirePortalCustomer();
  const owner = portalOwner(ctx);
  const transfer = await getPortalTransfer(owner, idOf(transferId));
  if (!transfer) return NOT_FOUND;
  const db = getDb();
  let code: string;
  try {
    const email = await verifiedReceiptEmail(db, { partnerId: owner.partnerId, senderPhone: owner.phone, email: ctx.customer.email });
    if (!email) return { error: 'portal.receipt.verify_email_first' };
    const requestKey = field(formData, 'requestKey');
    ({ code } = await once('portal-receipt', ctx, formData, async () => {
      const subject = auditSubjectId(owner.partnerId, owner.phone);
      const rl = await checkIpRateLimit(getRedis(), PORTAL_RECEIPT_LIMIT.scope, subject, {
        limit: PORTAL_RECEIPT_LIMIT.limit,
        windowSec: PORTAL_RECEIPT_LIMIT.windowSec,
      });
      if (!rl.allowed) return { code: 'rate_limited' };
      const body = renderReceiptText(receiptView(transfer, await transferRewardOrNull(db, owner.partnerId, transfer.id)), ctx.site.brand);
      await db.transaction(async (tx) => {
        await createOutboxRepo(tx).enqueue(
          'email.send',
          {
            to: [email],
            subject: t('portal.receipt.subject', { brand: ctx.site.brand }),
            text: '{{receipt_body}}',
            sealed: { receipt_body: encryptField(body, undefined, outboxSealedCtx('receipt_body')) },
          },
          { dedupeKey: `rcpt:${transfer.id}:${requestKey}` },
        );
        await createAuditRepo(tx).record({
          partnerId: owner.partnerId,
          actor: PORTAL_AUTH_ACTOR,
          actorType: 'system',
          action: 'customer.receipt.email',
          subjectId: subject,
          meta: { transferId: transfer.id },
        });
      });
      pokeWorker();
      return { code: 'sent' };
    }));
  } catch (err) {
    return failed(err, 'portal.transfer.receipt_email');
  }
  if (code === 'sent') return { notice: 'portal.receipt.sent' };
  if (code === 'rate_limited') return { error: 'portal.receipt.rate_limited' };
  return { error: 'portal.action.failed' };
}
