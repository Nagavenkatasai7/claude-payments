'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireCustomer } from '@/lib/customer-auth';
import { getStore } from '@/lib/store';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { getDb } from '@/db/client';
import { logWarn } from '@/lib/log';
import { getCustomerAuthStore } from '@/lib/customer-auth-store';
import { getCustomerMfaStore, stepUp, STEP_UP_ERROR } from '@/lib/customer-mfa';
import { clientIpFrom } from '@/lib/ip-rate-limit';
import { cancelWithinWindow } from '@/lib/sender-cancel';

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
  if (!transfer || transfer.phone !== customer.senderPhone || transfer.partnerId !== customer.partnerId) refuse();

  const refundStatus = transfer!.refundStatus ?? 'none'; // lazy-fill: absent ⇒ 'none'

  // Eligibility — exactly the request_refund tool's rules: the one eligible
  // state is `paid` + refundStatus 'none' (NOT delivered, no refund in flight).
  if (refundStatus !== 'none') refuse();
  if (transfer!.status !== 'paid') refuse();

  // Program-Fix 49D (portal-03): step-up. A customer with two-step
  // verification on proves a fresh authenticator code (reserved on the login
  // attempt buckets); without it nothing changes unless CUSTOMER_MFA_REQUIRED
  // is on. Checked AFTER eligibility, so an ineligible request keeps its
  // generic refusal; a step-up refusal bounces back to the receipt with a
  // fixed code (outside the try below: redirect() throws).
  const gate = await stepUp(customer, String(formData.get('code') ?? ''), async () => clientIpFrom(await headers()), {
    mfa: getCustomerMfaStore(),
    auth: getCustomerAuthStore(),
  });
  if (gate !== 'ok') redirect(`/account/receipt/${encodeURIComponent(transfer!.id)}?error=${STEP_UP_ERROR[gate]}`);

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

/**
 * Program-Fix 15 PR C: the receipt's "Cancel this transfer" (12 CFR 1005.34,
 * within 30 minutes of payment). A PUBLIC POST endpoint like every server
 * action, so it self-gates and trusts nothing from the page render:
 *  - requireCustomer() resolves the session (redirects to login if absent);
 *  - the transfer is re-read TENANT-SCOPED (getOwnedTransfer) and must belong
 *    to the session phone — a stranger's, another tenant's or a missing id all
 *    get the same generic refusal (404-never-403);
 *  - the 49D step-up runs before anything moves (a cancel returns money);
 *  - the LOCKED sender-cancel service decides (sender-cancel.ts): it cancels
 *    and queues the full refund only while no rail instruction can have gone
 *    out, else escalates to staff. The window is the charge time by the
 *    database clock, never this page's clock.
 * Every outcome redirects back to the receipt with a FIXED `cancel=` code the
 * page maps to fixed copy.
 */
export async function cancelTransferAction(formData: FormData): Promise<void> {
  const customer = await requireCustomer();
  const transferId = String(formData.get('transferId') ?? '');
  const refuse = (): never => {
    throw new Error('This transfer is not eligible for cancellation.');
  };

  const owned = transferId ? await createTransferRepo(getDb()).getOwnedTransfer(customer.partnerId, transferId) : null;
  if (!owned || owned.phone !== customer.senderPhone) refuse();
  const id = owned!.id;
  const back = (code: string): never => redirect(`/account/receipt/${encodeURIComponent(id)}?${code}`);

  const gate = await stepUp(customer, String(formData.get('code') ?? ''), async () => clientIpFrom(await headers()), {
    mfa: getCustomerMfaStore(),
    auth: getCustomerAuthStore(),
  });
  if (gate !== 'ok') back(`error=${STEP_UP_ERROR[gate]}`);

  let code: 'cancelled' | 'requested' | 'closed' | 'ineligible';
  try {
    const res = await cancelWithinWindow(getDb(), customer.partnerId, id, { via: 'receipt' });
    if (res.kind === 'not_found') refuse();
    code =
      res.kind === 'cancelled' ? 'cancelled'
      : res.kind === 'escalated' ? 'requested'
      : res.kind === 'window_passed' ? 'closed'
      : 'ineligible';
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('This transfer is not eligible')) throw err;
    logWarn('transfer.sender-cancel', err);
    refuse();
  }

  revalidatePath(`/account/receipt/${id}`);
  revalidatePath('/account');
  revalidatePath('/account/history');
  back(`cancel=${code!}`);
}
