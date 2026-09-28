'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireCustomer } from '@/lib/customer-auth';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { getDb } from '@/db/client';
import { logWarn } from '@/lib/log';
import { getCustomerAuthStore } from '@/lib/customer-auth-store';
import { getCustomerMfaStore, stepUp, STEP_UP_ERROR } from '@/lib/customer-mfa';
import { clientIpFrom } from '@/lib/ip-rate-limit';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { cancelWithinWindow } from '@/lib/sender-cancel';
import { requestRefundFor } from '@/lib/receipt-cores';

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
  await refuseOnSiteHost();
  const customer = await requireCustomer();
  const transferId = String(formData.get('transferId') ?? '');

  // The core (src/lib/receipt-cores.ts, UI redesign M2-7) runs the checks in the same order:
  // ownership 404-never-403, eligibility (paid + refundStatus none, exactly the request_refund
  // tool's rules), then the step-up, then the guarded none→requested flip. Every refusal is the
  // same generic throw — never leak whether the transfer exists, belongs to someone else, or is
  // simply ineligible.
  //
  // Program-Fix 49D (portal-03): the step-up. A customer with two-step verification on proves a
  // fresh authenticator code (reserved on the login attempt buckets); checked AFTER eligibility,
  // so an ineligible request keeps its generic refusal; a step-up refusal bounces back to the
  // receipt with a fixed code (redirect() throws, so it runs outside any try).
  const res = await requestRefundFor(customer, transferId, async () =>
    stepUp(customer, String(formData.get('code') ?? ''), async () => clientIpFrom(await headers()), {
      mfa: getCustomerMfaStore(),
      auth: getCustomerAuthStore(),
    }),
  );
  if (res.kind === 'ineligible') throw new Error('This transfer is not eligible for a refund request.');
  if (res.kind === 'step_up') redirect(`/account/receipt/${encodeURIComponent(res.transferId)}?error=${STEP_UP_ERROR[res.failure]}`);

  // Refresh the receipt + account home so the new "Refund requested" label shows.
  revalidatePath(`/account/receipt/${res.transferId}`);
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
  await refuseOnSiteHost();
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

  let code: 'cancelled' | 'requested' | 'received' | 'closed' | 'ineligible';
  try {
    const res = await cancelWithinWindow(getDb(), customer.partnerId, id, { via: 'receipt' });
    if (res.kind === 'not_found') refuse();
    code =
      res.kind === 'cancelled' ? 'cancelled'
      : res.kind === 'escalated' ? (res.held ? 'received' : 'requested')
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
