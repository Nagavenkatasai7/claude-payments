import type { Customer, KycReviewState } from './types';
import type { KycProvider } from './providers/kyc-provider';
import type { CustomerStore } from './customer-store';

/**
 * verify-link — deterministic delivery of the KYC verification link.
 *
 * Background: the bot delivers the verify URL as APPENDED TEXT, and
 * `sanitizeReply` strips every model-emitted URL (anti-hallucination guard) and
 * only re-appends a link a tool minted THIS turn. So when the model answers a
 * "resend the verify link" request from chat history WITHOUT calling a tool, the
 * URL is stripped and the customer gets a 👉 with no link. These helpers give the
 * agent a CODE-LEVEL guarantee that does not depend on the model calling a tool.
 */

// Review states from which the existing Persona inquiry is NO LONGER reusable —
// the customer has reached a human-terminal verdict, so a fresh inquiry is right.
const TERMINAL_REVIEW_STATES: KycReviewState[] = ['approved', 'rejected'];

/**
 * Does this model reply look like a verification/identity hand-off that should
 * carry the verify link? True when the model tried to paste any URL (it intends
 * to share a link) OR the text talks about verification/identity/KYC. Pure.
 */
export function looksLikeVerifyHandoff(reply: string): boolean {
  if (/https?:\/\//i.test(reply)) return true; // model tried to paste a link
  return /\b(verif|identit|kyc)/i.test(reply); // verify / verification / identity / kyc
}

/**
 * The Persona inquiry id to REUSE for this customer's resend, or undefined when
 * a fresh inquiry should be minted. Reuse when an inquiry id exists and the
 * customer is neither hard-rejected nor at a human-terminal review state. Pure.
 */
export function reusableInquiryId(
  customer: Customer | null | undefined,
): string | undefined {
  if (!customer?.kycInquiryId) return undefined;
  if (customer.kycStatus === 'rejected') return undefined;
  if (customer.kycReviewState && TERMINAL_REVIEW_STATES.includes(customer.kycReviewState)) {
    return undefined;
  }
  return customer.kycInquiryId;
}

export interface IssueVerifyLinkDeps {
  phone: string;
  customer: Customer | null | undefined;
  kycProvider: KycProvider;
  customerStore: CustomerStore;
}

/**
 * Obtain the canonical, code-generated verify link for a customer who still
 * needs KYC. Reuses an existing non-terminal Persona inquiry when possible (so
 * repeated "resend" taps don't mint a new inquiry each time); otherwise creates
 * one and persists its id so the NEXT resend can reuse it. If reuse fails (e.g.
 * the inquiry is in a bad state), falls back to minting a fresh inquiry. Never
 * throws into the caller's turn — returns null on total failure so the agent
 * simply sends its normal reply without a link.
 */
export async function issueVerifyLink(deps: IssueVerifyLinkDeps): Promise<string | null> {
  const reuseId = reusableInquiryId(deps.customer);
  // Try reuse first (if any), then fall back to a brand-new inquiry.
  const attempts: (string | undefined)[] = reuseId ? [reuseId, undefined] : [undefined];
  for (const existingInquiryId of attempts) {
    try {
      const start = await deps.kycProvider.startVerification({
        customerId: deps.phone,
        senderPhone: deps.phone,
        existingInquiryId,
      });
      if (!existingInquiryId) {
        // Newly minted — persist the inquiry id so a later resend reuses it.
        await deps.customerStore.recordKycInquiry(deps.phone, start.providerRef);
      }
      return start.url;
    } catch (err) {
      console.error(
        `issueVerifyLink (${existingInquiryId ? 'reuse' : 'new'}) failed:`,
        err,
      );
    }
  }
  return null;
}
