import { env } from './env';

/**
 * The ONE builder of the secure pay-page URL for a draft or a transfer id
 * (UI redesign M2-4): exactly the expression the bot used inline,
 * `${env.appBaseUrl}/pay/${id}`. The bot's approve card, generate_payment_link
 * and the customer portal (send-seam.ts portalPayUrl) all call it, so moving
 * /pay onto a partner subdomain (M1 H2) is a change to this one function.
 * A leaf module: tools.ts imports it without a cycle through send-seam.ts.
 */
export function payUrlFor(draftOrTransferId: string): string {
  return `${env.appBaseUrl}/pay/${draftOrTransferId}`;
}

/** Batch B2: the customer's page for one payment link (the partner copies or downloads it). */
export function paymentLinkUrl(token: string): string {
  return `${env.appBaseUrl}/pay/l/${token}`;
}
