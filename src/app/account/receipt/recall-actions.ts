'use server';

import { redirect } from 'next/navigation';
import { getDb } from '@/db/client';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { requireCustomer } from '@/lib/customer-auth';
import { newTransferId } from '@/lib/id';
import { getPartnerStore } from '@/lib/partner-store';
import { getStore } from '@/lib/store';
import { isRecallEligible } from '@/lib/refund-policy';
import type { Customer, Partner } from '@/lib/types';

/**
 * Customer-facing "Report a problem with this transfer" server action — opens a
 * recall/dispute case once money is DELIVERED (account portal receipt page).
 *
 * This is the web-portal twin of the bot's recall affordance: a delivered
 * transfer inside the 24h recall window (RECALL_WINDOW_MS, refund-policy.ts) may
 * open a customer SUPPORT TICKET linked to the transfer. It NEVER moves money —
 * recovery after delivery is never guaranteed; a human works the case.
 *
 * Server actions are PUBLIC POST endpoints, so this trusts NOTHING from the page
 * render and re-checks everything from scratch:
 *  - requireCustomer() resolves the session (redirects to login if absent);
 *  - the transfer is RE-LOADED here, scoped to the session phone, never carried
 *    from the page;
 *  - OWNERSHIP is enforced 404-never-403 (a transfer whose phone ≠ the session
 *    phone is indistinguishable from one that doesn't exist);
 *  - eligibility is RE-CHECKED server-side via isRecallEligible (the page gate is
 *    never authoritative — a delivered transfer whose window has elapsed is
 *    refused even if the client posts anyway);
 *  - the admin support kill switch is honored exactly as createTicketAction does;
 *  - the per-customer open-ticket cap is respected.
 *
 * Failure UX is redirect-with-code: the receipt page is a plain server component
 * (no client islands), so refusals bounce back to it with ?error=<code>.
 */

const MAX_OPEN_TICKETS = 5;
/** Statuses that count against the per-customer open-ticket cap. */
const OPEN_STATUSES = new Set<string>(['open', 'pending', 'waiting_admin']);

/** The recall reasons the receipt form offers (mirrors the bot tool's enum). */
const RECALL_REASONS = new Set<string>([
  'wrong_recipient',
  'wrong_amount',
  'not_received',
  'unauthorized',
  'other',
]);

/** Human-readable description for the ticket subject/body. */
const REASON_LABEL: Record<string, string> = {
  wrong_recipient: 'Sent to the wrong recipient',
  wrong_amount: 'Wrong amount sent',
  not_received: 'Recipient did not receive the money',
  unauthorized: 'I did not authorize this transfer',
  other: 'Something else is wrong',
};

/** The customer's partner row (the admin-controlled support kill switch lives on it). */
async function customerPartner(customer: Customer): Promise<Partner> {
  return (
    (await getPartnerStore().getPartner(customer.partnerId)) ??
    (await getPartnerStore().ensureDefaultPartner())
  );
}

/** enableSupportPortal defaults to TRUE when supportConfig is absent. */
function portalDisabled(partner: Partner): boolean {
  return partner.supportConfig?.enableSupportPortal === false;
}

export async function requestRecallAction(formData: FormData): Promise<void> {
  const customer = await requireCustomer();
  const transferId = String(formData.get('transferId') ?? '').trim();
  const reason = String(formData.get('reason') ?? '').trim();

  // Bounce back to the receipt on every refusal — the page reads ?error=<code>.
  // transferId is a path segment and comes straight off the form, so encode it
  // (a forged id with ?/#/& would otherwise corrupt the query the page reads).
  const back = (code: string) =>
    redirect(`/account/receipt/${encodeURIComponent(transferId)}?error=${code}`);

  // Validate the reason against the offered enum FIRST — a forged or empty reason
  // is a bad request and fails with zero DB work (no partner/transfer round-trip).
  if (!RECALL_REASONS.has(reason)) back('reason');

  // Admin kill switch — the receipt section hides itself when support is off,
  // but hiding a CTA never gates a POST endpoint. Off ⇒ bounce to the support
  // landing (which renders the "handled in WhatsApp" note); nothing is created.
  if (portalDisabled(await customerPartner(customer))) redirect('/account/support');

  const transfer = await getStore().getTransfer(transferId);
  // STRICT ownership, 404-never-403: another customer's transfer — or a missing
  // one — is refused identically. We don't leak which.
  if (!transfer || transfer.phone !== customer.senderPhone) back('ineligible');

  // Server-side eligibility re-check — NEVER trust the client. Only a delivered
  // transfer still inside the 24h recall window qualifies.
  if (!isRecallEligible(transfer!, Date.now())) back('ineligible');

  const repo = createTicketRepo(getDb());

  // Polite cap: at most 5 concurrently-open requests per customer. Resolved and
  // closed tickets don't count. (Mirrors createTicketAction.)
  const mine = await repo.listByCustomer(customer.senderPhone);
  if (mine.filter((t) => OPEN_STATUSES.has(t.status)).length >= MAX_OPEN_TICKETS) {
    back('cap');
  }

  const reasonLabel = REASON_LABEL[reason] ?? reason;

  // partnerId + customerPhone come from the SESSION — hostile form fields with
  // the same names are ignored. transferId is re-validated above (ownership +
  // eligibility), so linking it here is safe.
  const ticket = await repo.createTicket({
    id: `tk_${newTransferId()}`,
    partnerId: customer.partnerId,
    kind: 'customer',
    customerPhone: customer.senderPhone,
    transferId: transfer!.id,
    subject: `Recall request: ${reason}`,
    body:
      `Recall/dispute opened from the receipt page for transfer ${transfer!.id}.\n` +
      `Reason: ${reasonLabel} (${reason}).\n` +
      `The customer reports a problem with a delivered transfer within the 24h recall window. ` +
      `Recovery is not guaranteed — please review and follow up.`,
    category: 'refund',
  });

  redirect(`/account/support/${ticket.id}`);
}
