'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireCustomer } from '@/lib/customer-auth';
import { getCustomerAuthStore } from '@/lib/customer-auth-store';
import { getCustomerMfaStore, stepUp, STEP_UP_ERROR } from '@/lib/customer-mfa';
import { clientIpFrom } from '@/lib/ip-rate-limit';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { requestRecallFor } from '@/lib/receipt-cores';

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

export async function requestRecallAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const customer = await requireCustomer();
  const transferId = String(formData.get('transferId') ?? '').trim();
  const reason = String(formData.get('reason') ?? '').trim();

  // Bounce back to the receipt on every refusal — the page reads ?error=<code>.
  // transferId is a path segment and comes straight off the form, so encode it
  // (a forged id with ?/#/& would otherwise corrupt the query the page reads).
  const back = (code: string) =>
    redirect(`/account/receipt/${encodeURIComponent(transferId)}?error=${code}`);

  // The core (src/lib/receipt-cores.ts, UI redesign M2-7) runs the legacy order: the reason enum
  // FIRST (a forged reason fails with zero DB work), the admin support kill switch (hiding a CTA
  // never gates a POST endpoint), STRICT ownership 404-never-403, the server-side 24h eligibility
  // re-check, the Program-Fix 49D step-up, the 5-open-requests cap, the ticket (partnerId and
  // customerPhone from the SESSION; hostile form fields are ignored) and the out-of-band triage.
  const res = await requestRecallFor(customer, transferId, { reason }, async () =>
    stepUp(customer, String(formData.get('code') ?? ''), async () => clientIpFrom(await headers()), {
      mfa: getCustomerMfaStore(),
      auth: getCustomerAuthStore(),
    }),
  );
  switch (res.kind) {
    case 'bad_reason':
      return back('reason');
    case 'support_off':
      // Off ⇒ bounce to the support landing (which renders the "handled in WhatsApp" note).
      return redirect('/account/support');
    case 'ineligible':
      return back('ineligible');
    case 'step_up':
      return back(STEP_UP_ERROR[res.failure]);
    case 'cap':
      return back('cap');
    case 'opened':
      return redirect(`/account/support/${res.ticketId}`);
  }
}
