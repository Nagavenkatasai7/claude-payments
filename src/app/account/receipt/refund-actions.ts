'use server';

import { revalidatePath } from 'next/cache';
import { requireCustomer } from '@/lib/customer-auth';
import { getStore } from '@/lib/store';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { getDb } from '@/db/client';
import { logWarn } from '@/lib/log';

/**
 * Customer-facing "Request a refund" server action (account portal).
 *
 * Server actions are PUBLIC POST endpoints, so this self-gates and re-checks
 * everything from scratch — it trusts NOTHING from the page render:
 *  - requireCustomer() resolves the session (redirects to login if absent);
 *  - the transfer is RE-LOADED here, never carried from the page;
 *  - OWNERSHIP is enforced 404-never-403 (a transfer whose phone ≠ the session
 *    phone is indistinguishable from one that doesn't exist — generic throw);
 *  - eligibility mirrors the request_refund bot tool EXACTLY: only a transfer
 *    that is `paid`, NOT `delivered`, with refundStatus 'none' may transition;
 *  - the flip is the guarded transfer-repo none→requested transition, which is
 *    concurrency-safe (the loser gets null → treated as "not eligible").
 *
 * This NEVER moves money: it only flags the transfer for ops review (a human
 * approves before any money returns). No funding.refund enqueue here.
 */
export async function requestRefundAction(formData: FormData): Promise<void> {
  const customer = await requireCustomer();
  const transferId = String(formData.get('transferId') ?? '');

  // Generic failure for every refusal path — never leak whether the transfer
  // exists, belongs to someone else, or is simply ineligible.
  const refuse = () => {
    throw new Error('This transfer is not eligible for a refund request.');
  };

  const store = getStore();
  const transfer = await store.getTransfer(transferId);
  // STRICT ownership, 404-never-403 (mirrors request_refund): another customer's
  // transfer is indistinguishable from a missing one.
  if (!transfer || transfer.phone !== customer.senderPhone) refuse();

  const refundStatus = transfer!.refundStatus ?? 'none'; // lazy-fill: absent ⇒ 'none'

  // Eligibility — exactly the request_refund tool's rules: the one eligible
  // state is `paid` + refundStatus 'none' (NOT delivered, no refund in flight).
  if (refundStatus !== 'none') refuse();
  if (transfer!.status !== 'paid') refuse();

  try {
    const repo = createTransferRepo(getDb());
    // Guarded none→requested transition: a concurrent request makes the loser
    // get null — treated as "not eligible" (the request already exists).
    const updated = await repo.updateRefund(transfer!.id, { refundStatus: 'requested' });
    if (!updated) refuse();
  } catch (err) {
    // Re-throw our own generic refusal; everything else is internal (DB/crypto)
    // and must not leak — log scrubbed, surface the same generic message.
    if (err instanceof Error && err.message.startsWith('This transfer is not eligible')) {
      throw err;
    }
    logWarn('refund.request', err);
    refuse();
  }

  // Refresh the receipt + account home so the new "Refund requested" label shows.
  revalidatePath(`/account/receipt/${transfer!.id}`);
  revalidatePath('/account');
  revalidatePath('/account/history');
}
