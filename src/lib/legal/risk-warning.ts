// Fix pack 6 (R48, P18) — the ONE fixed warning a customer sees when a risk
// signal fires on a send, the tick box label beside it on the draft pay page
// and the pay refusal copy when the box was not ticked.
//
// DRAFT for the partner's MLRO (R48, Q-R48.2): one fixed text for every
// partner; bump RISK_WARNING_VERSION on ANY wording change and re-pin
// tests/risk-warning-version-pin.test.ts. The mint records the version in the
// `risk.signals` audit row, so it identifies the exact text the customer saw.
//
// Pure and client-safe: no imports (the pay form renders it, T28). The text
// never says that anything is checked, reviewed or held (P0 rule 11).

export const RISK_WARNING_VERSION = 'rw-2026-11.1-draft' as const;

export const RISK_WARNING_TEXT =
  'Before you pay: scammers often push people to send money quickly, to keep it secret, or to pay someone they have never met in person. If someone told you to send this money, or you are not sure, stop and do not pay.';

export const RISK_ACK_LABEL = 'I have read this warning.';

export const PAY_RISK_ACK_REQUIRED_COPY = 'Tick the box to confirm you have read the warning, then pay.';
