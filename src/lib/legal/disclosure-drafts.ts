// Program-Fix 15 PR B — the Reg E remittance DISCLOSURE copy for the pay page
// (12 CFR 1005.31(b)(1), pre-payment) and the receipt (1005.31(b)(2)), as a
// structured DRAFT for counsel review. Sibling of ./drafts.ts; the same rules
// apply (read that file's header):
//  - Nothing here claims sign-off (tests/remittance-disclosure.test.ts scans it).
//  - The licensed partner is the provider of record (C3). Its name, licences,
//    contact and regulator come ONLY from the partner's own configuration
//    (resolvePartnerDisclosure); nothing is invented here.
//  - The demo tenant shows DEMO_NO_PARTNER_NOTE and never names SmartRemit as
//    the transmitter.
//  - Bump DISCLOSURE_DRAFT_VERSION on ANY wording change: the pay page posts it
//    with the customer's acknowledgement (audit `remittance.disclosure_ack`), so
//    the version identifies the exact text the customer saw.

export const DISCLOSURE_DRAFT_VERSION = 'disclosure-draft-2026-09-23' as const;

/** Shown above every disclosure block. */
export const DISCLOSURE_DRAFT_BADGE = 'Draft disclosure — for counsel review';

export const DISCLOSURE_LABELS = {
  heading: 'Before you pay',
  receiptHeading: 'Transfer disclosure',
  transferAmount: 'Transfer amount',
  transferFees: 'Transfer fees',
  total: 'Total',
  exchangeRate: 'Exchange rate',
  totalToRecipient: 'Total to recipient',
  dateAvailable: 'Date available',
  provider: 'Provider',
  licences: 'Licences',
  providerPhone: 'Phone',
  providerWebsite: 'Website',
  stateRegulator: 'State regulator',
  cfpb: 'Consumer Financial Protection Bureau',
} as const;

/** §1005.31(b)(1)(vi)-style statement: fees and taxes the provider does not charge. */
export const THIRD_PARTY_FEE_STATEMENT =
  'Your recipient may receive less because of fees charged by the recipient’s bank and foreign taxes.';

/** §1005.32 estimate wording. `n` business days after payment. */
export function dateAvailableEstimate(n: number): string {
  return n === 0
    ? 'Same business day as payment (estimate)'
    : `Within ${n} business day${n === 1 ? '' : 's'} of payment (estimate)`;
}

/** Receipt: a computed calendar date, still an estimate. */
export function dateAvailableOnOrAbout(formattedDate: string): string {
  return `On or about ${formattedDate} (estimate)`;
}

export const DATE_AVAILABLE_DELIVERED_PREFIX = 'Delivered';

/** Shown instead of a provider name when a real partner has not yet supplied its licensing details. */
export const PARTNER_DETAILS_PENDING = 'Partner licensing details pending (draft).';

/** Short rights summary; the full text is REMITTANCE_RIGHTS_DRAFT on /legal#remittance-rights. */
export const RIGHTS_SUMMARY =
  'You have a right to dispute errors in your transaction, and you can cancel for a full refund within 30 minutes of payment unless the funds have already been picked up or deposited. To cancel or report a problem, contact the licensed provider of your transfer, or reply in the WhatsApp chat with your transfer ID.';

/** Receipt: the cancellation window line, shown while it is open. `until` is a formatted time. */
export function cancelWindowLine(until: string): string {
  return `To cancel, contact the provider before ${until} (30 minutes after payment).`;
}

export const CFPB_CONTACT = {
  website: 'https://www.consumerfinance.gov/complaint',
  websiteLabel: 'consumerfinance.gov/complaint',
  phone: '855-411-2372',
} as const;

export const DISCLOSURE_LINKS = [
  { href: '/legal#remittance-rights', label: 'Your cancellation and error rights' },
  { href: '/legal#licensing', label: 'Licensing' },
  { href: '/terms', label: 'Terms' },
  { href: '/privacy', label: 'Privacy' },
] as const;

/** The pay-page acknowledgement checkbox label. */
export const ACKNOWLEDGEMENT_LABEL = 'I have read this disclosure.';
