import { isCleanName, NAME_MAX } from './untrusted-text';
import { accountLast4, isMaskedDestination, validatePayoutFields } from './payout-format';
import { screenTransfer } from './compliance';
import { warmSanctionsList } from './providers/sanctions-provider';
import { GLOBAL_DEFAULTS, type ResolvedCorridorRules } from './compliance-config';
import type { ScreeningEvidence } from './sanctions/evidence';

// payees — Batch B2. A payee is a company in India a partner works with (a
// school, a supplier) that its customers pay through payment links. The partner
// adds it; it stays 'pending' until a SmartRemit platform admin approves it.
// Bank details are sealed by payee-repo and NEVER edited: a change is a new payee.
//
// Sanctions screening is not a switch: it runs on BOTH names (the company's legal
// name and the account holder) when the partner adds the payee, when an admin
// approves it, and at every payment (payment-link-finalize.ts).

export type PayeeStatus = 'pending' | 'approved' | 'rejected' | 'suspended';
export type PayeeDecision = 'approve' | 'reject' | 'suspend';

export const PAYEE_STATUS_LABELS: Readonly<Record<PayeeStatus, string>> = {
  pending: 'Waiting for SmartRemit approval',
  approved: 'Approved',
  rejected: 'Rejected',
  suspended: 'Suspended',
};

export interface PayeeInput {
  legalName: string;
  accountHolder: string;
  /** The composed IN destination: "<IFSC> <account>" (payout-format.ts). */
  payoutDestination: string;
  last4: string;
}

export type PayeeRawField = 'legalName' | 'accountHolder' | 'ifsc' | 'accountNumber' | 'accountNumberConfirm';

export type PayeeParse =
  | { ok: true; value: PayeeInput }
  | { ok: false; errors: Partial<Record<PayeeRawField, string>> };

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export function parsePayeeInput(raw: Partial<Record<PayeeRawField, unknown>>): PayeeParse {
  const errors: Partial<Record<PayeeRawField, string>> = {};
  const legalName = str(raw.legalName);
  const accountHolder = str(raw.accountHolder);
  if (!isCleanName(legalName, NAME_MAX)) {
    errors.legalName = legalName === '' ? 'Enter the company legal name.' : `Enter a plain name of at most ${NAME_MAX} characters.`;
  }
  if (!isCleanName(accountHolder, NAME_MAX)) {
    errors.accountHolder =
      accountHolder === '' ? 'Enter the account holder name.' : `Enter a plain name of at most ${NAME_MAX} characters.`;
  }
  const accountNumber = str(raw.accountNumber);
  const v = validatePayoutFields('IN', { accountNumber, ifsc: str(raw.ifsc).toUpperCase() });
  if (!v.ok) {
    if (v.errors.accountNumber) errors.accountNumber = v.errors.accountNumber;
    if (v.errors.ifsc) errors.ifsc = v.errors.ifsc;
  } else if (isMaskedDestination(v.payoutDestination)) {
    errors.accountNumber = 'Enter the full account number.';
  }
  if (!errors.accountNumber && accountNumber.replace(/\D/g, '') !== str(raw.accountNumberConfirm).replace(/\D/g, '')) {
    errors.accountNumberConfirm = 'The account numbers do not match.';
  }
  if (Object.keys(errors).length > 0 || !v.ok) return { ok: false, errors };
  return {
    ok: true,
    value: { legalName, accountHolder, payoutDestination: v.payoutDestination, last4: accountLast4(v.payoutDestination) },
  };
}

export type PayeeScreenVerdict = 'clear' | 'review' | 'match';

/**
 * Screen BOTH payee names through the same seam as every transfer (screenTransfer:
 * the legal name as the recipient, the account holder in the second slot). A
 * list that cannot load is 'review', never 'clear'. The evidence carries input
 * hashes only, never a name; the caller records it as a sanctions.screen row.
 */
export async function screenPayee(
  names: { legalName: string; accountHolder: string },
  rules: ResolvedCorridorRules = GLOBAL_DEFAULTS,
): Promise<{ verdict: PayeeScreenVerdict; evidence?: ScreeningEvidence }> {
  await warmSanctionsList();
  const r = await screenTransfer({
    amountUsd: 0,
    recipientName: names.legalName,
    senderName: names.accountHolder,
    transfersToday: 0,
    sourceCountry: 'US',
    rules,
  });
  const decision = r.evidence?.decision;
  const verdict: PayeeScreenVerdict =
    r.status === 'blocked' ? 'match' : decision === 'possible_match' || decision === 'list_unavailable' ? 'review' : 'clear';
  return { verdict, evidence: r.evidence };
}

/** The status an admin decision moves a payee to, or null when it does not apply. Rejected is final. */
export function nextPayeeStatus(current: PayeeStatus, decision: PayeeDecision): PayeeStatus | null {
  switch (decision) {
    case 'approve':
      return current === 'pending' || current === 'suspended' ? 'approved' : null;
    case 'reject':
      return current === 'pending' || current === 'suspended' ? 'rejected' : null;
    case 'suspend':
      return current === 'approved' ? 'suspended' : null;
  }
}
