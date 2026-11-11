// Fix pack 6 (R46, P3) — the E-SIGN consent wording for the pay page and the
// portal's withdrawal card (15 U.S.C. 7001(c): consent to receive the transfer
// disclosures, receipts and notices electronically).
//
// DRAFT for counsel (R19); nothing here claims sign-off. Bump
// ESIGN_CONSENT_VERSION on ANY wording change: the pay page posts it and the
// audit row records it, so the version identifies the exact text the customer
// saw. tests/esign-consent-version-pin.test.ts pins every export below except
// the version (the withdrawal copy the portal card shows included).
//
// Pure and client-safe: no imports. The withdrawal route must be true on EVERY
// tenant: the default tenant and partners without a portal have no Profile, so
// the text never says "Profile" alone.

export const ESIGN_CONSENT_VERSION = 'esign-2026-11.1-draft' as const;

export const ESIGN_CONSENT_TITLE = 'Electronic records';

/** Shown above the consent tick box, one idea per line. */
export const ESIGN_CONSENT_TEXT: readonly string[] = Object.freeze([
  'We give you the disclosures, receipts and notices for this transfer and your later transfers electronically.',
  'You see them on the pay page and get them in WhatsApp.',
  'To open them you need a web browser and WhatsApp on a device that can open links.',
  'To withdraw, use Profile in your account if your provider offers one, or contact the provider named on your receipt. Your next pay-page payment then asks you again.',
  'For paper copies, contact the provider named on your receipt.',
  'This consent lasts until you withdraw it.',
]);

/** The tick box label. */
export const ESIGN_CONSENT_LABEL =
  'I agree to get the disclosures, receipts and notices for my transfers electronically.';

/** What withdrawing does; the portal's withdrawal card shows these lines verbatim (P9). */
export const ESIGN_WITHDRAW_COPY: readonly string[] = Object.freeze([
  'Withdrawing stops electronic delivery of these records for your future pay-page payments.',
  'Your next pay-page payment asks for your consent again.',
  'It does not cancel a transfer you have already paid.',
  'For paper copies, contact the provider named on your receipt.',
]);
